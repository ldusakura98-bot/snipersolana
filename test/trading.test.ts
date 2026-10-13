import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { parseTransferFee } from '../src/filters.js';
import { buyExactInIx } from '../src/launchlab/instructions.js';
import { computeBudgetIxs } from '../src/tx.js';

describe('transacción de compra en LaunchLab', () => {
  it('el peor caso (quote = SOL: crear ATAs + wrap + compra + unwrap) cabe en 1232 bytes', () => {
    const k = () => Keypair.generate().publicKey;
    const payer = Keypair.generate();
    const [baseAta, quoteAta, baseMint, quoteMint] = [k(), k(), k(), k()];
    const ixs = [
      ...computeBudgetIxs(),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta, payer.publicKey, baseMint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, quoteAta, payer.publicKey, quoteMint, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: quoteAta, lamports: 1 }),
      createSyncNativeInstruction(quoteAta),
      buyExactInIx(
        {
          payer: payer.publicKey, globalConfig: k(), platformConfig: k(), poolState: k(), userBaseToken: baseAta,
          userQuoteToken: quoteAta, baseVault: k(), quoteVault: k(), baseMint, quoteMint,
          baseTokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID, creator: k(),
        },
        1n,
        1n,
      ),
      createCloseAccountInstruction(quoteAta, payer.publicKey, payer.publicKey),
    ];
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const size = tx.serialize().length;
    assert.ok(size <= 1232, `tamaño ${size} bytes`);
  });
});

describe('parseTransferFee', () => {
  it('lee la extensión Token-2022 y se queda con la comisión más alta', () => {
    const fee = parseTransferFee({
      extensions: [
        {
          extension: 'transferFeeConfig',
          state: {
            olderTransferFee: { epoch: 1, maximumFee: 5000, transferFeeBasisPoints: 100 },
            newerTransferFee: { epoch: 2, maximumFee: 9000, transferFeeBasisPoints: 300 },
          },
        },
      ],
    });
    assert.deepEqual(fee, { bps: 300, max: 9000n });
  });

  it('sin extensión → sin comisión', () => {
    assert.equal(parseTransferFee({}), undefined);
    assert.equal(parseTransferFee({ extensions: [{ extension: 'metadataPointer', state: {} }] }), undefined);
  });
});
