import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { LAUNCHLAB_PROGRAM } from '../config.js';
import { u64le } from './borsh.js';
import { IX } from './layout.js';

const PROGRAM_ID = new PublicKey(LAUNCHLAB_PROGRAM);
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const LAUNCHLAB_AUTHORITY = pda(Buffer.from('vault_auth_seed'));
export const LAUNCHLAB_EVENT_AUTHORITY = pda(Buffer.from('__event_authority'));
export const platformFeeVault = (platformConfig: PublicKey, quoteMint: PublicKey) =>
  pda(platformConfig.toBuffer(), quoteMint.toBuffer());
export const creatorFeeVault = (creator: PublicKey, quoteMint: PublicKey) =>
  pda(creator.toBuffer(), quoteMint.toBuffer());

export interface LaunchLabSwapAccounts {
  payer: PublicKey;
  globalConfig: PublicKey;
  platformConfig: PublicKey;
  poolState: PublicKey;
  userBaseToken: PublicKey;
  userQuoteToken: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  creator: PublicKey;
}

/** Mismo orden de cuentas que buyExactInInstruction / sellExactInInstruction del SDK de Raydium. */
function keys(a: LaunchLabSwapAccounts) {
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return [
    { pubkey: a.payer, isSigner: true, isWritable: true },
    r(LAUNCHLAB_AUTHORITY),
    r(a.globalConfig),
    r(a.platformConfig),
    w(a.poolState),
    w(a.userBaseToken),
    w(a.userQuoteToken),
    w(a.baseVault),
    w(a.quoteVault),
    r(a.baseMint),
    r(a.quoteMint),
    r(a.baseTokenProgram),
    r(a.quoteTokenProgram),
    r(LAUNCHLAB_EVENT_AUTHORITY),
    r(PROGRAM_ID),
    r(SystemProgram.programId),
    w(platformFeeVault(a.platformConfig, a.quoteMint)),
    w(creatorFeeVault(a.creator, a.quoteMint)),
  ];
}

/** Gasta exactamente `quoteIn` y exige al menos `minBaseOut` tokens. */
export function buyExactInIx(a: LaunchLabSwapAccounts, quoteIn: bigint, minBaseOut: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: keys(a),
    data: Buffer.concat([IX.buyExactIn, u64le(quoteIn, minBaseOut, 0n)]),
  });
}

/** Vende exactamente `baseIn` tokens y exige al menos `minQuoteOut`. */
export function sellExactInIx(a: LaunchLabSwapAccounts, baseIn: bigint, minQuoteOut: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: keys(a),
    data: Buffer.concat([IX.sellExactIn, u64le(baseIn, minQuoteOut, 0n)]),
  });
}
