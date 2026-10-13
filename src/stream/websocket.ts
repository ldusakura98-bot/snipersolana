import { Connection, PartiallyDecodedInstruction, ParsedInstruction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Source } from '../config.js';
import { detectLaunch, WATCHED } from '../decoders.js';
import { log } from '../logger.js';
import type { NewToken, RawIx } from '../types.js';

type Ix = ParsedInstruction | PartiallyDecodedInstruction;
const isDecoded = (ix: Ix): ix is PartiallyDecodedInstruction => 'data' in ix && 'accounts' in ix;

/**
 * Detección vía WebSocket estándar (logsSubscribe) + getParsedTransaction.
 * Funciona con cualquier RPC; es el modo más lento porque hay que pedir la tx tras ver el log.
 */
export function startWebsocketStream(
  connection: Connection,
  sources: Source[],
  onToken: (t: NewToken) => void,
): () => Promise<void> {
  const subs: number[] = [];
  const byProgram = new Map<string, RegExp>();
  for (const s of sources) byProgram.set(WATCHED[s].program, WATCHED[s].logPattern);

  for (const [program, pattern] of byProgram) {
    subs.push(
      connection.onLogs(
        new PublicKey(program),
        ({ logs, err, signature }) => {
          if (err || !logs.some((l) => pattern.test(l))) return;
          const detectedAt = Date.now();
          fetchIxs(connection, signature)
            .then((ixs) => {
              const token = ixs && detectLaunch(ixs, sources, { signature, detectedAt });
              if (token) onToken(token);
            })
            .catch((e) => log.warn(`No se pudo leer ${signature}: ${(e as Error).message}`));
        },
        'confirmed',
      ),
    );
    log.info(`WebSocket: escuchando ${program}`);
  }

  return async () => {
    await Promise.all(subs.map((id) => connection.removeOnLogsListener(id)));
  };
}

/** Descarga la transacción y la normaliza a RawIx (instrucciones de primer nivel + internas). */
async function fetchIxs(connection: Connection, signature: string): Promise<RawIx[] | undefined> {
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
      return all.filter(isDecoded).map((ix) => ({
        programId: ix.programId.toBase58(),
        accounts: ix.accounts.map((a) => a.toBase58()),
        data: bs58.decode(ix.data),
      }));
    }
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  throw new Error('transacción no disponible');
}
