import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { log } from './logger.js';

/** Resultado final de un token (todas sus ventas, incluidas las parciales). */
export interface ClosedTrade {
  closedAt: number;
  mint: string;
  symbol: string;
  source: string;
  quoteMint: string;
  /** PnL % sobre lo invertido en el token. */
  pnlPct: number;
  /** PnL en SOL (si se pudo convertir). */
  pnlSol?: number;
  holdSeconds: number;
  entryMcapUsd?: number;
}

/** Los mismos tramos que muestra GMGN en "Distribución", para comparar directamente. */
export const BUCKETS = [
  { label: '>500%', test: (p: number) => p > 500 },
  { label: '200%~500%', test: (p: number) => p > 200 && p <= 500 },
  { label: '0%~200%', test: (p: number) => p >= 0 && p <= 200 },
  { label: '-50%~0%', test: (p: number) => p < 0 && p >= -50 },
  { label: '<-50%', test: (p: number) => p < -50 },
];

export interface Summary {
  tokens: number;
  winRatePct: number;
  pnlSol: number;
  avgHoldMinutes: number;
  buckets: { label: string; count: number; pct: number }[];
}

export function summarize(trades: ClosedTrade[]): Summary {
  const n = trades.length;
  const pct = (c: number) => (n ? (c / n) * 100 : 0);
  return {
    tokens: n,
    winRatePct: pct(trades.filter((t) => t.pnlPct > 0).length),
    pnlSol: trades.reduce((s, t) => s + (t.pnlSol ?? 0), 0),
    avgHoldMinutes: n ? trades.reduce((s, t) => s + t.holdSeconds, 0) / n / 60 : 0,
    buckets: BUCKETS.map((b) => {
      const count = trades.filter((t) => b.test(t.pnlPct)).length;
      return { label: b.label, count, pct: pct(count) };
    }),
  };
}

const COLUMNS: (keyof ClosedTrade)[] = [
  'closedAt', 'mint', 'symbol', 'source', 'quoteMint', 'pnlPct', 'pnlSol', 'holdSeconds', 'entryMcapUsd',
];

/** Guarda cada token cerrado en un CSV (abrible en Excel/Sheets) y muestra resúmenes estilo GMGN. */
export class TradeStats {
  private trades: ClosedTrade[] = [];

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const [, ...rows] = readFileSync(file, 'utf8').trim().split('\n');
    for (const row of rows) {
      const v = row.split(',');
      const num = (i: number) => (v[i] === '' ? undefined : Number(v[i]));
      this.trades.push({
        closedAt: Date.parse(v[0]),
        mint: v[1],
        symbol: v[2],
        source: v[3],
        quoteMint: v[4],
        pnlPct: Number(v[5]),
        pnlSol: num(6),
        holdSeconds: Number(v[7]),
        entryMcapUsd: num(8),
      });
    }
  }

  record(t: ClosedTrade) {
    this.trades.push(t);
    if (!existsSync(this.file)) appendFileSync(this.file, COLUMNS.join(',') + '\n');
    const cell = (k: keyof ClosedTrade) => {
      const value = t[k];
      if (value === undefined) return '';
      if (k === 'closedAt') return new Date(value as number).toISOString();
      if (typeof value === 'number') return Number(value.toFixed(6)).toString();
      return String(value).replace(/,/g, ' ');
    };
    appendFileSync(this.file, COLUMNS.map(cell).join(',') + '\n');
  }

  /** Resumen de los últimos `days` días, con el mismo formato que GMGN. */
  logSummary(days: number) {
    const since = Date.now() - days * 86_400_000;
    const s = summarize(this.trades.filter((t) => t.closedAt >= since));
    if (s.tokens === 0) return;
    log.info(
      `Resumen ${days}D: ${s.tokens} tokens | tasa de éxito ${s.winRatePct.toFixed(1)}% | ` +
        `PnL ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(4)} SOL | tenencia media ${s.avgHoldMinutes.toFixed(0)} min\n` +
        s.buckets.map((b) => `    ${b.label.padEnd(10)} ${String(b.count).padStart(5)} (${b.pct.toFixed(2)}%)`).join('\n'),
    );
  }
}
