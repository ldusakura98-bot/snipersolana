import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, LAUNCHLAB_PROGRAM, WSOL_MINT } from './config.js';
import { decideExit, ExitDecision, ExitRules } from './exits.js';
import { decodePoolState, PoolState } from './launchlab/layout.js';
import { log } from './logger.js';
import type { RiskManager } from './risk.js';
import type { TradeStats } from './stats.js';
import type { Trader } from './trader.js';
import type { Position } from './types.js';

export const formatAmount = (amount: bigint, decimals: number) => (Number(amount) / 10 ** decimals).toFixed(Math.min(decimals, 6));
const quoteLabel = (mint: string) => (mint === WSOL_MINT ? 'SOL' : `${mint.slice(0, 4)}…`);

// JSON no soporta bigint: se guardan como {"$big": "123"}.
const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const reviver = (_: string, v: any) => (v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v);

const rules: ExitRules = {
  stopLossPct: config.stopLossPct,
  takeProfitPct: config.takeProfitPct,
  trailingStopPct: config.trailingStopPct,
  trailingActivationPct: config.trailingActivationPct,
  partialTpPct: config.partialTpPct,
  partialTpSellPct: config.partialTpSellPct,
  maxHoldSeconds: config.maxHoldSeconds,
};

const DEV_SELL_LOG = /Instruction: Sell(ExactIn|ExactOut)/;

/**
 * Slippage para una venta: urgente (stop-loss, dev dump) o normal, y se duplica con cada
 * intento fallido. Mejor vender caro que quedarse atrapado en un token que se hunde.
 */
export function sellSlippageBps(failures: number, urgent: boolean): number {
  const base = urgent ? config.urgentSellSlippageBps : config.sellSlippageBps;
  return Math.min(base * 2 ** failures, Math.max(config.urgentSellSlippageBps, base), 9_900);
}

/**
 * Vigila las posiciones abiertas y vende según las reglas de `exits.ts`.
 * - Posiciones en la curva de LaunchLab: suscripción a la cuenta del pool → se evalúa en cuanto cambia el
 *   precio, y la venta usa ese mismo estado (sin leer el RPC).
 * - Suscripción a los logs del creador: si vende en LaunchLab (dev dump) → salida inmediata.
 * - Todas: sondeo cada PRICE_CHECK_INTERVAL_MS (respaldo, migraciones y tiempo máximo).
 */
