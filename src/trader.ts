import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { config, WSOL_MINT } from './config.js';
import { buildSwapTx, getQuote } from './jupiter.js';
import { LaunchLabClient, PoolSnapshot } from './launchlab/client.js';
import { feeRates, quoteBuy, quoteSell, TransferFee } from './launchlab/curve.js';
import { buyExactInIx, LaunchLabSwapAccounts, sellExactInIx } from './launchlab/instructions.js';
import { PoolState, PoolStatus } from './launchlab/layout.js';
import { log } from './logger.js';
import { sendAndConfirm, SendContext, sendInstructions } from './tx.js';
import type { LaunchLabLaunch, Position } from './types.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const USDC_MINT = 'EPjFWdd5AufqSSt1wzW6UuKKGxkUZvTUGHvjzTz9Dbmv';
const BPS = 10_000n;
const dryRunSig = () => `dry-run-${Date.now()}`;
const withSlippage = (amount: bigint, bps: number) => (amount * (BPS - BigInt(Math.min(bps, 9_900)))) / BPS;

export interface BuyResult {
  signature: string;
  tokenAmount: bigint;
}

export interface SellResult {
  signature: string;
  quoteOut: bigint;
}

export interface SellOptions {
  /** Slippage aceptado en esta venta (las ventas urgentes o reintentadas usan más). */
  slippageBps?: number;
  /** Estado del pool ya conocido (de la suscripción): evita leerlo del RPC. */
  pool?: PoolState;
  /** Releer el saldo real de tokens antes de vender (en reintentos). */
  refreshBalance?: boolean;
}

export class Trader {
  private solToQuote = new Map<string, { amount: bigint; at: number }>();
  private usdPrices = new Map<string, { price: number; at: number }>();

  constructor(
    private readonly connection: Connection,
    private readonly launchlab: LaunchLabClient,
    private readonly ctx: SendContext,
  ) {}

  get owner(): PublicKey {
    return config.wallet.publicKey;
  }

  get buyLamports(): bigint {
    return BigInt(Math.round(config.buyAmountSol * Number(LAMPORTS_PER_SOL)));
  }

  // ───────────────────────────── Jupiter (pump.fun, Raydium, tokens migrados) ─────────────────────────────

  async buyJupiter(mint: string, lamports: bigint): Promise<BuyResult | undefined> {
    const quote = await getQuote(WSOL_MINT, mint, lamports);
    if (!quote) return undefined;
    if (config.dryRun) return { signature: dryRunSig(), tokenAmount: BigInt(quote.outAmount) };
    const signature = await this.executeJupiter(quote);
    return { signature, tokenAmount: (await this.tokenBalance(mint)) || BigInt(quote.outAmount) };
  }

  private async sellJupiter(mint: string, amount: bigint, outputMint: string, slippageBps: number): Promise<SellResult | undefined> {
    const quote = await getQuote(mint, outputMint, amount, slippageBps);
    if (!quote) return undefined;
    const signature = config.dryRun ? dryRunSig() : await this.executeJupiter(quote);
    return { signature, quoteOut: BigInt(quote.outAmount) };
  }

