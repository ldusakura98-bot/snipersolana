import { Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';
import { config } from './config.js';
import type { TransferFee } from './launchlab/curve.js';

export interface MintCheck {
  ok: boolean;
  reason?: string;
  /** Comisión de transferencia Token-2022, si el mint la tiene. */
  transferFee?: TransferFee;
}

interface ParsedMint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions?: { extension: string; state: any }[];
}

/** Comprobaciones on-chain del mint antes de comprar. */
export async function checkMint(
  connection: Connection,
  mint: string,
  /** Authorities aceptables (p. ej. la PDA de un programa de lanzamiento, que no puede acuñar a voluntad). */
  trustedAuthorities: string[] = [],
): Promise<MintCheck> {
  let info: ParsedMint | undefined;
  for (let attempt = 0; attempt < 3 && !info; attempt++) {
    const acc = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const data = acc.value?.data as ParsedAccountData | undefined;
    if (data?.parsed?.type === 'mint') info = data.parsed.info;
    else await new Promise((r) => setTimeout(r, 300));
  }
  if (!info) return { ok: false, reason: 'no se pudo leer la cuenta del mint' };

  if (config.requireMintAuthorityRevoked && info.mintAuthority && !trustedAuthorities.includes(info.mintAuthority)) {
    return { ok: false, reason: `mint authority activa (${info.mintAuthority})` };
  }
  if (config.requireFreezeAuthorityRevoked && info.freezeAuthority && !trustedAuthorities.includes(info.freezeAuthority)) {
    return { ok: false, reason: `freeze authority activa (${info.freezeAuthority})` };
  }

  const transferFee = parseTransferFee(info);
  if (transferFee && transferFee.bps > config.maxTransferFeeBps) {
    return { ok: false, reason: `transfer fee ${transferFee.bps / 100}% > máximo ${config.maxTransferFeeBps / 100}%` };
  }
  return { ok: true, transferFee };
}

/** Lee la extensión transferFeeConfig de Token-2022 (tomamos la mayor de las dos configuraciones). */
export function parseTransferFee(info: Pick<ParsedMint, 'extensions'>): TransferFee | undefined {
  const ext = info.extensions?.find((e) => e.extension === 'transferFeeConfig')?.state;
  if (!ext) return undefined;
  const fees = [ext.newerTransferFee, ext.olderTransferFee].filter(Boolean);
  if (fees.length === 0) return undefined;
  const worst = fees.reduce((a, b) => (b.transferFeeBasisPoints > a.transferFeeBasisPoints ? b : a));
  return { bps: worst.transferFeeBasisPoints, max: BigInt(worst.maximumFee) };
}
