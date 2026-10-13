import { Connection } from '@solana/web3.js';
import { config, WSOL_MINT } from './config.js';
import { checkMint } from './filters.js';
import { getQuote } from './jupiter.js';
import { NewToken, startListeners } from './listener.js';
import { log } from './logger.js';
import { PositionManager } from './positions.js';
import { LAMPORTS_PER_SOL, Trader } from './trader.js';

const connection = new Connection(config.rpcUrl, { wsEndpoint: config.wsUrl, commitment: 'confirmed' });
const trader = new Trader(connection);
const positions = new PositionManager(trader);
const buyLamports = BigInt(Math.round(config.buyAmountSol * Number(LAMPORTS_PER_SOL)));
let pendingBuys = 0;

async function onNewToken(t: NewToken) {
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
  log.info(`Wallet: ${trader.owner.toBase58()}`);
  log.info(
    `Compra ${config.buyAmountSol} SOL | slippage ${config.slippageBps / 100}% | ` +
      `TP ${config.takeProfitPct}% | SL ${config.stopLossPct}% | máx ${config.maxOpenPositions} posiciones`,
  );

  if (!config.dryRun) {
    const balance = await connection.getBalance(trader.owner);
    log.info(`Saldo: ${(balance / Number(LAMPORTS_PER_SOL)).toFixed(4)} SOL`);
    if (BigInt(balance) < buyLamports) throw new Error('Saldo insuficiente para una compra');
  }

  const stopListeners = startListeners(connection, config.sources, (t) => void onNewToken(t));
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
