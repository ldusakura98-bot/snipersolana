import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideExit, ExitRules } from '../src/exits.js';
import { RiskManager } from '../src/risk.js';
import type { Position } from '../src/types.js';

const rules: ExitRules = {
  stopLossPct: 30,
  takeProfitPct: 300,
  trailingStopPct: 25,
  trailingActivationPct: 50,
  partialTpPct: 100,
  partialTpSellPct: 50,
  maxHoldSeconds: 600,
};
const pos = (): Position => ({
  mint: 'M',
  source: 'stonkfun',
  venue: 'launchlab',
  quoteMint: 'Q',
  quoteDecimals: 6,
  tokenAmount: 1000n,
  costQuote: 100n,
  openedAt: 0,
});

describe('decideExit', () => {
  it('stop-loss al caer 30 %', () => {
    const p = pos();
    assert.equal(decideExit(p, 80n, 1000, rules), undefined);
    assert.match(decideExit(p, 70n, 1000, rules)!.reason, /stop-loss/);
  });

  it('venta parcial del 50 % al doblar, y solo una vez', () => {
    const p = pos();
    const d = decideExit(p, 200n, 1000, rules)!;
    assert.match(d.reason, /parcial/);
    assert.equal(d.fraction, 0.5);
    p.partialDone = true;
    assert.equal(decideExit(p, 210n, 1000, rules), undefined);
  });

  it('trailing stop: tras subir a +150 %, vende si cae 25 % desde el máximo', () => {
    const p = { ...pos(), partialDone: true };
    assert.equal(decideExit(p, 250n, 1000, rules), undefined); // máximo +150 %
    assert.equal(decideExit(p, 200n, 1000, rules), undefined); // -20 % desde el máximo
    const d = decideExit(p, 187n, 1000, rules)!; // -25,2 % desde el máximo, aún +87 %
    assert.match(d.reason, /trailing/);
    assert.equal(d.fraction, 1);
  });

  it('el trailing no se arma si nunca superó la activación (+50 %)', () => {
    const p = pos();
    decideExit(p, 140n, 1000, rules); // máximo +40 %
    assert.equal(decideExit(p, 100n, 1000, rules), undefined); // -28 % desde el máximo pero sin armar
  });

  it('take-profit total y tiempo máximo', () => {
    assert.match(decideExit({ ...pos(), partialDone: true }, 400n, 1000, rules)!.reason, /take-profit/);
    assert.match(decideExit(pos(), 105n, 600_000, rules)!.reason, /tiempo/);
  });
});

describe('RiskManager', () => {
  it('bloquea compras al alcanzar la pérdida diaria y se reinicia al día siguiente', () => {
    let now = Date.parse('2026-10-14T10:00:00Z');
    const r = new RiskManager({ maxDailyLossSol: 0.1, maxConsecutiveLosses: 0, cooldownMinutes: 0 }, undefined, () => now);
    r.record(true, -0.06);
    assert.equal(r.canOpen().ok, true);
    r.record(true, -0.05);
    assert.equal(r.canOpen().ok, false);
    now = Date.parse('2026-10-15T00:01:00Z');
    assert.equal(r.canOpen().ok, true);
  });

  it('pausa tras N pérdidas seguidas; una ganancia reinicia la racha', () => {
    let now = 0;
    const r = new RiskManager({ maxDailyLossSol: 0, maxConsecutiveLosses: 3, cooldownMinutes: 60 }, undefined, () => now);
    r.record(true, -0.01);
    r.record(true, -0.01);
    r.record(false, 0.05);
    r.record(true, -0.01);
    assert.equal(r.canOpen().ok, true);
    r.record(true, -0.01);
    r.record(true, -0.01);
    assert.equal(r.canOpen().ok, false);
    now += 61 * 60_000;
    assert.equal(r.canOpen().ok, true);
  });
});
