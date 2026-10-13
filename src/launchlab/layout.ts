import { createHash } from 'node:crypto';
import { LAUNCHLAB_PROGRAM } from '../config.js';
import type { LaunchLabLaunch, RawIx } from '../types.js';
import { Reader } from './borsh.js';

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const accountDisc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

export const IX = {
  initialize: disc('initialize'),
  initializeV2: disc('initialize_v2'),
  initializeWithToken2022: disc('initialize_with_token_2022'),
  buyExactIn: disc('buy_exact_in'),
  sellExactIn: disc('sell_exact_in'),
};
const ACCOUNT = {
  poolState: accountDisc('PoolState'),
  globalConfig: accountDisc('GlobalConfig'),
  platformConfig: accountDisc('PlatformConfig'),
};

export enum PoolStatus {
  /** Curva activa: se compra/vende contra el programa LaunchLab. */
  Fund = 0,
  /** Curva completada, migrando. */
  Migrate = 1,
  /** Migrado a un pool de Raydium (CPMM/AMM): se opera vía Jupiter. */
  Trade = 2,
}

export enum CurveType {
  Constant = 0,
  Fixed = 1,
  Linear = 2,
}

export interface PoolState {
  status: PoolStatus;
  baseDecimals: number;
  quoteDecimals: number;
  supply: bigint;
  totalBaseSell: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  totalQuoteFundRaising: bigint;
  globalConfig: string;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  creator: string;
}

export interface GlobalConfig {
  curveType: CurveType;
  migrateFee: bigint;
  /** Comisión del protocolo (denominador 1_000_000). */
  tradeFeeRate: bigint;
}

export interface PlatformConfig {
  feeRate: bigint;
  creatorFeeRate: bigint;
  name: string;
}

const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const startsWith = (data: Uint8Array, d: Uint8Array) => data.length >= 8 && eq(data.subarray(0, 8), d);

function checkAccount(data: Uint8Array, d: Uint8Array, name: string) {
  if (!startsWith(data, d)) throw new Error(`La cuenta no es un ${name} de LaunchLab`);
}

export function decodePoolState(data: Uint8Array): PoolState {
  checkAccount(data, ACCOUNT.poolState, 'PoolState');
  const r = new Reader(data, 8);
  r.u64(); // epoch
  r.u8(); // auth_bump
  const status = r.u8();
  const baseDecimals = r.u8();
  const quoteDecimals = r.u8();
  r.u8(); // migrate_type
  const supply = r.u64();
  const totalBaseSell = r.u64();
  const virtualBase = r.u64();
  const virtualQuote = r.u64();
  const realBase = r.u64();
  const realQuote = r.u64();
  const totalQuoteFundRaising = r.u64();
  r.skip(8 * 3); // quote_protocol_fee, platform_fee, migrate_fee
  r.skip(8 * 5); // vesting_schedule
  return {
    status,
    baseDecimals,
    quoteDecimals,
    supply,
    totalBaseSell,
    virtualBase,
    virtualQuote,
    realBase,
    realQuote,
    totalQuoteFundRaising,
    globalConfig: r.pubkey(),
    platformConfig: r.pubkey(),
    baseMint: r.pubkey(),
    quoteMint: r.pubkey(),
    baseVault: r.pubkey(),
    quoteVault: r.pubkey(),
    creator: r.pubkey(),
  };
}

export function decodeGlobalConfig(data: Uint8Array): GlobalConfig {
  checkAccount(data, ACCOUNT.globalConfig, 'GlobalConfig');
  const r = new Reader(data, 8);
  r.u64(); // epoch
  const curveType = r.u8();
  r.u16(); // index
  return { curveType, migrateFee: r.u64(), tradeFeeRate: r.u64() };
}

export function decodePlatformConfig(data: Uint8Array): PlatformConfig {
  checkAccount(data, ACCOUNT.platformConfig, 'PlatformConfig');
  const r = new Reader(data, 8);
  r.u64(); // epoch
  r.skip(32 * 2); // platform_fee_wallet, platform_nft_wallet
  r.skip(8 * 3); // platform_scale, creator_scale, burn_scale
  const feeRate = r.u64();
  const nameBytes = data.subarray(r.offset, r.offset + 64);
  r.skip(64 + 256 + 256); // name, web, img
  r.skip(32); // cpswap_config
  const creatorFeeRate = r.u64();
  const name = Buffer.from(nameBytes).toString('utf8').replace(/\0+$/, '');
  return { feeRate, creatorFeeRate, name };
}

/**
 * Busca en las instrucciones de una transacción la creación de un pool LaunchLab
 * (initialize / initialize_v2 / initialize_with_token_2022) y la decodifica.
 */
export function decodeLaunchLabCreate(ixs: RawIx[]): LaunchLabLaunch | undefined {
  for (const ix of ixs) {
    if (ix.programId !== LAUNCHLAB_PROGRAM) continue;
    const isToken2022 = startsWith(ix.data, IX.initializeWithToken2022);
    if (!isToken2022 && !startsWith(ix.data, IX.initialize) && !startsWith(ix.data, IX.initializeV2)) continue;

    const a = ix.accounts;
    if (a.length < (isToken2022 ? 12 : 13)) continue;

    const r = new Reader(ix.data, 8);
    const decimals = r.u8();
    const name = r.string();
    const symbol = r.string();
    r.string(); // uri
    const curveVariant = r.u8();
    let curve: LaunchLabLaunch['curve'];
    if (curveVariant === CurveType.Constant) {
      curve = { supply: r.u64(), totalBaseSell: r.u64(), totalQuoteFundRaising: r.u64() };
      r.u8(); // migrate_type
    } else {
      r.skip(8 * 2 + 1); // Fixed / Linear: supply, total_quote_fund_raising, migrate_type
    }
    const totalLockedAmount = r.u64();
    r.skip(8 * 2); // cliff_period, unlock_period

    // initialize_with_token_2022 termina con amm_fee_on + Option<TransferFeeExtensionParams>.
    let transferFee: LaunchLabLaunch['transferFee'];
    if (isToken2022 && r.offset + 2 <= ix.data.length) {
      r.u8(); // amm_fee_on
      if (r.u8() === 1) transferFee = { bps: r.u16(), max: r.u64() };
    }

    const poolState = a[5];
    return {
      poolState,
      globalConfig: a[2],
      platformConfig: a[3],
      creator: a[1],
      baseMint: a[6],
      quoteMint: a[7],
      baseVault: a[8],
      quoteVault: a[9],
      baseTokenProgram: isToken2022 ? a[10] : a[11],
      quoteTokenProgram: isToken2022 ? a[11] : a[12],
      name,
      symbol,
      decimals,
      curve,
      totalLockedAmount,
      transferFee,
      sameTxBuysQuote: ixs
        .filter((b) => b.programId === LAUNCHLAB_PROGRAM && startsWith(b.data, IX.buyExactIn) && b.accounts[4] === poolState)
        .map((b) => new Reader(b.data, 8).u64()),
    };
  }
  return undefined;
}
