import { Commitment, Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import type { LaunchLabLaunch } from '../types.js';
import { applyBuy, constantCurveInit, CurvePool, FeeRates, feeRates } from './curve.js';
import {
  CurveType,
  decodeGlobalConfig,
  decodePlatformConfig,
  decodePoolState,
  GlobalConfig,
  PlatformConfig,
  PoolState,
  PoolStatus,
} from './layout.js';

export interface PoolSnapshot {
  pool: CurvePool;
  status: PoolStatus;
  curveType: CurveType;
  fees: FeeRates;
  baseDecimals: number;
  quoteDecimals: number;
  platformName: string;
  /** 'onchain' = leído de la cuenta; 'estimated' = reconstruido desde la instrucción de creación. */
  origin: 'onchain' | 'estimated';
}

/** Lee cuentas de LaunchLab. Las configs (global/plataforma) casi nunca cambian, así que se cachean. */
export class LaunchLabClient {
  private globals = new Map<string, Promise<GlobalConfig>>();
  private platforms = new Map<string, Promise<PlatformConfig>>();
  private decimals = new Map<string, Promise<number>>();

  constructor(private readonly connection: Connection) {}

  globalConfig(address: string): Promise<GlobalConfig> {
    return this.cached(this.globals, address, decodeGlobalConfig);
  }

  platformConfig(address: string): Promise<PlatformConfig> {
    return this.cached(this.platforms, address, decodePlatformConfig);
  }

  async poolState(address: string, commitment: Commitment = 'confirmed'): Promise<PoolState | undefined> {
    const info = await this.connection.getAccountInfo(new PublicKey(address), commitment);
    return info ? decodePoolState(info.data) : undefined;
  }

  mintDecimals(mint: string): Promise<number> {
    let p = this.decimals.get(mint);
    if (!p) {
      p = this.connection.getParsedAccountInfo(new PublicKey(mint)).then((r) => {
        const d = (r.value?.data as ParsedAccountData | undefined)?.parsed?.info?.decimals;
        if (typeof d !== 'number') throw new Error(`No se pudieron leer los decimales de ${mint}`);
        return d;
      });
      p.catch(() => this.decimals.delete(mint));
      this.decimals.set(mint, p);
    }
    return p;
  }

  /**
   * Estado actual del pool listo para calcular precios. Si la cuenta aún no existe
   * (detección muy temprana), lo reconstruye desde los parámetros de la instrucción.
   */
  async snapshot(launch: LaunchLabLaunch, commitment: Commitment = 'confirmed'): Promise<PoolSnapshot> {
    const [global, platform, state] = await Promise.all([
      this.globalConfig(launch.globalConfig),
      this.platformConfig(launch.platformConfig),
      this.poolState(launch.poolState, commitment),
    ]);
    const fees = feeRates(global, platform);
    const common = { curveType: global.curveType, fees, platformName: platform.name };

    if (state) {
      return {
        ...common,
        pool: state,
        status: state.status,
        baseDecimals: state.baseDecimals,
        quoteDecimals: state.quoteDecimals,
        origin: 'onchain',
      };
    }

    if (global.curveType !== CurveType.Constant || !launch.curve) {
      throw new Error('Pool aún no visible on-chain y la curva no es de producto constante');
    }
    let pool: CurvePool = {
      ...constantCurveInit({ ...launch.curve, totalLockedAmount: launch.totalLockedAmount, migrateFee: global.migrateFee }),
      realBase: 0n,
      realQuote: 0n,
      totalBaseSell: launch.curve.totalBaseSell,
      totalQuoteFundRaising: launch.curve.totalQuoteFundRaising,
    };
    for (const quoteIn of launch.sameTxBuysQuote) pool = applyBuy(global.curveType, pool, quoteIn, fees);
    return {
      ...common,
      pool,
      status: PoolStatus.Fund,
      baseDecimals: launch.decimals,
      quoteDecimals: await this.mintDecimals(launch.quoteMint),
      origin: 'estimated',
    };
  }

  private cached<T>(cache: Map<string, Promise<T>>, address: string, decode: (d: Uint8Array) => T): Promise<T> {
    let p = cache.get(address);
    if (!p) {
      p = this.connection.getAccountInfo(new PublicKey(address)).then((info) => {
        if (!info) throw new Error(`Cuenta ${address} no encontrada`);
        return decode(info.data);
      });
      p.catch(() => cache.delete(address)); // no cachear errores
      cache.set(address, p);
    }
    return p;
  }
}

/** Precio de 1 token en unidades del quote (p. ej. SPYx por token). */
export function spotPrice(s: Pick<PoolSnapshot, 'pool' | 'curveType' | 'baseDecimals' | 'quoteDecimals'>): number {
  const { pool } = s;
  const [quote, base] =
    s.curveType === CurveType.Constant
      ? [pool.virtualQuote + pool.realQuote, pool.virtualBase - pool.realBase]
      : [pool.virtualQuote, pool.virtualBase];
  return (Number(quote) / Number(base)) * 10 ** (s.baseDecimals - s.quoteDecimals);
}
