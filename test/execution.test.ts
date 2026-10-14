import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Connection } from '@solana/web3.js';
import { config } from '../src/config.js';
import { decideExit } from '../src/exits.js';
import { sellSlippageBps } from '../src/positions.js';
import { PriorityFees } from '../src/tx.js';

describe('sellSlippageBps', () => {
  it('normal: empieza en SELL_SLIPPAGE_BPS y se duplica en cada fallo hasta el tope urgente', () => {
    assert.equal(sellSlippageBps(0, false), config.sellSlippageBps);
    assert.equal(sellSlippageBps(1, false), Math.min(config.sellSlippageBps * 2, config.urgentSellSlippageBps));
    assert.equal(sellSlippageBps(10, false), config.urgentSellSlippageBps);
  });

  it('urgente: empieza en URGENT_SELL_SLIPPAGE_BPS y nunca pasa de 99 %', () => {
    assert.equal(sellSlippageBps(0, true), config.urgentSellSlippageBps);
    assert.ok(sellSlippageBps(10, true) <= 9_900);
  });
});

describe('stop-loss', () => {
  it('se marca como urgente (las demás salidas no)', () => {
    const base = {
      mint: 'M', source: 'stonkfun' as const, venue: 'launchlab' as const, quoteMint: 'Q', quoteDecimals: 6,
      tokenAmount: 1n, costQuote: 100n, openedAt: 0,
    };
    const rules = {
      stopLossPct: 30, takeProfitPct: 300, trailingStopPct: 25, trailingActivationPct: 50,
      partialTpPct: 100, partialTpSellPct: 50, maxHoldSeconds: 600,
    };
    assert.equal(decideExit({ ...base }, 60n, 0, rules)?.urgent, true);
    assert.equal(decideExit({ ...base }, 400n, 0, rules)?.urgent, undefined);
  });
});

describe('PriorityFees (modo dinámico)', () => {
  const fake = (fees: number[]) =>
    ({ getRecentPrioritizationFees: async () => fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee })) }) as unknown as Connection;
  const min = PriorityFees.fromLamports(config.priorityFeeMinLamports);
  const max = PriorityFees.fromLamports(config.priorityFeeMaxLamports);

  it('usa el percentil de la red, acotado entre el mínimo y el máximo', async () => {
    const mid = Math.round((min + max) / 2);
    const pf = new PriorityFees(fake([...Array(75).fill(0), ...Array(25).fill(mid)]));
    await pf.start();
    pf.stop();
    assert.equal(pf.price('normal'), mid);
  });

  it('nunca pasa del tope ni baja del suelo', async () => {
    const high = new PriorityFees(fake(Array(100).fill(max * 10)));
    await high.start();
    high.stop();
    assert.equal(high.price('normal'), max);
    const low = new PriorityFees(fake(Array(100).fill(0)));
    await low.start();
    low.stop();
    assert.equal(low.price('normal'), min);
    assert.equal(low.price('low'), min);
  });
});
