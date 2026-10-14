import { Connection } from '@solana/web3.js';
import { config, WSOL_MINT } from './config.js';
import { checkMint, MintCheck } from './filters.js';
import { getQuote } from './jupiter.js';
import { LaunchLabClient, spotPrice } from './launchlab/client.js';
import { curveProgressPct } from './launchlab/curve.js';
import { LAUNCHLAB_AUTHORITY } from './launchlab/instructions.js';
import { CurveType, PoolStatus } from './launchlab/layout.js';
import { log } from './logger.js';
import { formatAmount, PositionManager } from './positions.js';
import { RiskManager } from './risk.js';
import { TradeStats } from './stats.js';
import { startGrpcStream } from './stream/grpc.js';
import { startWebsocketStream } from './stream/websocket.js';
import { LAMPORTS_PER_SOL, Trader } from './trader.js';
import { BlockhashCache, PriorityFees, SendContext } from './tx.js';
import type { NewToken } from './types.js';

const connection = new Connection(config.rpcUrl, { wsEndpoint: config.wsUrl, commitment: 'confirmed' });
const blockhashes = new BlockhashCache(connection);
const launchlab = new LaunchLabClient(connection);
const fees = new PriorityFees(connection);
const sendCtx: SendContext = { connection, blockhashes, fees };
const trader = new Trader(connection, launchlab, sendCtx);
/** Lanzamientos recientes por creador, para saltar a quien lanza en serie. */
const creatorLaunches = new Map<string, number[]>();

/** Registra el lanzamiento y devuelve cuántos ha hecho el creador en las últimas 24 h (incluido este). */
function countCreatorLaunch(creator: string): number {
  const since = Date.now() - 86_400_000;
  const recent = (creatorLaunches.get(creator) ?? []).filter((t) => t >= since);
  recent.push(Date.now());
  creatorLaunches.set(creator, recent);
  if (creatorLaunches.size > 50_000) creatorLaunches.clear();
  return recent.length;
}
const risk = new RiskManager(
  {
    maxDailyLossSol: config.maxDailyLossSol,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    cooldownMinutes: config.cooldownMinutes,
  },
  config.riskFile,
);
const stats = new TradeStats(config.statsFile);
const positions = new PositionManager(connection, trader, risk, stats);
let pendingBuys = 0;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const quoteLabel = (mint: string) => (mint === WSOL_MINT ? 'SOL' : short(mint));
const skip = (reason: string) => log.info(`  ↳ descartado: ${reason}`);

