import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { LAUNCHLAB_PROGRAM, PUMPFUN_PROGRAM, STONKFUN_PLATFORM_CONFIGS_DEFAULT, WSOL_MINT } from '../src/config.js';
import { detectLaunch } from '../src/decoders.js';
import { compiledToRawIxs } from '../src/stream/grpc.js';
import { u64le } from '../src/launchlab/borsh.js';
import { LaunchLabClient, spotPrice } from '../src/launchlab/client.js';
import { IX } from '../src/launchlab/layout.js';
import type { RawIx } from '../src/types.js';

const key = () => Keypair.generate().publicKey.toBase58();
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const accDisc = (n: string) => createHash('sha256').update(`account:${n}`).digest().subarray(0, 8);
const meta = { signature: 'sig', detectedAt: 0 };

function launchIx(platformConfig: string, quoteMint = WSOL_MINT): RawIx {
  const accounts = Array.from({ length: 15 }, key);
  accounts[3] = platformConfig;
  accounts[7] = quoteMint;
  return {
    programId: LAUNCHLAB_PROGRAM,
    accounts,
    data: Buffer.concat([
      IX.initializeWithToken2022,
      Buffer.from([6]),
      str('Stonk Test'),
      str('STT'),
      str(''),
      Buffer.from([0]),
      u64le(1_000_000_000_000_000n, 793_100_000_000_000n, 85_000_000_000n),
      Buffer.from([1]),
      u64le(0n, 0n, 0n),
    ]),
  };
}

describe('detectLaunch', () => {
  const stonkPlatform = STONKFUN_PLATFORM_CONFIGS_DEFAULT[1];

  it('marca como stonkfun los pools creados con un platform_config de StonkFun', () => {
    const t = detectLaunch([launchIx(stonkPlatform)], ['stonkfun'], meta);
    assert.equal(t?.source, 'stonkfun');
    assert.equal(t?.launchlab?.symbol, 'STT');
  });

  it('ignora otras plataformas de LaunchLab salvo que "launchlab" esté activo', () => {
    const other = launchIx(key());
    assert.equal(detectLaunch([other], ['stonkfun'], meta), undefined);
    assert.equal(detectLaunch([other], ['stonkfun', 'launchlab'], meta)?.source, 'launchlab');
  });

  it('detecta pump.fun create (mint = cuenta 0)', () => {
    const mint = key();
    const ix: RawIx = {
      programId: PUMPFUN_PROGRAM,
      accounts: [mint, key()],
      data: createHash('sha256').update('global:create').digest().subarray(0, 8),
    };
    assert.equal(detectLaunch([ix], ['pumpfun'], meta)?.mint, mint);
    assert.equal(detectLaunch([ix], ['stonkfun'], meta), undefined);
  });
});

describe('LaunchLabClient.snapshot', () => {
  it('reconstruye el pool desde la instrucción si la cuenta aún no existe, aplicando el dev buy', async () => {
    const launch = detectLaunch([launchIx(key(), key())], ['launchlab'], meta)!.launchlab!;
    launch.sameTxBuysQuote = [42_500_000_000n]; // el creador compra la mitad del objetivo

    const globalData = Buffer.concat([accDisc('GlobalConfig'), u64le(1n), Buffer.from([0, 0, 0]), u64le(0n, 2_500n)]);
    const platformData = Buffer.concat([
      accDisc('PlatformConfig'),
      u64le(1n),
      Buffer.alloc(64),
      u64le(0n, 0n, 0n, 0n), // scales + fee_rate 0
      Buffer.from('StonkFun'.padEnd(64, '\0')),
      Buffer.alloc(256 + 256 + 32),
      u64le(0n),
    ]);
    const accounts = new Map([
      [launch.globalConfig, globalData],
      [launch.platformConfig, platformData],
    ]);
    const fake = {
      getAccountInfo: async (pk: PublicKey) => {
        const data = accounts.get(pk.toBase58());
        return data ? { data } : null;
      },
      getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { decimals: 8 } } } } }),
    } as unknown as Connection;

    const s = await new LaunchLabClient(fake).snapshot(launch);
    assert.equal(s.origin, 'estimated');
    assert.equal(s.platformName, 'StonkFun');
    assert.equal(s.quoteDecimals, 8);
    // 42.5 de 85 menos 0.25 % de comisión → ~49.9 % de la curva.
    const progress = Number(s.pool.realQuote) / Number(s.pool.totalQuoteFundRaising);
    assert.ok(progress > 0.498 && progress < 0.5, `progreso ${progress}`);
    assert.ok(spotPrice(s) > 0);
  });
});


describe('compiledToRawIxs (gRPC / shreds)', () => {
  it('resuelve índices incluyendo cuentas de lookup tables (writable y luego readonly)', () => {
    const k = () => Keypair.generate().publicKey;
    const [a, b, prog, altW, altR] = [k(), k(), k(), k(), k()];
    const ixs = compiledToRawIxs(
      [a.toBytes(), b.toBytes(), prog.toBytes()],
      [altW.toBytes()],
      [altR.toBytes()],
      [{ programIdIndex: 2, accounts: Uint8Array.from([0, 3, 4, 1]), data: Uint8Array.from([7]) }],
    );
    assert.equal(ixs.length, 1);
    assert.equal(ixs[0].programId, prog.toBase58());
    assert.deepEqual(ixs[0].accounts, [a, altW, altR, b].map((x) => x.toBase58()));
    assert.deepEqual([...ixs[0].data], [7]);
  });
});