export class PositionManager {
  readonly positions = new Map<string, Position>();
  private subs = new Map<string, number[]>();
  private logSubs = new Set<number>();
  private lastPool = new Map<string, PoolState>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly connection: Connection,
    private readonly trader: Trader,
    private readonly risk: RiskManager,
    private readonly stats: TradeStats,
  ) {}

  /** Recupera las posiciones guardadas (si el bot se reinicia no se pierden). */
  load() {
    try {
      const saved = JSON.parse(readFileSync(config.positionsFile, 'utf8'), reviver) as Position[];
      for (const p of saved) this.track(p);
      if (saved.length) log.info(`Recuperadas ${saved.length} posiciones de ${config.positionsFile}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`No se pudo leer ${config.positionsFile}: ${(e as Error).message}`);
    }
  }

  open(p: Position) {
    this.track(p);
    this.save();
  }

  start() {
    this.timer = setInterval(() => void this.poll(), config.priceCheckIntervalMs);
  }

  async stop() {
    clearInterval(this.timer);
    for (const mint of [...this.subs.keys()]) this.unsubscribe(mint);
  }

  private track(p: Position) {
    // El coste inicial se fija al abrir; las ventas parciales reducen costQuote pero no este.
    const tracked: Position = { ...p, initialCostQuote: p.initialCostQuote ?? p.costQuote, busy: false };
    this.positions.set(p.mint, tracked);
    if (tracked.venue !== 'launchlab' || !tracked.launchlab || this.subs.has(p.mint)) return;

    const ids: number[] = [];
    ids.push(
      this.connection.onAccountChange(
        new PublicKey(tracked.launchlab.poolState),
        (info) => {
          // Cada operación en el pool llega aquí: evaluamos al momento, sin esperar al sondeo.
          const pool = decodePoolState(info.data);
          this.lastPool.set(tracked.mint, pool);
          void this.evaluate(tracked, () => this.trader.valueFromPool(tracked, pool), pool);
        },
        { commitment: 'processed' },
      ),
    );

    if (config.exitOnDevSell) {
      const id = this.connection.onLogs(
        new PublicKey(tracked.launchlab.creator),
        ({ logs, err }) => {
          if (err || !logs.some((l) => l.includes(LAUNCHLAB_PROGRAM)) || !logs.some((l) => DEV_SELL_LOG.test(l))) return;
          if (tracked.forcedExit) return;
          tracked.forcedExit = 'el creador está vendiendo (dev dump)';
          log.warn(`${tracked.symbol ?? tracked.mint}: ${tracked.forcedExit} → salida inmediata`);
          const pool = this.lastPool.get(tracked.mint);
          void this.evaluate(tracked, () => (pool ? this.trader.valueFromPool(tracked, pool) : this.trader.value(tracked)), pool);
        },
        'processed',
      );
      ids.push(id);
      this.logSubs.add(id);
    }
    this.subs.set(p.mint, ids);
  }

  private unsubscribe(mint: string) {
    for (const id of this.subs.get(mint) ?? []) {
      const remove = this.logSubs.delete(id)
        ? this.connection.removeOnLogsListener(id)
        : this.connection.removeAccountChangeListener(id);
      void remove.catch(() => {});
    }
    this.subs.delete(mint);
    this.lastPool.delete(mint);
  }

  private untrack(mint: string) {
    this.positions.delete(mint);
    this.unsubscribe(mint);
  }

  private save() {
    const tmp = `${config.positionsFile}.tmp`;
    const data = [...this.positions.values()].map(({ busy, ...p }) => p);
    writeFileSync(tmp, JSON.stringify(data, replacer, 2));
    renameSync(tmp, config.positionsFile); // escritura atómica
  }

  private async poll() {
    await Promise.all([...this.positions.values()].map((p) => this.evaluate(p, () => this.trader.value(p))));
  }

  private async evaluate(p: Position, getValue: () => Promise<bigint | undefined>, pool?: PoolState) {
    if (p.busy || !this.positions.has(p.mint)) return;
    p.busy = true;
    const name = p.symbol ?? p.mint;
    let decision: ExitDecision | undefined;
    try {
      if (p.forcedExit) {
        decision = { reason: p.forcedExit, fraction: 1, urgent: true };
      } else {
        const value = await getValue();
        if (value === undefined) return;
        const peakBefore = p.peakValue;
        decision = decideExit(p, value, Date.now(), rules);
        if (!decision) {
          if (p.peakValue !== peakBefore) this.save();
          return;
        }
      }

      const failures = p.sellFailures ?? 0;
      const slippageBps = sellSlippageBps(failures, !!decision.urgent);
      log.trade(
        `VENDIENDO ${decision.fraction < 1 ? `${decision.fraction * 100}% de ` : ''}${name}: ${decision.reason}` +
          ` (slippage ${slippageBps / 100}%${failures ? `, reintento ${failures}` : ''})`,
      );
      const res = await this.trader.sell(p, decision.fraction, { slippageBps, pool, refreshBalance: failures > 0 });
      if (!res) {
        log.warn(`${name}: no hay ruta de venta, se reintentará`);
        p.sellFailures = failures + 1;
        return;
      }
      p.sellFailures = 0;
      await this.settle(p, decision, res);
    } catch (e) {
      // Lo más habitual: el precio se movió más que el slippage. El siguiente intento usa más.
      if (decision) p.sellFailures = (p.sellFailures ?? 0) + 1;
      log.error(`${name}: error gestionando posición: ${(e as Error).message}`);
    } finally {
      p.busy = false;
    }
  }

  /** Contabiliza una venta: PnL, estadísticas, límites de riesgo y recuperación del rent. */
  private async settle(p: Position, decision: ExitDecision, res: { signature: string; quoteOut: bigint; amount: bigint }) {
    const name = p.symbol ?? p.mint;
    const full = decision.fraction >= 1;
    // Coste proporcional a lo vendido: el PnL del resto sigue midiéndose sobre su parte del coste.
    const soldCost = full ? p.costQuote : (p.costQuote * res.amount) / p.tokenAmount;
    const pnl = res.quoteOut - soldCost;
    const q = quoteLabel(p.quoteMint);
    p.proceedsQuote = (p.proceedsQuote ?? 0n) + res.quoteOut;

    if (full) {
      this.untrack(p.mint);
      const initial = p.initialCostQuote ?? soldCost;
      const pnlTotal = p.proceedsQuote - initial;
      const totalLamports = await this.trader.toLamports(p.quoteMint, pnlTotal).catch(() => undefined);
      this.stats.record({
        closedAt: Date.now(),
        mint: p.mint,
        symbol: p.symbol ?? '',
        source: p.source,
        quoteMint: p.quoteMint,
        pnlPct: (Number(pnlTotal) / Number(initial)) * 100,
        pnlSol: totalLamports === undefined ? undefined : Number(totalLamports) / 1e9,
        holdSeconds: (Date.now() - p.openedAt) / 1000,
        entryMcapUsd: p.entryMcapUsd,
      });
      this.trader
        .reclaimRent(p.mint)
        .then((lamports) => lamports && log.info(`${name}: rent recuperado ${(lamports / 1e9).toFixed(5)} SOL`))
        .catch((e) => log.warn(`${name}: no se pudo recuperar el rent: ${(e as Error).message}`));
    } else {
      p.tokenAmount -= res.amount;
      p.costQuote -= soldCost;
      p.peakValue = undefined;
      p.partialDone = true;
    }
    this.save();

    const pnlLamports = await this.trader.toLamports(p.quoteMint, pnl).catch(() => undefined);
    const pnlSol = pnlLamports === undefined ? undefined : Number(pnlLamports) / 1e9;
    this.risk.record(pnl < 0n, pnlSol);
    log.trade(
      `VENDIDO ${name}: ${formatAmount(soldCost, p.quoteDecimals)} → ${formatAmount(res.quoteOut, p.quoteDecimals)} ${q} ` +
        `(PnL ${formatAmount(pnl, p.quoteDecimals)} ${q}${pnlSol !== undefined ? ` ≈ ${pnlSol.toFixed(4)} SOL` : ''} | ` +
        `hoy ${this.risk.pnlTodaySol.toFixed(4)} SOL) ${res.signature}`,
    );
  }
}
