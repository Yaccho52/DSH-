// Verify the plugin resolves from the desktop profile the way the loader will see it.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profileRoot = join(homedir(), '.dsh', 'profiles', 'desktop');
const require = createRequire(join(profileRoot, 'package.json'));

const manifestPath = require.resolve('dsh-whale-balance/package.json');
const manifest = require('dsh-whale-balance/package.json');
console.log('manifest   ', manifestPath);
console.log('version    ', manifest.version);
console.log('dsh.bundle ', JSON.stringify(manifest.dsh?.bundle));
console.log('dsh.client ', JSON.stringify(manifest.dsh?.client));

const host = await import('dsh-whale-balance');
console.log('host half  ', host.name, '| apply:', typeof host.apply);

const clientPath = require.resolve('dsh-whale-balance/client');
const client = await import('node:fs').then(fs => fs.readFileSync(clientPath, 'utf8'));
console.log('client half', clientPath, `(${(client.length / 1024 / 1024).toFixed(2)} MB)`);
console.log('registers  ', /__ModuleLoader__\.load\(\{\s*id:\s*'dsh-whale-balance'/.test(client));
console.log('fail-soft  ', client.includes('activation failed; DSH startup is left untouched'));
