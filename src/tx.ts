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

/** Instrucciones de compute budget: límite de CU y precio por CU según el tope de priority fee. */
export function computeBudgetIxs(): TransactionInstruction[] {
  const microLamports = Math.floor((config.priorityFeeMaxLamports * 1_000_000) / config.computeUnitLimit);
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

/** Firma, envía y confirma una transacción construida por nosotros. */
export async function sendInstructions(
  connection: Connection,
  blockhashes: BlockhashCache,
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await blockhashes.get();
  const message = new TransactionMessage({
    payerKey: config.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [...computeBudgetIxs(), ...ixs, ...(config.jitoEnabled ? [jitoTipIx()] : [])],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([config.wallet]);
  return sendAndConfirm(connection, tx, lastValidBlockHeight, config.jitoEnabled);
}

/** Envía una transacción ya firmada (nuestra o de Jupiter) y espera a que se confirme. */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
  viaJito = false,
): Promise<string> {
  const raw = Buffer.from(tx.serialize());
  // Con Jito se envía por los dos caminos a la vez: la firma es la misma, solo entra una.
  if (viaJito) sendJito(raw).catch((e) => log.warn((e as Error).message));
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  log.info(`Tx enviada: https://solscan.io/tx/${signature}`);
  const res = await connection.confirmTransaction(
    { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (res.value.err) throw new Error(`Tx ${signature} falló: ${JSON.stringify(res.value.err)}`);
  return signature;
}
