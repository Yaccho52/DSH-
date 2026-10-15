import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
let source = await readFile(new URL('src/client.js', root), 'utf8');
for (const [marker, file] of [
  ['__WHALE_GIRL_DATA_URL__', 'deepseek-whale-girl.png'],
  ['__BUBBLE_DATA_URL__', 'good-girl-bubble.png'],
]) {
  const bytes = await readFile(new URL(`assets/${file}`, root));
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${file}`);
  source = source.replace(marker, `data:image/png;base64,${bytes.toString('base64')}`);
}
await mkdir(new URL('lib/', root), { recursive: true });
await writeFile(new URL('lib/client.js', root), source);
console.log('Built the DSH client with both original transparent PNGs embedded.');
