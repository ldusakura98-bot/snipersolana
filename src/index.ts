import { Connection } from '@solana/web3.js';
import { config, WSOL_MINT } from './config.js';
import { curveProgressPct } from './launchlab/curve.js';
import { LaunchLabClient, spotPrice } from './launchlab/client.js';
import { PoolStatus } from './launchlab/layout.js';
import { startWebsocketStream } from './stream/websocket.js';
import type { NewToken } from './types.js';
import { checkMint } from './filters.js';
import { getQuote } from './jupiter.js';
import { log } from './logger.js';
import { PositionManager } from './positions.js';
import { LAMPORTS_PER_SOL, Trader } from './trader.js';

const connection = new Connection(config.rpcUrl, { wsEndpoint: config.wsUrl, commitment: 'confirmed' });
const trader = new Trader(connection);
const positions = new PositionManager(trader);
const launchlab = new LaunchLabClient(connection);
const buyLamports = BigInt(Math.round(config.buyAmountSol * Number(LAMPORTS_PER_SOL)));
let pendingBuys = 0;

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const quoteLabel = (mint: string) => (mint === WSOL_MINT ? 'SOL' : short(mint));

/** Muestra un lanzamiento de LaunchLab/StonkFun con su par, precio y progreso de la curva. */
async function describeLaunchLab(t: NewToken) {
  const l = t.launchlab!;
  try {
    const s = await launchlab.snapshot(l);
    const quote = quoteLabel(l.quoteMint);
    const devBuy = l.sameTxBuysQuote.reduce((a, b) => a + b, 0n);
    log.info(
      `Nuevo token [${t.source}/${s.platformName || short(l.platformConfig)}] ${l.symbol} (${l.name}) ${t.mint}\n` +
        `    par: ${l.symbol}/${quote} | precio: ${spotPrice(s).toExponential(4)} ${quote} | ` +
        `curva: ${curveProgressPct(s.pool).toFixed(2)}% de ${Number(s.pool.totalQuoteFundRaising) / 10 ** s.quoteDecimals} ${quote}` +
        `${devBuy > 0n ? ` | dev buy: ${Number(devBuy) / 10 ** s.quoteDecimals} ${quote}` : ''}` +
        `${s.status !== PoolStatus.Fund ? ` | estado: ${PoolStatus[s.status]}` : ''}\n` +
        `    tx: https://solscan.io/tx/${t.signature} (${Date.now() - t.detectedAt} ms)`,
    );
  } catch (e) {
    log.warn(`Nuevo token [${t.source}] ${l.symbol} ${t.mint}: no se pudo leer el pool (${(e as Error).message})`);
  }
}

async function onNewToken(t: NewToken) {
  if (t.launchlab) {
    // La compra en la curva de LaunchLab llega en el siguiente paso; de momento solo observamos.
    await describeLaunchLab(t);
    return;
  }
  log.info(`Nuevo token [${t.source}] ${t.mint}`);

  if (positions.positions.size + pendingBuys >= config.maxOpenPositions) {
    log.info(`  ↳ ignorado: máximo de posiciones abiertas (${config.maxOpenPositions})`);
    return;
  }
  pendingBuys++;
  try {
    const filter = await checkMint(connection, t.mint);
    if (!filter.ok) {
      log.info(`  ↳ descartado: ${filter.reason}`);
      return;
    }

    if (config.requireSellRoute) {
      const buyQuote = await getQuote(WSOL_MINT, t.mint, buyLamports);
      const sellQuote = buyQuote && (await getQuote(t.mint, WSOL_MINT, BigInt(buyQuote.outAmount)));
      if (!sellQuote) {
        log.info('  ↳ descartado: sin ruta de compra/venta en Jupiter');
        return;
      }
    }

    const res = await trader.buy(t.mint, buyLamports);
    if (!res) {
      log.info('  ↳ descartado: Jupiter no encontró ruta de compra');
      return;
    }
    const latency = Date.now() - t.detectedAt;
    log.trade(`COMPRADO ${t.mint}: ${config.buyAmountSol} SOL → ${res.outAmount} unidades (${latency} ms) ${res.signature}`);
    positions.open({ mint: t.mint, tokenAmount: res.outAmount, costLamports: buyLamports, openedAt: Date.now() });
  } catch (e) {
    log.error(`  ↳ error comprando ${t.mint}: ${(e as Error).message}`);
  } finally {
    pendingBuys--;
  }
}

async function main() {
  log.info(`Sniper Solana — modo ${config.dryRun ? 'DRY RUN (simulación)' : '⚠️  REAL'}`);
  log.info(`Wallet: ${trader.owner.toBase58()} | fuentes: ${config.sources.join(', ')}`);
  log.info(
    `Compra ${config.buyAmountSol} SOL | slippage ${config.slippageBps / 100}% | ` +
      `TP ${config.takeProfitPct}% | SL ${config.stopLossPct}% | máx ${config.maxOpenPositions} posiciones`,
  );

  if (!config.dryRun) {
    const balance = await connection.getBalance(trader.owner);
    log.info(`Saldo: ${(balance / Number(LAMPORTS_PER_SOL)).toFixed(4)} SOL`);
    if (BigInt(balance) < buyLamports) throw new Error('Saldo insuficiente para una compra');
  }

  const stopListeners = startWebsocketStream(connection, config.sources, (t) => void onNewToken(t));
  positions.start();

  const shutdown = async () => {
    log.info('Deteniendo...');
    positions.stop();
    await stopListeners();
    if (positions.positions.size > 0) {
      log.warn(`Quedan ${positions.positions.size} posiciones abiertas:`);
      for (const p of positions.positions.values()) log.warn(`  ${p.mint} (${p.tokenAmount} unidades)`);
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
