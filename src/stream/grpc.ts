import * as yellowstone from '@triton-one/yellowstone-grpc';
import { CommitmentLevel, SubscribeRequest, SubscribeUpdate, SubscribeUpdateDeshred } from '@triton-one/yellowstone-grpc';
import bs58 from 'bs58';
import type { Source } from '../config.js';
import { detectLaunch, WATCHED } from '../decoders.js';
import { log } from '../logger.js';
import type { NewToken, RawIx } from '../types.js';

interface CompiledIx {
  programIdIndex: number;
  accounts: Uint8Array;
  data: Uint8Array;
}

/**
 * Convierte un mensaje compilado (índices de cuentas) en RawIx.
 * Las cuentas de lookup tables van después de las estáticas: primero writable, luego readonly.
 */
export function compiledToRawIxs(
  accountKeys: Uint8Array[],
  loadedWritable: Uint8Array[],
  loadedReadonly: Uint8Array[],
  ixs: CompiledIx[],
): RawIx[] {
  const keys = [...accountKeys, ...loadedWritable, ...loadedReadonly].map((k) => bs58.encode(k));
  return ixs
    .filter((ix) => keys[ix.programIdIndex] !== undefined)
    .map((ix) => ({
      programId: keys[ix.programIdIndex],
      accounts: [...ix.accounts].map((i) => keys[i]),
      data: ix.data,
    }));
}

type Mode = 'grpc' | 'shreds';
// El paquete publica tipos CommonJS pero lo cargamos como ESM: la clase está en `.default`.
type ClientClass = typeof yellowstone.default.default;
const Client = ((yellowstone.default as unknown as { default?: ClientClass }).default ?? yellowstone.default) as ClientClass;

/**
 * Detección vía Yellowstone gRPC.
 * - 'grpc':   transacciones ya ejecutadas (processed), con instrucciones internas. Sin pedir nada al RPC.
 * - 'shreds': transacciones reconstruidas desde los shreds, ANTES de ejecutarse. Lo más rápido que hay,
 *             pero la tx aún puede fallar y el pool todavía no existe on-chain (se reconstruye desde la instrucción).
 */
export function startGrpcStream(
  mode: Mode,
  endpoint: string,
  token: string | undefined,
  sources: Source[],
  onToken: (t: NewToken) => void,
): () => Promise<void> {
  const programs = [...new Set(sources.map((s) => WATCHED[s].program))];
  let stopped = false;
  let stream: { end(): void; destroy(): void; write(x: unknown): boolean } | undefined;
  let pingTimer: NodeJS.Timeout | undefined;

  const handle = (signature: Uint8Array, ixs: RawIx[]) => {
    const token = detectLaunch(ixs, sources, { signature: bs58.encode(signature), detectedAt: Date.now() });
    if (token) onToken(token);
  };

  const connect = async () => {
    const client = new Client(endpoint, token, undefined);
    await client.connect();

    if (mode === 'grpc') {
      const s = await client.subscribe();
      stream = s;
      s.on('data', (u: SubscribeUpdate) => {
        const info = u.transaction?.transaction;
        const msg = info?.transaction?.message;
        if (!info || !msg || !info.meta || info.meta.err) return;
        const { loadedWritableAddresses: w, loadedReadonlyAddresses: r } = info.meta;
        const inner = info.meta.innerInstructions.flatMap((i) => i.instructions);
        handle(info.signature, compiledToRawIxs(msg.accountKeys, w, r, [...msg.instructions, ...inner]));
      });
      const request: SubscribeRequest = {
        accounts: {},
        slots: {},
        transactions: {
          sniper: { vote: false, failed: false, accountInclude: programs, accountExclude: [], accountRequired: [] },
        },
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: CommitmentLevel.PROCESSED,
      };
      s.write(request);
      // Algunos proveedores cierran la conexión si no hay tráfico: ping cada 15 s.
      pingTimer = setInterval(() => s.write({ ...request, ping: { id: 1 } }), 15_000);
    } else {
      const s = await client.subscribeDeshred();
      stream = s;
      s.on('data', (u: SubscribeUpdateDeshred) => {
        const info = u.deshredTransaction?.transaction;
        const msg = info?.transaction?.message;
        if (!info || !msg) return;
        handle(
          info.signature,
          compiledToRawIxs(msg.accountKeys, info.loadedWritableAddresses, info.loadedReadonlyAddresses, msg.instructions),
        );
      });
      const request = {
        deshredTransactions: { sniper: { vote: false, accountInclude: programs, accountExclude: [], accountRequired: [] } },
        slots: {},
      };
      s.write(request);
      pingTimer = setInterval(() => s.write({ ...request, ping: { id: 1 } }), 15_000);
    }

    const s = stream!;
    await new Promise<void>((resolve) => {
      (s as unknown as NodeJS.EventEmitter).on('error', (e: Error) => {
        log.warn(`gRPC (${mode}): ${e.message}`);
        resolve();
      });
      (s as unknown as NodeJS.EventEmitter).on('end', resolve);
      (s as unknown as NodeJS.EventEmitter).on('close', resolve);
    });
    clearInterval(pingTimer);
  };

  // Bucle de reconexión con espera creciente.
  void (async () => {
    let delay = 1_000;
    while (!stopped) {
      try {
        log.info(`gRPC (${mode}): conectando a ${endpoint} — programas: ${programs.join(', ')}`);
        const started = Date.now();
        await connect();
        if (Date.now() - started > 60_000) delay = 1_000; // la conexión duró: reinicia la espera
      } catch (e) {
        log.warn(`gRPC (${mode}): error de conexión: ${(e as Error).message}`);
      }
      if (stopped) break;
      log.info(`gRPC (${mode}): reconectando en ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();

  return async () => {
    stopped = true;
    clearInterval(pingTimer);
    stream?.destroy();
  };
}
