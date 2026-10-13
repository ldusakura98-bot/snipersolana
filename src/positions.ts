import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { config, WSOL_MINT } from './config.js';
import { log } from './logger.js';
import type { Trader } from './trader.js';
import type { Position } from './types.js';

export const formatAmount = (amount: bigint, decimals: number) => (Number(amount) / 10 ** decimals).toFixed(Math.min(decimals, 6));
const quoteLabel = (mint: string) => (mint === WSOL_MINT ? 'SOL' : `${mint.slice(0, 4)}…`);

// JSON no soporta bigint: se guardan como {"$big": "123"}.
const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v);
const reviver = (_: string, v: any) => (v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v);

/** Vigila las posiciones abiertas y vende por take-profit, stop-loss o tiempo. Persiste en disco. */
export class PositionManager {
  readonly positions = new Map<string, Position>();
  private realized = new Map<string, bigint>(); // PnL realizado por quote token
  private timer?: NodeJS.Timeout;

  constructor(private readonly trader: Trader) {}

  /** Recupera las posiciones guardadas (si el bot se reinicia no se pierden). */
  load() {
    try {
      const saved = JSON.parse(readFileSync(config.positionsFile, 'utf8'), reviver) as Position[];
      for (const p of saved) this.positions.set(p.mint, { ...p, selling: false });
      if (saved.length) log.info(`Recuperadas ${saved.length} posiciones de ${config.positionsFile}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`No se pudo leer ${config.positionsFile}: ${(e as Error).message}`);
    }
  }

  open(p: Position) {
    this.positions.set(p.mint, p);
    this.save();
  }

  start() {
    this.timer = setInterval(() => void this.tick(), config.priceCheckIntervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  private save() {
    const tmp = `${config.positionsFile}.tmp`;
    const data = [...this.positions.values()].map(({ selling, ...p }) => p);
    writeFileSync(tmp, JSON.stringify(data, replacer, 2));
    renameSync(tmp, config.positionsFile); // escritura atómica
  }

  private async tick() {
    await Promise.all([...this.positions.values()].map((p) => this.check(p)));
  }

  private async check(p: Position) {
    if (p.selling) return;
    const name = p.symbol ?? p.mint;
    try {
      const value = await this.trader.value(p);
      const heldSec = (Date.now() - p.openedAt) / 1000;
      const timedOut = config.maxHoldSeconds > 0 && heldSec >= config.maxHoldSeconds;
      if (value === undefined) {
        if (timedOut) log.warn(`${name}: sin ruta de venta tras ${heldSec.toFixed(0)}s`);
        return;
      }

      const pnlPct = (Number(value - p.costQuote) / Number(p.costQuote)) * 100;
      let reason: string | undefined;
      if (pnlPct >= config.takeProfitPct) reason = 'take-profit';
      else if (pnlPct <= -config.stopLossPct) reason = 'stop-loss';
      else if (timedOut) reason = 'tiempo máximo';
      if (!reason) return;

      p.selling = true;
      log.trade(`VENDIENDO ${name} (${reason}, PnL ${pnlPct.toFixed(1)}%)`);
      const res = await this.trader.sell(p);
      if (!res) {
        log.warn(`${name}: no hay ruta de venta, se reintentará`);
        p.selling = false;
        return;
      }
      this.positions.delete(p.mint);
      this.save();

      const q = quoteLabel(p.quoteMint);
      const pnl = res.quoteOut - p.costQuote;
      const total = (this.realized.get(p.quoteMint) ?? 0n) + pnl;
      this.realized.set(p.quoteMint, total);
      log.trade(
        `VENDIDO ${name}: ${formatAmount(p.costQuote, p.quoteDecimals)} → ${formatAmount(res.quoteOut, p.quoteDecimals)} ${q} ` +
          `(PnL ${formatAmount(pnl, p.quoteDecimals)} ${q} | acumulado ${formatAmount(total, p.quoteDecimals)} ${q}) ${res.signature}`,
      );
    } catch (e) {
      p.selling = false;
      log.error(`${name}: error gestionando posición: ${(e as Error).message}`);
    }
  }
}
