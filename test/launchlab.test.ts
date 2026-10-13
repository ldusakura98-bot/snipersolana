import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { LAUNCHLAB_PROGRAM } from '../src/config.js';
import { u64le } from '../src/launchlab/borsh.js';
import {
  applyBuy,
  constantCurveInit,
  CurvePool,
  curveProgressPct,
  FeeRates,
  quoteBuy,
  quoteSell,
  transferFeeOf,
} from '../src/launchlab/curve.js';
import { buyExactInIx, LAUNCHLAB_AUTHORITY } from '../src/launchlab/instructions.js';
import { CurveType, decodeLaunchLabCreate, decodePoolState, IX } from '../src/launchlab/layout.js';
import type { RawIx } from '../src/types.js';

const key = () => Keypair.generate().publicKey.toBase58();
const borshString = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

describe('discriminadores (valores copiados del IDL oficial de Raydium)', () => {
  it('instrucciones', () => {
    assert.deepEqual([...IX.initialize], [175, 175, 109, 31, 13, 152, 155, 237]);
    assert.deepEqual([...IX.initializeV2], [67, 153, 175, 39, 218, 16, 38, 32]);
    assert.deepEqual([...IX.initializeWithToken2022], [37, 190, 126, 222, 44, 154, 171, 17]);
    assert.deepEqual([...IX.buyExactIn], [250, 234, 13, 123, 213, 156, 19, 236]);
    assert.deepEqual([...IX.sellExactIn], [149, 39, 222, 155, 211, 124, 152, 26]);
  });

  it('cuentas', () => {
    const acc = (n: string) => [...createHash('sha256').update(`account:${n}`).digest().subarray(0, 8)];
    assert.deepEqual(acc('PoolState'), [247, 237, 227, 245, 215, 195, 222, 70]);
    assert.deepEqual(acc('GlobalConfig'), [149, 8, 156, 202, 160, 252, 176, 217]);
    assert.deepEqual(acc('PlatformConfig'), [160, 78, 128, 0, 248, 83, 230, 160]);
  });
});

describe('decodeLaunchLabCreate', () => {
  // Cuentas de initialize_with_token_2022 en el orden del IDL.
  const accounts = Array.from({ length: 15 }, key);
  const [, creator, globalConfig, platformConfig, , poolState, baseMint, quoteMint, baseVault, quoteVault, baseProg, quoteProg] =
    accounts;

  const createIx: RawIx = {
    programId: LAUNCHLAB_PROGRAM,
    accounts,
    data: Buffer.concat([
      IX.initializeWithToken2022,
      Buffer.from([6]), // decimals
      borshString('Mi Token'),
      borshString('MTK'),
      borshString('https://example.com/meta.json'),
      Buffer.from([0]), // CurveParams::Constant
      u64le(1_000_000_000_000_000n, 793_100_000_000_000n, 85_000_000_000n),
      Buffer.from([1]), // migrate_type
      u64le(0n, 0n, 0n), // VestingParams
      Buffer.from([0, 1]), // amm_fee_on, Some(TransferFeeExtensionParams)
      Buffer.from([0x2c, 0x01]), // 300 bps
      u64le(1_000_000n),
    ]),
  };
  const devBuy: RawIx = {
    programId: LAUNCHLAB_PROGRAM,
    accounts: [creator, key(), globalConfig, platformConfig, poolState],
    data: Buffer.concat([IX.buyExactIn, u64le(2_000_000_000n, 0n, 0n)]),
  };

  it('extrae mints, vaults, programas y parámetros de la curva', () => {
    const l = decodeLaunchLabCreate([createIx, devBuy]);
    assert.ok(l);
    assert.equal(l.poolState, poolState);
    assert.equal(l.creator, creator);
    assert.equal(l.globalConfig, globalConfig);
    assert.equal(l.platformConfig, platformConfig);
    assert.equal(l.baseMint, baseMint);
    assert.equal(l.quoteMint, quoteMint);
    assert.equal(l.baseVault, baseVault);
    assert.equal(l.quoteVault, quoteVault);
    assert.equal(l.baseTokenProgram, baseProg);
    assert.equal(l.quoteTokenProgram, quoteProg);
    assert.equal(l.name, 'Mi Token');
    assert.equal(l.symbol, 'MTK');
    assert.equal(l.decimals, 6);
    assert.deepEqual(l.curve, {
      supply: 1_000_000_000_000_000n,
      totalBaseSell: 793_100_000_000_000n,
      totalQuoteFundRaising: 85_000_000_000n,
    });
    assert.deepEqual(l.sameTxBuysQuote, [2_000_000_000n]);
    assert.deepEqual(l.transferFee, { bps: 300, max: 1_000_000n });
  });

  it('ignora instrucciones de otros programas o que no son de creación', () => {
    assert.equal(decodeLaunchLabCreate([{ ...createIx, programId: key() }]), undefined);
    assert.equal(decodeLaunchLabCreate([devBuy]), undefined);
  });
});

