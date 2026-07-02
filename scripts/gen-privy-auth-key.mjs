/**
 * Generate the Privy P-256 authorization keypair for NewBot's server-side wallets
 * (Phase 44). RUN THIS LOCALLY — the private key controls every provisioned user
 * wallet; never paste it into chat, commit it, or send it anywhere.
 *
 *   node scripts/gen-privy-auth-key.mjs
 *
 * Then:
 *   - PRIVY_AUTHORIZATION_PUBLIC_KEY  -> set as a var (used as wallet/policy owner)
 *   - PRIVY_AUTHORIZATION_PRIVATE_KEY -> `npx wrangler secret put PRIVY_AUTHORIZATION_PRIVATE_KEY`
 */

import { generateP256KeyPair } from '@privy-io/node';

const { publicKey, privateKey } = await generateP256KeyPair();

console.log('\nPrivy P-256 authorization keypair (base64 DER):\n');
console.log('PRIVY_AUTHORIZATION_PUBLIC_KEY  (owner; safe to share / set as a var):');
console.log(`  ${publicKey}\n`);
console.log('PRIVY_AUTHORIZATION_PRIVATE_KEY (SECRET; controls all user wallets):');
console.log(`  ${privateKey}\n`);
console.log('Next steps:');
console.log('  1) npx wrangler secret put PRIVY_AUTHORIZATION_PRIVATE_KEY   # paste the private key');
console.log('  2) set PRIVY_AUTHORIZATION_PUBLIC_KEY (var) to the public key above');
console.log('  3) back up BOTH securely — losing the private key means losing control of provisioned wallets');
console.log('  4) do NOT commit either value or paste the private key anywhere shared\n');
