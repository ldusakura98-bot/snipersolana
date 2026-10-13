import {
  ComputeBudgetProgram,
  Connection,
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
    instructions: [...computeBudgetIxs(), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([config.wallet]);
  return sendAndConfirm(connection, tx, lastValidBlockHeight);
}

/** Envía una transacción ya firmada (nuestra o de Jupiter) y espera a que se confirme. */
export async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  lastValidBlockHeight: number,
): Promise<string> {
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  log.info(`Tx enviada: https://solscan.io/tx/${signature}`);
  const res = await connection.confirmTransaction(
    { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (res.value.err) throw new Error(`Tx ${signature} falló: ${JSON.stringify(res.value.err)}`);
  return signature;
}
