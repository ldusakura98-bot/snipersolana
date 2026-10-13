import 'dotenv/config';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export const SOURCES = ['pumpfun', 'raydium', 'stonkfun', 'launchlab'] as const;
export type Source = (typeof SOURCES)[number];
export const DETECTION_MODES = ['websocket', 'grpc', 'shreds'] as const;
export type DetectionMode = (typeof DETECTION_MODES)[number];

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RAYDIUM_AMM_V4_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
/** platform_config de StonkFun en LaunchLab: config "reward" (con transfer fee) y config estándar. */
export const STONKFUN_PLATFORM_CONFIGS_DEFAULT = [
  '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt',
  '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7',
];

function str(name: string, def?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (def !== undefined) return def;
  throw new Error(`Falta la variable de entorno ${name}`);
}

function opt(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
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

function list(name: string, def: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name}: valor "${value}" no válido (opciones: ${allowed.join(', ')})`);
  }
  return value as T;
}

function loadKeypair(raw: string): Keypair {
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  return Keypair.fromSecretKey(bs58.decode(raw));
}

/** "MINT=1.5,MINT2=0.2" → Map(mint → importe en unidades UI). */
function quoteAmounts(name: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const pair of list(name, [])) {
    const [mint, amount] = pair.split('=').map((s) => s.trim());
    const n = Number(amount);
    if (!mint || !Number.isFinite(n) || n <= 0) throw new Error(`${name}: entrada no válida "${pair}"`);
    m.set(mint, n);
  }
  return m;
}

const dryRun = bool('DRY_RUN', true);
const privateKey = opt('PRIVATE_KEY');
if (!dryRun && !privateKey) throw new Error('PRIVATE_KEY es obligatoria cuando DRY_RUN=false');

const detection = oneOf('DETECTION', str('DETECTION', 'websocket').toLowerCase(), DETECTION_MODES);
const grpcUrl = opt('GRPC_URL');
if (detection !== 'websocket' && !grpcUrl) throw new Error(`GRPC_URL es obligatoria con DETECTION=${detection}`);

export const config = {
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  wsUrl: str('WS_URL', 'wss://api.mainnet-beta.solana.com'),
  detection,
  grpcUrl,
  grpcToken: opt('GRPC_TOKEN'),

  // En DRY_RUN sin clave se usa una wallet efímera solo para calcular quotes.
  wallet: privateKey ? loadKeypair(privateKey) : Keypair.generate(),
  dryRun,
  sources: list('SOURCES', ['stonkfun']).map((s) => oneOf('SOURCES', s.toLowerCase(), SOURCES)),
  stonkfunPlatformConfigs: list('STONKFUN_PLATFORM_CONFIGS', STONKFUN_PLATFORM_CONFIGS_DEFAULT),

  buyAmountSol: num('BUY_AMOUNT_SOL', 0.01),
  /** Importe fijo por quote token para LaunchLab/StonkFun. Si no hay entrada, se convierte BUY_AMOUNT_SOL vía Jupiter. */
  quoteBuyAmounts: quoteAmounts('QUOTE_BUY_AMOUNTS'),
  /** Si falta saldo del quote token (p. ej. SPYx), compra lo necesario con SOL vía Jupiter antes de snipear. */
  autoSwapQuote: bool('AUTO_SWAP_QUOTE', false),
  slippageBps: num('SLIPPAGE_BPS', 1500),
  priorityFeeMaxLamports: num('PRIORITY_FEE_MAX_LAMPORTS', 500_000),
  computeUnitLimit: num('COMPUTE_UNIT_LIMIT', 250_000),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),

  requireMintAuthorityRevoked: bool('REQUIRE_MINT_AUTHORITY_REVOKED', true),
  requireFreezeAuthorityRevoked: bool('REQUIRE_FREEZE_AUTHORITY_REVOKED', true),
  requireSellRoute: bool('REQUIRE_SELL_ROUTE', true),
  /** Comisión de transferencia Token-2022 máxima aceptada (bps). StonkFun "reward" usa 100–300. */
  maxTransferFeeBps: num('MAX_TRANSFER_FEE_BPS', 300),
  /** No compra si la curva ya está más llena que esto (dev buy grande / llegamos tarde). */
  maxCurveProgressPct: num('MAX_CURVE_PROGRESS_PCT', 20),

  takeProfitPct: num('TAKE_PROFIT_PCT', 100),
  stopLossPct: num('STOP_LOSS_PCT', 30),
  maxHoldSeconds: num('MAX_HOLD_SECONDS', 600),
  priceCheckIntervalMs: num('PRICE_CHECK_INTERVAL_MS', 3000),
  positionsFile: str('POSITIONS_FILE', 'positions.json'),

  jitoEnabled: bool('JITO_ENABLED', false),
  jitoUrl: str('JITO_URL', 'https://mainnet.block-engine.jito.wtf').replace(/\/$/, ''),
  jitoTipLamports: num('JITO_TIP_LAMPORTS', 100_000),

  jupiterApiUrl: str('JUPITER_API_URL', 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, ''),
  jupiterApiKey: opt('JUPITER_API_KEY'),

  telegramBotToken: opt('TELEGRAM_BOT_TOKEN'),
  telegramChatId: opt('TELEGRAM_CHAT_ID'),
};
