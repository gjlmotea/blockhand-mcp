// Fingerprint of everything a build is made from: the source tree, the TypeScript configs,
// package.json and the lockfile. The build records it in dist/.build-inputs.json; the doctor
// recomputes it and compares.
//
// Content, not modification times: a git checkout or clone rewrites mtimes without changing
// anything, and copying a tree can keep old mtimes on new content. A hash says whether the
// build on disk was made from what is on disk now.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FILES = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json'];

function listFiles(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
}

/** { hash, files } for the build inputs under root (the package directory). */
export function buildInputs(root) {
  const files = [];
  listFiles(root, join(root, 'src'), files);
  for (const name of FILES) if (existsSync(join(root, name))) files.push(name);
  files.sort();
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name);
    hash.update('\0');
    // Normalise line endings so a CRLF checkout of the same commit hashes the same.
    hash.update(readFileSync(join(root, name), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files: files.length };
}

export const STAMP = 'dist/.build-inputs.json';
