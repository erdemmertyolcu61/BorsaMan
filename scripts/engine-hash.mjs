// Hash of the Rust engine sources (Cargo.toml + src/*.rs), line endings
// normalized so Windows (CRLF) and CI (LF) checkouts agree. The build script
// stamps it into src/engine/bistEngineWasm.js; a test recomputes it, so a
// source change without `npm run build:engine` fails loudly instead of the
// app silently running a stale wasm.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function engineSourceHash(crateDir) {
  const files = ['Cargo.toml', ...readdirSync(join(crateDir, 'src'))
    .filter((f) => f.endsWith('.rs'))
    .sort()
    .map((f) => `src/${f}`)];
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f + '\n');
    h.update(readFileSync(join(crateDir, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  return h.digest('hex').slice(0, 16);
}
