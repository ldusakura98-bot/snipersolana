import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ClosedTrade, summarize, TradeStats } from '../src/stats.js';

const trade = (pnlPct: number, pnlSol?: number): ClosedTrade => ({
  closedAt: Date.now(),
  mint: `M${pnlPct}`,
  symbol: 'TKN',
  source: 'stonkfun',
  quoteMint: 'Q',
  pnlPct,
  pnlSol,
  holdSeconds: 600,
  entryMcapUsd: 50_000,
});

describe('summarize (tramos de GMGN)', () => {
  it('clasifica cada token en su tramo y calcula la tasa de éxito', () => {
    const s = summarize([trade(600, 0.5), trade(300), trade(50), trade(0), trade(-10, -0.01), trade(-50), trade(-80)]);
    assert.equal(s.tokens, 7);
    assert.deepEqual(
      s.buckets.map((b) => [b.label, b.count]),
      [['>500%', 1], ['200%~500%', 1], ['0%~200%', 2], ['-50%~0%', 2], ['<-50%', 1]],
    );
    assert.equal(s.winRatePct.toFixed(2), ((3 / 7) * 100).toFixed(2)); // 0 % no cuenta como ganadora
    assert.equal(s.pnlSol.toFixed(2), '0.49');
    assert.equal(s.avgHoldMinutes, 10);
  });
});

describe('TradeStats', () => {
  it('guarda en CSV y lo recupera al reiniciar', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stats-')), 'trades.csv');
    const a = new TradeStats(file);
    a.record(trade(120, 0.06));
    a.record({ ...trade(-20), symbol: 'con,coma', pnlSol: undefined, entryMcapUsd: undefined });
    const b = new TradeStats(file);
    const s = summarize((b as unknown as { trades: ClosedTrade[] }).trades);
    assert.equal(s.tokens, 2);
    assert.equal(s.pnlSol.toFixed(2), '0.06');
    assert.equal(s.buckets[2].count, 1);
    assert.equal(s.buckets[3].count, 1);
  });
});
