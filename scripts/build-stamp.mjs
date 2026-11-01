// Records which inputs a build was made from, so the doctor and the shared hub can tell builds
// apart by content (see lib/build-inputs.mjs). `pnpm run build` calls it twice:
//
//   node scripts/build-stamp.mjs --before   fingerprint the inputs before tsc reads them
//   node scripts/build-stamp.mjs            after tsc: fingerprint again and write the stamp
//
// If the inputs changed while tsc was running (another session saved a file), the output may
// mix old and new source, so no stamp is written and the build fails: run it again.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInputs, STAMP } from './lib/build-inputs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Outside dist, so a failed build never ships it in the npm package.
const pending = join(root, 'node_modules', '.cache', 'blockhand-build-inputs.json');
const stamp = join(root, STAMP);

if (process.argv.includes('--before')) {
  mkdirSync(dirname(pending), { recursive: true });
  writeFileSync(pending, JSON.stringify(buildInputs(root)));
  process.exit(0);
}

const now = buildInputs(root);
let before;
try {
  before = JSON.parse(readFileSync(pending, 'utf8'));
} catch {
  before = undefined;
}
rmSync(pending, { force: true });

if (before === undefined) {
  process.stderr.write('build stamp: no fingerprint from before the compile; run the whole build with corepack pnpm run build\n');
  process.exit(1);
}
if (before.hash !== now.hash) {
  if (existsSync(stamp)) rmSync(stamp);
  process.stderr.write('build stamp: the source changed while it was being compiled; no stamp written. Run the build again.\n');
  process.exit(1);
}
writeFileSync(stamp, `${JSON.stringify({ hash: now.hash, files: now.files, builtAt: new Date().toISOString() }, null, 2)}\n`);
process.stdout.write(`build stamp: ${now.files} input files, ${now.hash.slice(0, 12)}\n`);
