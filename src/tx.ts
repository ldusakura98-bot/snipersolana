import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Mantiene un blockhash reciente en memoria para no pedirlo en cada compra
 * (ahorra un viaje al RPC en el momento crítico).
 */
export class BlockhashCache {
  private current?: { blockhash: string; lastValidBlockHeight: number };
  private timer?: NodeJS.Timeout;

  constructor(private readonly connection: Connection) {}

  async start() {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch(() => {}), 2_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  async get() {
    return this.current ?? (await this.refresh());
  }

  private async refresh() {
    this.current = await this.connection.getLatestBlockhash('confirmed');
    return this.current;
  }
}

/**
 * Priority fee dinámico: percentil de las comisiones de prioridad recientes de la red
 * (getRecentPrioritizationFees), con suelo y techo. Se refresca en segundo plano para no
 * añadir latencia a la compra.
 */
export class PriorityFees {
  /** micro-lamports por unidad de cómputo. */
  private microLamports = PriorityFees.fromLamports(config.priorityFeeMaxLamports);
  private timer?: NodeJS.Timeout;

  constructor(private readonly connection: Connection) {}

  static fromLamports(lamports: number): number {
    return Math.floor((lamports * 1_000_000) / config.computeUnitLimit);
  }

  async start() {
    if (config.priorityFeeMode !== 'dynamic') return;
    await this.refresh().catch((e) => log.warn(`Priority fee dinámico: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.refresh().catch(() => {}), 10_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Precio por CU según urgencia: 'normal' = dinámico (o el tope en modo fijo), 'low' = suelo. */
  price(urgency: Urgency): number {
    if (urgency === 'low') return PriorityFees.fromLamports(config.priorityFeeMinLamports);
    return this.microLamports;
  }

  private async refresh() {
    const fees = (await this.connection.getRecentPrioritizationFees()).map((f) => f.prioritizationFee).sort((a, b) => a - b);
    if (fees.length === 0) return;
    const pctl = fees[Math.min(fees.length - 1, Math.floor((config.priorityFeePercentile / 100) * fees.length))];
    const min = PriorityFees.fromLamports(config.priorityFeeMinLamports);
    const max = PriorityFees.fromLamports(config.priorityFeeMaxLamports);
    this.microLamports = Math.min(max, Math.max(min, pctl));
  }
}

export type Urgency = 'normal' | 'low';

/** Instrucciones de compute budget: límite de CU y precio por CU. */
export function computeBudgetIxs(microLamports = PriorityFees.fromLamports(config.priorityFeeMaxLamports)): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/** Cuentas oficiales de propinas de Jito; se elige una al azar para repartir la carga. */
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export function jitoTipIx(): TransactionInstruction {
  const to = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  return SystemProgram.transfer({
    fromPubkey: config.wallet.publicKey,
    toPubkey: new PublicKey(to),
    lamports: config.jitoTipLamports,
  });
}

/** Envía la tx al block engine de Jito (llega directa al líder, con propina). */
async function sendJito(raw: Buffer): Promise<void> {
  const res = await fetch(`${config.jitoUrl}/api/v1/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [raw.toString('base64'), { encoding: 'base64' }],
    }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (!res.ok || body.error) throw new Error(`Jito: ${body.error?.message ?? res.status}`);
}

export interface SendContext {
  connection: Connection;
  blockhashes: BlockhashCache;
  fees: PriorityFees;
}

/** Firma, envía y confirma una transacción construida por nosotros. */
export async function sendInstructions(
  ctx: SendContext,
  ixs: TransactionInstruction[],
  urgency: Urgency = 'normal',
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await ctx.blockhashes.get();
  const jito = config.jitoEnabled && urgency === 'normal';
  const message = new TransactionMessage({
    payerKey: config.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [...computeBudgetIxs(ctx.fees.price(urgency)), ...ixs, ...(jito ? [jitoTipIx()] : [])],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([config.wallet]);
  return sendAndConfirm(ctx.connection, tx, lastValidBlockHeight, jito);
}

/**
 * Envía una transacción ya firmada (nuestra o de Jupiter) y espera a que se confirme.
 * Mientras no confirma, la reenvía cada REBROADCAST_INTERVAL_MS: los RPC descartan txs en
 * momentos de congestión y reenviar la misma firma (sin coste extra) mejora mucho la tasa de entrada.
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  viaJito = false,
): Promise<string> {
  const raw = Buffer.from(tx.serialize());
  const send = () => {
    // Con Jito se envía por los dos caminos a la vez: la firma es la misma, solo entra una.
    if (viaJito) sendJito(raw).catch((e) => log.warn((e as Error).message));
    return connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  };

  const signature = await send();
  log.info(`Tx enviada: https://solscan.io/tx/${signature}`);
  const rebroadcast = setInterval(() => void send().catch(() => {}), config.rebroadcastIntervalMs);
  try {
    const res = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (res.value.err) throw new Error(`Tx ${signature} falló: ${JSON.stringify(res.value.err)}`);
    return signature;
  } finally {
    clearInterval(rebroadcast);
  }
}