  private async executeJupiter(quote: Awaited<ReturnType<typeof getQuote>> & object): Promise<string> {
    const swapTx = await buildSwapTx(quote, this.owner.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, 'base64'));
    tx.sign([config.wallet]);
    const { lastValidBlockHeight } = await this.ctx.blockhashes.get();
    return sendAndConfirm(this.connection, tx, lastValidBlockHeight);
  }

  // ───────────────────────────── LaunchLab (StonkFun) ─────────────────────────────

  /**
   * Cuánto quote gastar por compra: importe fijo de QUOTE_BUY_AMOUNTS, BUY_AMOUNT_SOL si el par es
   * contra SOL, o el equivalente de BUY_AMOUNT_SOL convertido con Jupiter (cacheado 60 s).
   */
  async quoteAmountFor(quoteMint: string, quoteDecimals: number): Promise<bigint | undefined> {
    if (quoteMint === WSOL_MINT) return this.buyLamports;
    const fixed = config.quoteBuyAmounts.get(quoteMint);
    if (fixed !== undefined) return BigInt(Math.round(fixed * 10 ** quoteDecimals));

    const cached = this.solToQuote.get(quoteMint);
    if (cached && Date.now() - cached.at < 60_000) return cached.amount;
    const q = await getQuote(WSOL_MINT, quoteMint, this.buyLamports, 100);
    if (!q) return undefined;
    const amount = BigInt(q.outAmount);
    this.solToQuote.set(quoteMint, { amount, at: Date.now() });
    return amount;
  }

  /** Precio en USD de 1 unidad del quote token (vía Jupiter → USDC), cacheado 60 s. */
  async quoteUsdPrice(quoteMint: string, quoteDecimals: number): Promise<number | undefined> {
    if (quoteMint === USDC_MINT) return 1;
    const cached = this.usdPrices.get(quoteMint);
    if (cached && Date.now() - cached.at < 60_000) return cached.price;
    const q = await getQuote(quoteMint, USDC_MINT, 10n ** BigInt(quoteDecimals), 100).catch(() => undefined);
    if (!q) return undefined;
    const price = Number(q.outAmount) / 1e6;
    this.usdPrices.set(quoteMint, { price, at: Date.now() });
    return price;
  }

  /** Comprueba que haya saldo del quote token; si falta y AUTO_SWAP_QUOTE=true, lo compra con SOL. */
  async ensureQuoteBalance(quoteMint: string, amount: bigint): Promise<boolean> {
    if (config.dryRun || quoteMint === WSOL_MINT) return true;
    if ((await this.tokenBalance(quoteMint)) >= amount) return true;
    if (!config.autoSwapQuote) return false;

    log.info(`Saldo insuficiente de ${quoteMint}; comprándolo con SOL vía Jupiter...`);
    const quote = await getQuote(WSOL_MINT, quoteMint, (this.buyLamports * 11n) / 10n, 100);
    if (!quote) return false;
    await this.executeJupiter(quote);
    return (await this.tokenBalance(quoteMint)) >= amount;
  }

  async buyLaunchLab(
    launch: LaunchLabLaunch,
    snapshot: PoolSnapshot,
    quoteIn: bigint,
    transferFee?: TransferFee,
  ): Promise<BuyResult> {
    const { baseOut, baseReceived } = quoteBuy(snapshot.curveType, snapshot.pool, quoteIn, snapshot.fees, transferFee);
    if (baseOut <= 0n) throw new Error('La curva no devuelve tokens para ese importe');
    if (config.dryRun) return { signature: dryRunSig(), tokenAmount: baseReceived };

    const a = this.swapAccounts(launch);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(this.owner, a.userBaseToken, this.owner, a.baseMint, a.baseTokenProgram),
      ...this.openQuoteAccount(a, quoteIn),
      buyExactInIx(a, quoteIn, withSlippage(baseOut, config.slippageBps)),
      ...this.closeQuoteAccount(a),
    ];
    const signature = await sendInstructions(this.ctx, ixs);
    return { signature, tokenAmount: (await this.tokenBalance(launch.baseMint)) || baseReceived };
  }

  /**
   * Vende `fraction` (0–1) de la posición: en la curva si sigue activa, si no (token migrado) vía Jupiter.
   * Usa el saldo guardado (leído tras la compra) para no gastar una consulta al RPC en el momento crítico.
   */
  async sell(p: Position, fraction = 1, opts: SellOptions = {}): Promise<(SellResult & { amount: bigint }) | undefined> {
    const held = !config.dryRun && opts.refreshBalance ? await this.tokenBalance(p.mint) : p.tokenAmount;
    const amount = fraction >= 1 ? held : (held * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    if (amount <= 0n) return undefined;
    const slippageBps = opts.slippageBps ?? config.sellSlippageBps;

    const snapshot = await this.launchLabSnapshot(p, opts.pool);
    if (!snapshot) {
      const res = await this.sellJupiter(p.mint, amount, p.quoteMint, slippageBps);
      return res && { ...res, amount };
    }

    const quoteOut = quoteSell(snapshot.curveType, snapshot.pool, amount, snapshot.fees, p.transferFee);
    if (config.dryRun) return { signature: dryRunSig(), quoteOut, amount };

    const a = this.swapAccounts(p.launchlab!);
    const ixs = [
      ...this.openQuoteAccount(a, 0n),
      sellExactInIx(a, amount, withSlippage(quoteOut, slippageBps)),
      ...this.closeQuoteAccount(a),
    ];
    const signature = await sendInstructions(this.ctx, ixs);
    return { signature, quoteOut, amount };
  }

  /**
   * Tras vender todo, cierra las cuentas de token vacías para recuperar el rent (~0.002 SOL cada una).
   * Con Token-2022 + transfer fee, antes hay que mover al mint las comisiones retenidas en la cuenta
   * (harvest, permisionado a cualquiera); si no, el cierre falla. Va con prioridad baja: no es urgente.
   */
  async reclaimRent(mint: string): Promise<number> {
    if (config.dryRun || !config.reclaimRent) return 0;
    const { value } = await this.connection.getParsedTokenAccountsByOwner(this.owner, { mint: new PublicKey(mint) }, 'confirmed');
    const ixs: TransactionInstruction[] = [];
    let lamports = 0;
    for (const { pubkey, account } of value) {
      const info = account.data.parsed.info;
      if (BigInt(info.tokenAmount.amount) !== 0n) continue; // quedan tokens: no se puede cerrar
      const program = account.owner;
      const withheld = (info.extensions as { extension: string; state: any }[] | undefined)?.find(
        (e) => e.extension === 'transferFeeAmount',
      )?.state?.withheldAmount;
      if (withheld && BigInt(withheld) > 0n) {
        ixs.push(createHarvestWithheldTokensToMintInstruction(new PublicKey(mint), [pubkey], program));
      }
      ixs.push(createCloseAccountInstruction(pubkey, this.owner, this.owner, [], program));
      lamports += account.lamports;
    }
    if (ixs.length === 0) return 0;
    await sendInstructions(this.ctx, ixs, 'low');
    return lamports;
  }

  /** Valor de la posición a partir de un PoolState recibido por suscripción (sin pedir nada al RPC). */
  async valueFromPool(p: Position, state: PoolState): Promise<bigint | undefined> {
    if (p.venue !== 'launchlab' || !p.launchlab || state.status !== PoolStatus.Fund) return undefined;
    const [global, platform] = await Promise.all([
      this.launchlab.globalConfig(p.launchlab.globalConfig),
      this.launchlab.platformConfig(p.launchlab.platformConfig),
    ]);
    return quoteSell(global.curveType, state, p.tokenAmount, feeRates(global, platform), p.transferFee);
  }

  /** Convierte una cantidad de quote token a lamports (para medir pérdidas en SOL). */
  async toLamports(quoteMint: string, amount: bigint): Promise<bigint | undefined> {
    if (quoteMint === WSOL_MINT || amount === 0n) return amount;
    const abs = amount < 0n ? -amount : amount;
    const q = await getQuote(quoteMint, WSOL_MINT, abs, 100);
    if (!q) return undefined;
    return amount < 0n ? -BigInt(q.outAmount) : BigInt(q.outAmount);
  }

  /** Valor actual de la posición en unidades del quote token. */
  async value(p: Position): Promise<bigint | undefined> {
    const snapshot = await this.launchLabSnapshot(p);
    if (snapshot) return quoteSell(snapshot.curveType, snapshot.pool, p.tokenAmount, snapshot.fees, p.transferFee);
    const q = await getQuote(p.mint, p.quoteMint, p.tokenAmount);
    return q ? BigInt(q.outAmount) : undefined;
  }

  async tokenBalance(mint: string): Promise<bigint> {
    const { value } = await this.connection.getParsedTokenAccountsByOwner(
      this.owner,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    return value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  /** Snapshot del pool si la posición es de LaunchLab y la curva sigue activa; si no, undefined (→ Jupiter). */
  private async launchLabSnapshot(p: Position, pool?: PoolState): Promise<PoolSnapshot | undefined> {
    if (p.venue !== 'launchlab' || !p.launchlab) return undefined;
    const s = pool ? await this.launchlab.fromState(p.launchlab, pool) : await this.launchlab.snapshot(p.launchlab);
    if (s.status === PoolStatus.Fund) return s;
    log.info(`${p.symbol ?? p.mint}: la curva ha migrado; a partir de ahora se opera vía Jupiter`);
    p.venue = 'jupiter';
    return undefined;
  }

  private swapAccounts(l: LaunchLabLaunch): LaunchLabSwapAccounts {
    const pk = (s: string) => new PublicKey(s);
    const baseMint = pk(l.baseMint);
    const quoteMint = pk(l.quoteMint);
    const baseTokenProgram = pk(l.baseTokenProgram);
    const quoteTokenProgram = pk(l.quoteTokenProgram);
    return {
      payer: this.owner,
      globalConfig: pk(l.globalConfig),
      platformConfig: pk(l.platformConfig),
      poolState: pk(l.poolState),
      userBaseToken: getAssociatedTokenAddressSync(baseMint, this.owner, false, baseTokenProgram),
      userQuoteToken: getAssociatedTokenAddressSync(quoteMint, this.owner, false, quoteTokenProgram),
      baseVault: pk(l.baseVault),
      quoteVault: pk(l.quoteVault),
      baseMint,
      quoteMint,
      baseTokenProgram,
      quoteTokenProgram,
      creator: pk(l.creator),
    };
  }

  /** Crea la cuenta del quote token si hace falta; si el quote es SOL, envuelve `lamports` en WSOL. */
  private openQuoteAccount(a: LaunchLabSwapAccounts, lamports: bigint): TransactionInstruction[] {
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(this.owner, a.userQuoteToken, this.owner, a.quoteMint, a.quoteTokenProgram),
    ];
    if (a.quoteMint.toBase58() === WSOL_MINT && lamports > 0n) {
      ixs.push(
        SystemProgram.transfer({ fromPubkey: this.owner, toPubkey: a.userQuoteToken, lamports }),
        createSyncNativeInstruction(a.userQuoteToken, TOKEN_PROGRAM_ID),
      );
    }
    return ixs;
  }

  /** Si el quote es SOL, cierra la cuenta WSOL para recuperar los SOL. */
  private closeQuoteAccount(a: LaunchLabSwapAccounts): TransactionInstruction[] {
    if (a.quoteMint.toBase58() !== WSOL_MINT) return [];
    return [createCloseAccountInstruction(a.userQuoteToken, this.owner, this.owner, [], TOKEN_PROGRAM_ID)];
  }
}
