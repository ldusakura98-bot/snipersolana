import { CurveType, GlobalConfig, PlatformConfig, PoolState, PoolStatus } from './layout.js';

/** Matemática de la curva de LaunchLab, portada del SDK oficial de Raydium (raydium-sdk-V2). */

export const FEE_RATE_DENOMINATOR = 1_000_000n;

export type CurvePool = Pick<
  PoolState,
  'virtualBase' | 'virtualQuote' | 'realBase' | 'realQuote' | 'totalBaseSell' | 'totalQuoteFundRaising'
>;

export interface FeeRates {
  protocol: bigint;
  platform: bigint;
  creator: bigint;
}

export interface TransferFee {
  bps: number;
  max: bigint;
}

export const feeRates = (g: GlobalConfig, p: PlatformConfig): FeeRates => ({
  protocol: g.tradeFeeRate,
  platform: p.feeRate,
  creator: p.creatorFeeRate,
});

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const totalRate = (f: FeeRates) => f.protocol + f.platform + f.creator;
const fee = (amount: bigint, rate: bigint) => ceilDiv(amount * rate, FEE_RATE_DENOMINATOR);

export function transferFeeOf(amount: bigint, tf?: TransferFee): bigint {
  if (!tf || tf.bps === 0) return 0n;
  const f = ceilDiv(amount * BigInt(tf.bps), 10_000n);
  return f > tf.max ? tf.max : f;
}

function curveOut(curveType: CurveType, pool: CurvePool, amountIn: bigint, side: 'buy' | 'sell'): bigint {
  if (curveType === CurveType.Constant) {
    const baseReserve = pool.virtualBase - pool.realBase;
    const quoteReserve = pool.virtualQuote + pool.realQuote;
    const [inRes, outRes] = side === 'buy' ? [quoteReserve, baseReserve] : [baseReserve, quoteReserve];
    return (amountIn * outRes) / (inRes + amountIn);
  }
  if (curveType === CurveType.Fixed) {
    return side === 'buy'
      ? (pool.virtualBase * amountIn) / pool.virtualQuote
      : (pool.virtualQuote * amountIn) / pool.virtualBase;
  }
  throw new Error('Curva lineal no soportada');
}

/** Tokens (base) que se reciben al gastar `quoteIn` en la curva. */
export function quoteBuy(
  curveType: CurveType,
  pool: CurvePool,
  quoteIn: bigint,
  fees: FeeRates,
  baseTransferFee?: TransferFee,
): { baseOut: bigint; baseReceived: bigint } {
  const amountLessFee = quoteIn - fee(quoteIn, totalRate(fees));
  let baseOut = curveOut(curveType, pool, amountLessFee, 'buy');
  const remaining = pool.totalBaseSell - pool.realBase;
  if (baseOut > remaining) baseOut = remaining;
  return { baseOut, baseReceived: baseOut - transferFeeOf(baseOut, baseTransferFee) };
}

/** Quote que se recibe al vender `baseIn` tokens en la curva. */
export function quoteSell(
  curveType: CurveType,
  pool: CurvePool,
  baseIn: bigint,
  fees: FeeRates,
  baseTransferFee?: TransferFee,
): bigint {
  const baseNet = baseIn - transferFeeOf(baseIn, baseTransferFee);
  const quoteOut = curveOut(curveType, pool, baseNet, 'sell');
  return quoteOut - fee(quoteOut, totalRate(fees));
}

/** Aplica una compra al estado del pool (para simular dev buys de la misma transacción). */
export function applyBuy(curveType: CurveType, pool: CurvePool, quoteIn: bigint, fees: FeeRates): CurvePool {
  const { baseOut } = quoteBuy(curveType, pool, quoteIn, fees);
  const netQuote = quoteIn - fee(quoteIn, totalRate(fees));
  return { ...pool, realBase: pool.realBase + baseOut, realQuote: pool.realQuote + netQuote };
}

/** Reservas virtuales iniciales de una curva de producto constante (getInitParam del SDK). */
export function constantCurveInit(p: {
  supply: bigint;
  totalBaseSell: bigint;
  totalQuoteFundRaising: bigint;
  totalLockedAmount: bigint;
  migrateFee: bigint;
}): { virtualBase: bigint; virtualQuote: bigint } {
  const supplyMinusSellLocked = p.supply - p.totalBaseSell - p.totalLockedAmount;
  const tfMinusMf = p.totalQuoteFundRaising - p.migrateFee;
  if (supplyMinusSellLocked <= 0n || tfMinusMf <= 0n) throw new Error('Parámetros de curva no válidos');
  const numerator = (tfMinusMf * p.totalBaseSell * p.totalBaseSell) / supplyMinusSellLocked;
  const denominator = (tfMinusMf * p.totalBaseSell) / supplyMinusSellLocked - p.totalQuoteFundRaising;
  if (denominator <= 0n) throw new Error('Parámetros de curva no válidos');
  return {
    virtualBase: numerator / denominator,
    virtualQuote: (p.totalQuoteFundRaising * p.totalQuoteFundRaising) / denominator,
  };
}

/** Progreso de la curva en % (quote recaudado / objetivo). */
export function curveProgressPct(pool: CurvePool): number {
  if (pool.totalQuoteFundRaising === 0n) return 0;
  return Number((pool.realQuote * 10_000n) / pool.totalQuoteFundRaising) / 100;
}

export const isCurveActive = (pool: Pick<PoolState, 'status'>) => pool.status === PoolStatus.Fund;
