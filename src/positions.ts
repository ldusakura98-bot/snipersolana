import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, WSOL_MINT } from './config.js';
import { decideExit, ExitRules } from './exits.js';
import { decodePoolState } from './launchlab/layout.js';
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

/**
 * Vigila las posiciones abiertas y vende según las reglas de `exits.ts`.
 * - Posiciones en la curva de LaunchLab: suscripción a la cuenta del pool → se evalúa en cuanto cambia el precio.
 * - Todas: además, sondeo cada PRICE_CHECK_INTERVAL_MS (respaldo y control de tiempo máximo).
 */
export class PositionManager {
  readonly positions = new Map<string, Position>();
  private subs = new Map<string, number>();
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
    await Promise.all([...this.subs.values()].map((id) => this.connection.removeAccountChangeListener(id)));
    this.subs.clear();
  }

  private track(p: Position) {
    // El coste inicial se fija al abrir; las ventas parciales reducen costQuote pero no este.
    this.positions.set(p.mint, { ...p, initialCostQuote: p.initialCostQuote ?? p.costQuote, busy: false });
    const tracked = this.positions.get(p.mint)!;
    if (tracked.venue === 'launchlab' && tracked.launchlab && !this.subs.has(p.mint)) {
      const id = this.connection.onAccountChange(
        new PublicKey(tracked.launchlab.poolState),
        (info) => {
          // Cada operación en el pool llega aquí: evaluamos al momento, sin esperar al sondeo.
          void this.evaluate(tracked, async () => this.trader.valueFromPool(tracked, decodePoolState(info.data)));
        },
        { commitment: 'processed' },
      );
      this.subs.set(p.mint, id);
    }
  }

  private untrack(mint: string) {
    this.positions.delete(mint);
    const id = this.subs.get(mint);
    if (id !== undefined) void this.connection.removeAccountChangeListener(id);
    this.subs.delete(mint);
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

  private async evaluate(p: Position, getValue: () => Promise<bigint | undefined>) {
    if (p.busy || !this.positions.has(p.mint)) return;
    p.busy = true;
    const name = p.symbol ?? p.mint;
    try {
      const value = await getValue();
      if (value === undefined) return;
      const peakBefore = p.peakValue;
      const decision = decideExit(p, value, Date.now(), rules);
      if (!decision) {
        if (p.peakValue !== peakBefore) this.save();
        return;
      }

      log.trade(`VENDIENDO ${decision.fraction < 1 ? `${decision.fraction * 100}% de ` : ''}${name}: ${decision.reason}`);
      const res = await this.trader.sell(p, decision.fraction);
      if (!res) {
        log.warn(`${name}: no hay ruta de venta, se reintentará`);
        return;
      }

      // Coste proporcional a lo vendido: el PnL del resto sigue midiéndose sobre su parte del coste.
      const soldCost = decision.fraction >= 1 ? p.costQuote : (p.costQuote * res.amount) / p.tokenAmount;
      const pnl = res.quoteOut - soldCost;
      const q = quoteLabel(p.quoteMint);
      p.proceedsQuote = (p.proceedsQuote ?? 0n) + res.quoteOut;
      if (decision.fraction >= 1) {
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
    } catch (e) {
      log.error(`${name}: error gestionando posición: ${(e as Error).message}`);
    } finally {
      p.busy = false;
    }
  }
}
