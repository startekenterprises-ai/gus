#!/usr/bin/env node
/**
 * Generate a local Ed25519 release-signing keypair — FIXTURE /
 * release-tooling for the Phase 3 drill (and the shape of the real
 * publisher-side tool).
 *
 *   node gen-update-key.mjs <privateKeyOut.pem> <publicKeyOut.pem>
 *
 * The PRIVATE key stays on the publisher side (in the drill: the host
 * drill directory — it never enters a container or an install). The
 * PUBLIC key is pinned into the install's control-plane state as
 * update-pubkey.pem; the Updater verifies release manifests against
 * it and holds nothing that could sign.
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const [privOut, pubOut] = process.argv.slice(2);
if (!privOut || !pubOut) {
  console.error("usage: node gen-update-key.mjs <privateKeyOut.pem> <publicKeyOut.pem>");
  process.exit(2);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(privOut, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(pubOut, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
console.log(`release keypair written: private=${privOut} public=${pubOut}`);
