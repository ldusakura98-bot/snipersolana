import { Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import { config } from './config.js';

export interface FilterResult {
  ok: boolean;
  reason?: string;
}

/** Comprobaciones on-chain del mint antes de comprar. */
export async function checkMint(connection: Connection, mint: string): Promise<FilterResult> {
  let info: { mintAuthority: string | null; freezeAuthority: string | null } | undefined;
  for (let attempt = 0; attempt < 3 && !info; attempt++) {
    const acc = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const data = acc.value?.data as ParsedAccountData | undefined;
    if (data?.parsed?.type === 'mint') info = data.parsed.info;
    else await new Promise((r) => setTimeout(r, 300));
  }
  if (!info) return { ok: false, reason: 'no se pudo leer la cuenta del mint' };

  if (config.requireMintAuthorityRevoked && info.mintAuthority) {
    return { ok: false, reason: `mint authority activa (${info.mintAuthority})` };
  }
  if (config.requireFreezeAuthorityRevoked && info.freezeAuthority) {
    return { ok: false, reason: `freeze authority activa (${info.freezeAuthority})` };
  }
  return { ok: true };
}
