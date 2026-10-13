import { config } from './config.js';
import { log } from './logger.js';
import { LAMPORTS_PER_SOL, Trader } from './trader.js';

export interface Position {
  mint: string;
  tokenAmount: bigint;
  costLamports: bigint;
  openedAt: number;
  selling?: boolean;
}

const sol = (lamports: bigint) => (Number(lamports) / Number(LAMPORTS_PER_SOL)).toFixed(4);

/** Vigila las posiciones abiertas y vende por take-profit, stop-loss o tiempo. */
export class PositionManager {
  readonly positions = new Map<string, Position>();
  private realizedLamports = 0n;
  private timer?: NodeJS.Timeout;

  constructor(private readonly trader: Trader) {}

  open(p: Position) {
    this.positions.set(p.mint, p);
  }

  start() {
    this.timer = setInterval(() => void this.tick(), config.priceCheckIntervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  private async tick() {
    await Promise.all([...this.positions.values()].map((p) => this.check(p)));
  }

  private async check(p: Position) {
    if (p.selling) return;
    try {
      const value = await this.trader.valueInLamports(p.mint, p.tokenAmount);
      const heldSec = (Date.now() - p.openedAt) / 1000;
      const timedOut = config.maxHoldSeconds > 0 && heldSec >= config.maxHoldSeconds;
      if (value === undefined) {
        if (timedOut) log.warn(`${p.mint}: sin ruta de venta tras ${heldSec.toFixed(0)}s`);
        return;
      }

      const pnlPct = (Number(value - p.costLamports) / Number(p.costLamports)) * 100;
      let reason: string | undefined;
      if (pnlPct >= config.takeProfitPct) reason = 'take-profit';
      else if (pnlPct <= -config.stopLossPct) reason = 'stop-loss';
      else if (timedOut) reason = 'tiempo máximo';
      if (!reason) return;

      p.selling = true;
      log.trade(`VENDIENDO ${p.mint} (${reason}, PnL ${pnlPct.toFixed(1)}%)`);
      const res = await this.trader.sell(p.mint, p.tokenAmount);
      if (!res) {
        log.warn(`${p.mint}: Jupiter no dio ruta de venta, se reintentará`);
        p.selling = false;
        return;
      }
      this.positions.delete(p.mint);
      const pnl = res.outAmount - p.costLamports;
      this.realizedLamports += pnl;
      log.trade(
        `VENDIDO ${p.mint}: ${sol(p.costLamports)} → ${sol(res.outAmount)} SOL ` +
          `(PnL ${sol(pnl)} SOL | acumulado ${sol(this.realizedLamports)} SOL) ${res.signature}`,
      );
    } catch (e) {
      p.selling = false;
      log.error(`${p.mint}: error gestionando posición: ${(e as Error).message}`);
    }
  }
}
