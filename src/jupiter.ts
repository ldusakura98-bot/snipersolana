import { config } from './config.js';

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: unknown;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.jupiterApiKey) h['x-api-key'] = config.jupiterApiKey;
  return h;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  slippageBps = config.slippageBps,
): Promise<Quote | undefined> {
  const url = new URL(`${config.jupiterApiUrl}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('restrictIntermediateTokens', 'true');

  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    // 400 = no hay ruta (token aún no indexado o sin liquidez)
    if (res.status === 400 || res.status === 404) return undefined;
    throw new Error(`Jupiter quote HTTP ${res.status}: ${await res.text()}`);
  }
  const q = (await res.json()) as Quote;
  return q.outAmount ? q : undefined;
}

/** Devuelve la transacción de swap serializada (base64) lista para firmar. */
export async function buildSwapTx(quote: Quote, userPublicKey: string): Promise<string> {
  const res = await fetch(`${config.jupiterApiUrl}/swap`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: config.priorityFeeMaxLamports,
          priorityLevel: 'veryHigh',
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap HTTP ${res.status}: ${await res.text()}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error('Jupiter no devolvió swapTransaction');
  return swapTransaction;
}
