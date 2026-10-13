import type { Source } from './config.js';

/** Instrucción normalizada (igual venga de WebSocket+RPC, gRPC o shreds). */
export interface RawIx {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

/** Datos de un pool de Raydium LaunchLab extraídos de la instrucción de creación. */
export interface LaunchLabLaunch {
  poolState: string;
  globalConfig: string;
  platformConfig: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Solo para curvas de producto constante (las más comunes). */
  curve?: { supply: bigint; totalBaseSell: bigint; totalQuoteFundRaising: bigint };
  totalLockedAmount: bigint;
  /** Transfer fee Token-2022 fijada al crear el mint (config "reward" de StonkFun). */
  transferFee?: { bps: number; max: bigint };
  /** Compras hechas en la misma transacción de creación (dev buy), en unidades de quote. */
  sameTxBuysQuote: bigint[];
}

export interface NewToken {
  mint: string;
  source: Source;
  signature: string;
  detectedAt: number;
  launchlab?: LaunchLabLaunch;
}

export type Venue = 'jupiter' | 'launchlab';

export interface Position {
  mint: string;
  symbol?: string;
  source: Source;
  /** Dónde se vende: en la curva de LaunchLab (mientras siga activa) o vía Jupiter. */
  venue: Venue;
  /** Token con el que se pagó (SOL, SPYx…). El PnL se mide en este token. */
  quoteMint: string;
  quoteDecimals: number;
  tokenAmount: bigint;
  costQuote: bigint;
  openedAt: number;
  transferFee?: { bps: number; max: bigint };
  launchlab?: LaunchLabLaunch;
  selling?: boolean;
}
