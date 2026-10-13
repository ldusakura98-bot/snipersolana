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