/** StonkFun / LaunchLab: compra directa en la curva (sin Jupiter, más rápido y sin depender de su indexado). */
async function snipeLaunchLab(t: NewToken, creatorLaunchCount: number) {
  const l = t.launchlab!;
  const s = await launchlab.snapshot(l);
  const quote = quoteLabel(l.quoteMint);
  const progress = curveProgressPct(s.pool);
  const quoteUsd = await trader.quoteUsdPrice(l.quoteMint, s.quoteDecimals);
  const mcapUsd = quoteUsd === undefined ? undefined : spotPrice(s) * (Number(s.supply) / 10 ** s.baseDecimals) * quoteUsd;
  const devBuy = l.sameTxBuysQuote.reduce((a, b) => a + b, 0n);
  log.info(
    `Nuevo token [${t.source}/${s.platformName || short(l.platformConfig)}] ${l.symbol} (${l.name}) ${t.mint}\n` +
      `    par: ${l.symbol}/${quote} | precio: ${spotPrice(s).toExponential(4)} ${quote} | ` +
      `curva: ${progress.toFixed(2)}% de ${formatAmount(s.pool.totalQuoteFundRaising, s.quoteDecimals)} ${quote}` +
      `${mcapUsd !== undefined ? ` | MC: $${Math.round(mcapUsd).toLocaleString('en-US')}` : ''}` +
      `${devBuy > 0n ? ` | dev buy: ${formatAmount(devBuy, s.quoteDecimals)} ${quote}` : ''}\n` +
      `    tx: https://solscan.io/tx/${t.signature} (${Date.now() - t.detectedAt} ms)`,
  );

  if (config.maxCreatorLaunches24h > 0 && creatorLaunchCount > config.maxCreatorLaunches24h) {
    return skip(`el creador ${short(l.creator)} ya lanzó ${creatorLaunchCount} tokens en 24 h (máx ${config.maxCreatorLaunches24h})`);
  }
  if (s.status !== PoolStatus.Fund) return skip(`la curva ya no está activa (${PoolStatus[s.status]})`);
  if (s.curveType === CurveType.Linear) return skip('curva lineal (no soportada)');
  if (progress > config.maxCurveProgressPct) return skip(`curva al ${progress.toFixed(1)}% (máx ${config.maxCurveProgressPct}%)`);
  if (config.maxEntryMcapUsd > 0) {
    if (mcapUsd === undefined) return skip(`no se pudo calcular el market cap (sin precio USD de ${quote})`);
    if (mcapUsd > config.maxEntryMcapUsd) return skip(`market cap $${Math.round(mcapUsd)} > máximo $${config.maxEntryMcapUsd}`);
  }

  // El mint lo crea el propio programa LaunchLab (el creador no conserva authorities) y la transfer fee
  // viene en la instrucción. Con shreds el mint aún no existe, así que no se puede (ni hace falta) leer.
  let mintCheck: MintCheck = { ok: true, transferFee: l.transferFee };
  if (l.transferFee && l.transferFee.bps > config.maxTransferFeeBps) {
    return skip(`transfer fee ${l.transferFee.bps / 100}% > máximo ${config.maxTransferFeeBps / 100}%`);
  }
  if (config.detection !== 'shreds') {
    mintCheck = await checkMint(connection, l.baseMint, [LAUNCHLAB_AUTHORITY.toBase58()]);
    if (!mintCheck.ok) return skip(mintCheck.reason!);
  }

  const quoteIn = await trader.quoteAmountFor(l.quoteMint, s.quoteDecimals);
  if (!quoteIn) return skip(`no se pudo calcular cuánto ${quote} gastar (añádelo a QUOTE_BUY_AMOUNTS)`);
  if (!(await trader.ensureQuoteBalance(l.quoteMint, quoteIn))) {
    return skip(`saldo insuficiente de ${quote} (necesitas ${formatAmount(quoteIn, s.quoteDecimals)}; ver AUTO_SWAP_QUOTE)`);
  }

  const res = await trader.buyLaunchLab(l, s, quoteIn, mintCheck.transferFee);
  log.trade(
    `COMPRADO ${l.symbol}: ${formatAmount(quoteIn, s.quoteDecimals)} ${quote} → ` +
      `${formatAmount(res.tokenAmount, l.decimals)} ${l.symbol} (${Date.now() - t.detectedAt} ms) ${res.signature}`,
  );
  positions.open({
    mint: l.baseMint,
    symbol: l.symbol,
    source: t.source,
    venue: 'launchlab',
    quoteMint: l.quoteMint,
    quoteDecimals: s.quoteDecimals,
    tokenAmount: res.tokenAmount,
    costQuote: quoteIn,
    openedAt: Date.now(),
    transferFee: mintCheck.transferFee,
    launchlab: l,
    entryMcapUsd: mcapUsd,
  });
}

/** pump.fun / Raydium: compra vía Jupiter pagando con SOL. */
async function snipeJupiter(t: NewToken) {
  log.info(`Nuevo token [${t.source}] ${t.mint}`);
  const mintCheck = await checkMint(connection, t.mint);
  if (!mintCheck.ok) return skip(mintCheck.reason!);

  if (config.requireSellRoute) {
    const buyQuote = await getQuote(WSOL_MINT, t.mint, trader.buyLamports);
    const sellQuote = buyQuote && (await getQuote(t.mint, WSOL_MINT, BigInt(buyQuote.outAmount)));
    if (!sellQuote) return skip('sin ruta de compra/venta en Jupiter');
  }

  const res = await trader.buyJupiter(t.mint, trader.buyLamports);
  if (!res) return skip('Jupiter no encontró ruta de compra');
  log.trade(`COMPRADO ${t.mint}: ${config.buyAmountSol} SOL → ${res.tokenAmount} unidades (${Date.now() - t.detectedAt} ms) ${res.signature}`);
  positions.open({
    mint: t.mint,
    source: t.source,
    venue: 'jupiter',
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    tokenAmount: res.tokenAmount,
    costQuote: trader.buyLamports,
    openedAt: Date.now(),
    transferFee: mintCheck.transferFee,
  });
}

