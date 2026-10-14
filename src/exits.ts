import type { Position } from './types.js';

export interface ExitRules {
  stopLossPct: number;
  takeProfitPct: number;
  /** Distancia del trailing stop desde el máximo (0 = desactivado). */
  trailingStopPct: number;
  /** El trailing stop solo se arma cuando el PnL máximo supera este %. */
  trailingActivationPct: number;
  /** Venta parcial al alcanzar este PnL (0 = desactivado). */
  partialTpPct: number;
  /** Qué % de la posición se vende en la venta parcial. */
  partialTpSellPct: number;
  maxHoldSeconds: number;
}

export interface ExitDecision {
  reason: string;
  /** Fracción de la posición a vender (1 = todo). */
  fraction: number;
  /** Salida urgente: se acepta más slippage porque no vender sale más caro. */
  urgent?: boolean;
}

const pct = (value: bigint, cost: bigint) => (Number(value - cost) / Number(cost)) * 100;

/**
 * Decide si hay que vender, dado el valor actual de la posición (en quote).
 * Actualiza `p.peakValue`. Orden: stop-loss → trailing → take-profit → parcial → tiempo.
 */
export function decideExit(p: Position, value: bigint, now: number, r: ExitRules): ExitDecision | undefined {
  if (p.peakValue === undefined || value > p.peakValue) p.peakValue = value;
  const pnl = pct(value, p.costQuote);
  const peakPnl = pct(p.peakValue, p.costQuote);

  if (pnl <= -r.stopLossPct) return { reason: `stop-loss (${pnl.toFixed(1)}%)`, fraction: 1, urgent: true };

  if (r.trailingStopPct > 0 && peakPnl >= r.trailingActivationPct) {
    const fromPeak = (Number(p.peakValue - value) / Number(p.peakValue)) * 100;
    if (fromPeak >= r.trailingStopPct) {
      return { reason: `trailing stop (máx +${peakPnl.toFixed(1)}%, ahora ${pnl.toFixed(1)}%)`, fraction: 1 };
    }
  }

  if (pnl >= r.takeProfitPct) return { reason: `take-profit (${pnl.toFixed(1)}%)`, fraction: 1 };

  if (r.partialTpPct > 0 && !p.partialDone && pnl >= r.partialTpPct) {
    return { reason: `take-profit parcial (${pnl.toFixed(1)}%)`, fraction: r.partialTpSellPct / 100 };
  }

  if (r.maxHoldSeconds > 0 && (now - p.openedAt) / 1000 >= r.maxHoldSeconds) {
    return { reason: `tiempo máximo (${pnl.toFixed(1)}%)`, fraction: 1 };
  }
  return undefined;
}
