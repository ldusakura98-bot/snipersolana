import 'dotenv/config';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export type Source = 'pumpfun' | 'raydium';

function str(name: string, def?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (def !== undefined) return def;
  throw new Error(`Falta la variable de entorno ${name}`);
}

function num(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} debe ser un número (recibido "${raw}")`);
  return n;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return def;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function loadKeypair(raw: string): Keypair {
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw));
}

const dryRun = bool('DRY_RUN', true);
const privateKey = process.env.PRIVATE_KEY?.trim();
if (!dryRun && !privateKey) throw new Error('PRIVATE_KEY es obligatoria cuando DRY_RUN=false');

const sources = str('SOURCES', 'pumpfun')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
for (const s of sources) {
  if (s !== 'pumpfun' && s !== 'raydium') throw new Error(`Fuente desconocida en SOURCES: ${s}`);
}

export const config = {
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  wsUrl: str('WS_URL', 'wss://api.mainnet-beta.solana.com'),
  // En DRY_RUN sin clave se usa una wallet efímera solo para pedir quotes.
  wallet: privateKey ? loadKeypair(privateKey) : Keypair.generate(),
  dryRun,
  sources: sources as Source[],

  buyAmountSol: num('BUY_AMOUNT_SOL', 0.01),
  slippageBps: num('SLIPPAGE_BPS', 1500),
  priorityFeeMaxLamports: num('PRIORITY_FEE_MAX_LAMPORTS', 500_000),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),

  requireMintAuthorityRevoked: bool('REQUIRE_MINT_AUTHORITY_REVOKED', true),
  requireFreezeAuthorityRevoked: bool('REQUIRE_FREEZE_AUTHORITY_REVOKED', true),
  requireSellRoute: bool('REQUIRE_SELL_ROUTE', true),

  takeProfitPct: num('TAKE_PROFIT_PCT', 100),
  stopLossPct: num('STOP_LOSS_PCT', 30),
  maxHoldSeconds: num('MAX_HOLD_SECONDS', 600),
  priceCheckIntervalMs: num('PRICE_CHECK_INTERVAL_MS', 3000),

  jupiterApiUrl: str('JUPITER_API_URL', 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, ''),
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || undefined,
};

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
