import { createHash } from 'node:crypto';
import {
  config,
  LAUNCHLAB_PROGRAM,
  PUMPFUN_PROGRAM,
  RAYDIUM_AMM_V4_PROGRAM,
  Source,
  WSOL_MINT,
} from './config.js';
import { decodeLaunchLabCreate } from './launchlab/layout.js';
import type { NewToken, RawIx } from './types.js';

const anchorDisc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const PUMP_CREATE_DISCS = [anchorDisc('create'), anchorDisc('create_v2')];
const RAYDIUM_INITIALIZE2_TAG = 1;

/** Programa a vigilar por cada fuente, y la línea de log que delata una creación. */
export const WATCHED: Record<Source, { program: string; logPattern: RegExp }> = {
  pumpfun: { program: PUMPFUN_PROGRAM, logPattern: /Instruction: Create(V2)?$/ },
  raydium: { program: RAYDIUM_AMM_V4_PROGRAM, logPattern: /initialize2/ },
  stonkfun: { program: LAUNCHLAB_PROGRAM, logPattern: /Instruction: Initialize(V2|WithToken2022)?$/ },
  launchlab: { program: LAUNCHLAB_PROGRAM, logPattern: /Instruction: Initialize(V2|WithToken2022)?$/ },
};

function pumpCreate(ix: RawIx): string | undefined {
  if (ix.programId !== PUMPFUN_PROGRAM || ix.data.length < 8) return undefined;
  const d = Buffer.from(ix.data.subarray(0, 8));
  if (!PUMP_CREATE_DISCS.some((x) => x.equals(d))) return undefined;
  return ix.accounts[0]; // en create/create_v2 la cuenta 0 es el mint
}

function raydiumInit(ix: RawIx): string | undefined {
  if (ix.programId !== RAYDIUM_AMM_V4_PROGRAM || ix.data[0] !== RAYDIUM_INITIALIZE2_TAG) return undefined;
  if (ix.accounts.length < 10) return undefined;
  // initialize2: cuenta 8 = coin mint, cuenta 9 = pc mint. Nos quedamos con el que no es SOL.
  const [coin, pc] = [ix.accounts[8], ix.accounts[9]];
  if (coin === WSOL_MINT) return pc;
  if (pc === WSOL_MINT) return coin;
  return undefined;
}

/** Detecta un lanzamiento nuevo en las instrucciones de una transacción. */
export function detectLaunch(
  ixs: RawIx[],
  sources: Source[],
  meta: { signature: string; detectedAt: number },
): NewToken | undefined {
  if (sources.includes('stonkfun') || sources.includes('launchlab')) {
    const launch = decodeLaunchLabCreate(ixs);
    if (launch) {
      const isStonk = config.stonkfunPlatformConfigs.includes(launch.platformConfig);
      const source: Source | undefined =
        isStonk && sources.includes('stonkfun') ? 'stonkfun' : sources.includes('launchlab') ? 'launchlab' : undefined;
      if (source) return { mint: launch.baseMint, source, launchlab: launch, ...meta };
    }
  }
  for (const ix of ixs) {
    if (sources.includes('pumpfun')) {
      const mint = pumpCreate(ix);
      if (mint) return { mint, source: 'pumpfun', ...meta };
    }
    if (sources.includes('raydium')) {
      const mint = raydiumInit(ix);
      if (mint) return { mint, source: 'raydium', ...meta };
    }
  }
  return undefined;
}
