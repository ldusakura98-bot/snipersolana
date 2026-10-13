import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { config, WSOL_MINT } from './config.js';
import { buildSwapTx, getQuote, Quote } from './jupiter.js';
import { log } from './logger.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface SwapResult {
  signature: string;
  inAmount: bigint;
  /** Cantidad recibida (real si se pudo medir, si no la del quote). */
  outAmount: bigint;
}

export class Trader {
  constructor(private readonly connection: Connection) {}

  get owner(): PublicKey {
    return config.wallet.publicKey;
  }

  async buy(mint: string, lamports: bigint): Promise<SwapResult | undefined> {
    const quote = await getQuote(WSOL_MINT, mint, lamports);
    if (!quote) return undefined;
    const signature = await this.execute(quote);
    let outAmount = BigInt(quote.outAmount);
    if (!config.dryRun) outAmount = (await this.tokenBalance(mint)) || outAmount;
    return { signature, inAmount: lamports, outAmount };
  }

  async sell(mint: string, amount: bigint): Promise<SwapResult | undefined> {
    const quote = await getQuote(mint, WSOL_MINT, amount);
    if (!quote) return undefined;
    const signature = await this.execute(quote);
    return { signature, inAmount: amount, outAmount: BigInt(quote.outAmount) };
  }

  /** Valor actual en lamports de `amount` tokens (según Jupiter). */
  async valueInLamports(mint: string, amount: bigint): Promise<bigint | undefined> {
    const quote = await getQuote(mint, WSOL_MINT, amount);
    return quote ? BigInt(quote.outAmount) : undefined;
  }

  async tokenBalance(mint: string): Promise<bigint> {
    const { value } = await this.connection.getParsedTokenAccountsByOwner(
      this.owner,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    return value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  private async execute(quote: Quote): Promise<string> {
    if (config.dryRun) return `dry-run-${Date.now()}`;

    const swapTx = await buildSwapTx(quote, this.owner.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, 'base64'));
    tx.sign([config.wallet]);

    const { lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    log.info(`Tx enviada: https://solscan.io/tx/${signature}`);

    const res = await this.connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (res.value.err) throw new Error(`Tx ${signature} falló: ${JSON.stringify(res.value.err)}`);
    return signature;
  }
}
