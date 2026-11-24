// ssh2 without native code: what its install builds is removed again.
//
// The access server (electron/access/server.ts) runs on ssh2, whose install compiles two optional
// bindings with node-gyp: its own crypto (lib/protocol/crypto/build) and cpu-features, which it
// asks to order ciphers. Both are built against the Node that ran npm, not the app's Electron, and
// would be packed and signed as native code nobody loads. ssh2 loads either one in a try and falls
// back to Node's crypto, and the server pins algorithms Node's crypto has (Ed25519, Curve25519 and
// ECDH, AES-GCM), so nothing is lost: the tests and the app run on the same pure JavaScript.
// npm has no way to skip one package's install script, hence this step after `npm install`.
//   node scripts/ssh2-pure.mjs
import fs from "node:fs";
import path from "node:path";

const modules = path.join(import.meta.dirname, "..", "node_modules");

for (const built of [path.join(modules, "ssh2", "lib", "protocol", "crypto", "build"), path.join(modules, "cpu-features", "build")]) {
	fs.rmSync(built, { recursive: true, force: true });
}