describe('decodePoolState', () => {
  it('lee reservas y direcciones en los offsets correctos', () => {
    const pks = Array.from({ length: 7 }, key);
    const data = Buffer.concat([
      createHash('sha256').update('account:PoolState').digest().subarray(0, 8),
      u64le(1n), // epoch
      Buffer.from([255, 0, 6, 9, 1]), // auth_bump, status, base_decimals, quote_decimals, migrate_type
      u64le(10n, 20n, 30n, 40n, 50n, 60n, 70n), // supply … total_quote_fund_raising
      u64le(0n, 0n, 0n), // fees
      u64le(0n, 0n, 0n, 0n, 0n), // vesting_schedule
      ...pks.map((p) => Buffer.from(bs58.decode(p))),
      Buffer.alloc(1 + 1 + 8 + 54),
    ]);
    const p = decodePoolState(data);
    assert.equal(p.status, 0);
    assert.equal(p.baseDecimals, 6);
    assert.equal(p.quoteDecimals, 9);
    assert.deepEqual(
      [p.supply, p.totalBaseSell, p.virtualBase, p.virtualQuote, p.realBase, p.realQuote, p.totalQuoteFundRaising],
      [10n, 20n, 30n, 40n, 50n, 60n, 70n],
    );
    assert.deepEqual(
      [p.globalConfig, p.platformConfig, p.baseMint, p.quoteMint, p.baseVault, p.quoteVault, p.creator],
      pks,
    );
  });

  it('rechaza cuentas que no son PoolState', () => {
    assert.throws(() => decodePoolState(Buffer.alloc(400)));
  });
});

describe('curva de producto constante', () => {
  const params = {
    supply: 1_000_000_000_000_000n,
    totalBaseSell: 793_100_000_000_000n,
    totalQuoteFundRaising: 85_000_000_000n,
    totalLockedAmount: 0n,
    migrateFee: 0n,
  };
  const { virtualBase, virtualQuote } = constantCurveInit(params);
  const pool: CurvePool = {
    virtualBase,
    virtualQuote,
    realBase: 0n,
    realQuote: 0n,
    totalBaseSell: params.totalBaseSell,
    totalQuoteFundRaising: params.totalQuoteFundRaising,
  };
  const noFees: FeeRates = { protocol: 0n, platform: 0n, creator: 0n };
  const fees: FeeRates = { protocol: 2_500n, platform: 7_500n, creator: 0n }; // 1 % en total

  it('al recaudar todo el objetivo se venden exactamente los tokens de la curva', () => {
    const { baseOut } = quoteBuy(CurveType.Constant, pool, params.totalQuoteFundRaising, noFees);
    const diff = Number(params.totalBaseSell - baseOut) / Number(params.totalBaseSell);
    assert.ok(Math.abs(diff) < 1e-6, `diferencia relativa ${diff}`);
  });

  it('nunca entrega más tokens de los que quedan en la curva', () => {
    const { baseOut } = quoteBuy(CurveType.Constant, pool, params.totalQuoteFundRaising * 10n, noFees);
    assert.equal(baseOut, params.totalBaseSell);
  });

  it('comprar y vender inmediatamente pierde ~2 × comisión', () => {
    const quoteIn = 1_000_000_000n;
    const { baseOut } = quoteBuy(CurveType.Constant, pool, quoteIn, fees);
    const after = applyBuy(CurveType.Constant, pool, quoteIn, fees);
    const back = quoteSell(CurveType.Constant, after, baseOut, fees);
    const lossPct = (Number(quoteIn - back) / Number(quoteIn)) * 100;
    assert.ok(lossPct > 1.9 && lossPct < 2.1, `pérdida ${lossPct}%`);
  });

  it('el progreso de la curva sube con las compras', () => {
    assert.equal(curveProgressPct(pool), 0);
    const after = applyBuy(CurveType.Constant, pool, params.totalQuoteFundRaising / 2n, noFees);
    assert.equal(curveProgressPct(after), 50);
  });

  it('comisión de transferencia Token-2022 con tope máximo', () => {
    assert.equal(transferFeeOf(10_000n, { bps: 300, max: 1_000n }), 300n);
    assert.equal(transferFeeOf(1_000_000n, { bps: 300, max: 1_000n }), 1_000n);
    assert.equal(transferFeeOf(10_000n), 0n);
  });
});

describe('instrucciones', () => {
  it('PDA de autoridad = la que aparece en Solscan en las txs de LaunchLab', () => {
    assert.equal(LAUNCHLAB_AUTHORITY.toBase58(), 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh');
  });

  it('buy_exact_in: 18 cuentas (15 del IDL + system, platform vault, creator vault) y datos correctos', () => {
    const k = () => Keypair.generate().publicKey;
    const ix = buyExactInIx(
      {
        payer: k(), globalConfig: k(), platformConfig: k(), poolState: k(), userBaseToken: k(), userQuoteToken: k(),
        baseVault: k(), quoteVault: k(), baseMint: k(), quoteMint: k(), baseTokenProgram: k(), quoteTokenProgram: k(),
        creator: k(),
      },
      123n,
      45n,
    );
    assert.equal(ix.keys.length, 18);
    assert.ok(ix.keys[0].isSigner);
    assert.ok(ix.keys[1].pubkey.equals(LAUNCHLAB_AUTHORITY));
    assert.deepEqual([...ix.data], [...IX.buyExactIn, ...u64le(123n, 45n, 0n)]);
  });
});
