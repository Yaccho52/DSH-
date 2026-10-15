/**
 * Re-enable (or disable) dsh-whale-balance in the desktop profile.
 *
 * The Electron app owns that profile, so `dsh plugin --profile desktop` refuses to run.
 * This script does what the plugin manager does at the file level: keep the dependency
 * entry and the `dsh.profile.bundles` row, and keep the `whale-balance` row in the
 * user's patch layer. Both files are backed up first.
 *
 * usage: node tools/profile-toggle.mjs [--off]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dsh-whale-balance';
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileRoot = join(homedir(), '.dsh', 'profiles', 'desktop');
const off = process.argv.includes('--off');

const manifestPath = join(profileRoot, 'package.json');
const patchPath = join(profileRoot, 'cordis.patch.yml');
if (!existsSync(manifestPath)) {
  console.error('profile not found:', profileRoot);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const file of [manifestPath, patchPath]) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak-whale-${stamp}`);
}

// package.json: dependency entry + ordered bundle row.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (off) {
  delete manifest.dependencies[PACKAGE];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== PACKAGE);
} else {
  manifest.dependencies[PACKAGE] = `file:${pluginRoot}`;
  if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// cordis.patch.yml: the user's own layer, appended as an insert row.
const row = `- insert:\n    - id: whale-balance\n      name: ${PACKAGE}\n`;
const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
const withoutRow = existing
  .replace(/- insert:\r?\n\s+- id: whale-balance\r?\n\s+name: dsh-whale-balance\r?\n?/g, '')
  .replace(/\n{3,}/g, '\n\n');
const next = off ? withoutRow : `${withoutRow}${withoutRow.endsWith('\n') || withoutRow === '' ? '' : '\n'}${row}`;
writeFileSync(patchPath, next.startsWith('\n') ? next.slice(1) : next);

console.log(off ? 'disabled' : 'enabled', PACKAGE, 'in', profileRoot);
console.log('bundles:', manifest.dsh.profile.bundles.join(', '));