async function onNewToken(t: NewToken) {
  if (positions.positions.has(t.mint)) return;
  // Se cuenta siempre, aunque luego se descarte por otro motivo: si no, un creador en serie se colaría.
  const creatorLaunchCount = t.launchlab ? countCreatorLaunch(t.launchlab.creator) : 0;
  const allowed = risk.canOpen();
  if (!allowed.ok) {
    log.info(`Nuevo token [${t.source}] ${t.mint} ignorado: ${allowed.reason}`);
    return;
  }
  if (positions.positions.size + pendingBuys >= config.maxOpenPositions) {
    log.info(`Nuevo token [${t.source}] ${t.mint} ignorado: máximo de posiciones abiertas (${config.maxOpenPositions})`);
    return;
  }
  pendingBuys++;
  try {
    await (t.launchlab ? snipeLaunchLab(t, creatorLaunchCount) : snipeJupiter(t));
  } catch (e) {
    log.error(`  ↳ error con ${t.mint}: ${(e as Error).message}`);
  } finally {
    pendingBuys--;
  }
}

async function main() {
  log.info(`Sniper Solana — modo ${config.dryRun ? 'DRY RUN (simulación)' : '⚠️  REAL'}`);
  log.info(`Wallet: ${trader.owner.toBase58()} | fuentes: ${config.sources.join(', ')}`);
  log.info(
    `Compra ${config.buyAmountSol} SOL (o equivalente) | slippage ${config.slippageBps / 100}% | ` +
      `máx ${config.maxOpenPositions} posiciones`,
  );

  log.info(
    `Salidas: SL ${config.stopLossPct}% | trailing ${config.trailingStopPct}% desde máx (tras +${config.trailingActivationPct}%) | ` +
      `parcial ${config.partialTpSellPct}% a +${config.partialTpPct}% | TP ${config.takeProfitPct}% | ` +
      `pérdida diaria máx ${config.maxDailyLossSol} SOL | pausa tras ${config.maxConsecutiveLosses} pérdidas`,
  );
  // Costes fijos de ida y vuelta (priority fee + propina, compra y venta) frente al importe por operación.
  // El rent de la cuenta del token (~0.002 SOL) se recupera al vender si RECLAIM_RENT=true.
  const rentSol = config.reclaimRent ? 0 : 0.0021;
  const fixedCostSol = (2 * (config.priorityFeeMaxLamports + (config.jitoEnabled ? config.jitoTipLamports : 0))) / 1e9 + rentSol;
  const fixedCostPct = (fixedCostSol / config.buyAmountSol) * 100;
  if (fixedCostPct > 5) {
    log.warn(
      `Costes fijos de hasta ${fixedCostSol} SOL por operación = ${fixedCostPct.toFixed(1)}% de BUY_AMOUNT_SOL. ` +
        'Sube BUY_AMOUNT_SOL o baja PRIORITY_FEE_MAX_LAMPORTS/JITO_TIP_LAMPORTS.',
    );
  }

  if (!config.dryRun) {
    const balance = await connection.getBalance(trader.owner);
    log.info(`Saldo: ${(balance / Number(LAMPORTS_PER_SOL)).toFixed(4)} SOL`);
    if (BigInt(balance) < trader.buyLamports) throw new Error('Saldo insuficiente para una compra');
  }

  await blockhashes.start();
  await fees.start();
  positions.load();
  positions.start();
  stats.logSummary(30);
  if (config.statsSummaryMinutes > 0) {
    setInterval(() => {
      stats.logSummary(1);
      stats.logSummary(7);
    }, config.statsSummaryMinutes * 60_000);
  }
  const onToken = (t: NewToken) => void onNewToken(t);
  log.info(`Detección: ${config.detection}${config.jitoEnabled ? ' | envío: RPC + Jito' : ''}`);
  const stopStream =
    config.detection === 'websocket'
      ? startWebsocketStream(connection, config.sources, onToken)
      : startGrpcStream(config.detection, config.grpcUrl!, config.grpcToken, config.sources, onToken);

  const shutdown = async () => {
    log.info('Deteniendo...');
    await positions.stop();
    blockhashes.stop();
    fees.stop();
    await stopStream();
    if (positions.positions.size > 0) {
      log.warn(`Quedan ${positions.positions.size} posiciones abiertas (guardadas en ${config.positionsFile}; se retoman al reiniciar)`);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
