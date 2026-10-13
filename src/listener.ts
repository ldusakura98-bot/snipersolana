import { createHash } from 'node:crypto';
import {
  Connection,
  PartiallyDecodedInstruction,
  ParsedInstruction,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { PUMPFUN_PROGRAM, RAYDIUM_AMM_V4_PROGRAM, Source, WSOL_MINT } from './config.js';
import { log } from './logger.js';

export interface NewToken {
  mint: string;
  source: Source;
  signature: string;
  detectedAt: number;
}

const anchorDisc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const PUMP_CREATE_DISCS = [anchorDisc('create'), anchorDisc('create_v2')];
const RAYDIUM_INITIALIZE2_TAG = 1;

type Ix = ParsedInstruction | PartiallyDecodedInstruction;
const isDecoded = (ix: Ix): ix is PartiallyDecodedInstruction => 'data' in ix && 'accounts' in ix;

/** Escucha los logs de los programas y emite el mint de cada token/pool nuevo. */
export function startListeners(
  connection: Connection,
  sources: Source[],
  onToken: (t: NewToken) => void,
): () => Promise<void> {
  const seen = new Set<string>();
  const subs: number[] = [];

  const emit = (t: NewToken) => {
    if (seen.has(t.mint)) return;
    seen.add(t.mint);
    if (seen.size > 50_000) seen.clear();
    onToken(t);
  };

  if (sources.includes('pumpfun')) {
    subs.push(
      connection.onLogs(
        new PublicKey(PUMPFUN_PROGRAM),
        ({ logs, err, signature }) => {
          if (err) return;
          if (!logs.some((l) => /Instruction: Create(V2)?$/.test(l))) return;
          resolveMint(connection, signature, PUMPFUN_PROGRAM, extractPumpMint)
            .then((mint) => mint && emit({ mint, source: 'pumpfun', signature, detectedAt: Date.now() }))
            .catch((e) => log.warn(`pump.fun: no se pudo leer ${signature}: ${e.message}`));
        },
        'confirmed',
      ),
    );
    log.info('Escuchando pump.fun (creación de tokens)');
  }

  if (sources.includes('raydium')) {
    subs.push(
      connection.onLogs(
        new PublicKey(RAYDIUM_AMM_V4_PROGRAM),
        ({ logs, err, signature }) => {
          if (err) return;
          if (!logs.some((l) => l.includes('initialize2'))) return;
          resolveMint(connection, signature, RAYDIUM_AMM_V4_PROGRAM, extractRaydiumMint)
            .then((mint) => mint && emit({ mint, source: 'raydium', signature, detectedAt: Date.now() }))
            .catch((e) => log.warn(`Raydium: no se pudo leer ${signature}: ${e.message}`));
        },
        'confirmed',
      ),
    );
    log.info('Escuchando Raydium AMM v4 (pools nuevos)');
  }

  return async () => {
    await Promise.all(subs.map((id) => connection.removeOnLogsListener(id)));
  };
}

async function resolveMint(
  connection: Connection,
  signature: string,
  programId: string,
  extract: (ix: PartiallyDecodedInstruction) => string | undefined,
): Promise<string | undefined> {
  // A veces el RPC aún no tiene la transacción indexada justo al recibir el log.
  for (let attempt = 0; attempt < 5; attempt++) {
    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      const all: Ix[] = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
      ];
      for (const ix of all) {
        if (!isDecoded(ix) || ix.programId.toBase58() !== programId) continue;
        const mint = extract(ix);
        if (mint) return mint;
      }
      return undefined;
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  throw new Error('transacción no disponible');
}

function extractPumpMint(ix: PartiallyDecodedInstruction): string | undefined {
  const data = Buffer.from(bs58.decode(ix.data));
  if (data.length < 8) return undefined;
  const disc = data.subarray(0, 8);
  if (!PUMP_CREATE_DISCS.some((d) => d.equals(disc))) return undefined;
  // En create/create_v2 la cuenta 0 es el mint.
  return ix.accounts[0]?.toBase58();
}

function extractRaydiumMint(ix: PartiallyDecodedInstruction): string | undefined {
  const data = bs58.decode(ix.data);
  if (data[0] !== RAYDIUM_INITIALIZE2_TAG || ix.accounts.length < 10) return undefined;
  // initialize2: cuenta 8 = coin mint, cuenta 9 = pc mint. Nos quedamos con el que no es SOL.
  const coin = ix.accounts[8].toBase58();
  const pc = ix.accounts[9].toBase58();
  if (coin === WSOL_MINT) return pc;
  if (pc === WSOL_MINT) return coin;
  return undefined; // pool sin SOL: lo ignoramos
}
