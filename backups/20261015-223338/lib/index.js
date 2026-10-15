/**
 * `dsh-whale-balance` · Host half.
 *
 * The visible widget is the browser half (`lib/client.js`). This half exists for one
 * reason: the generated whale-girl art is a few hundred kilobytes of binary that the
 * client bundle must not inline (the module loader serves JavaScript, not images), so
 * the Host publishes it read-only under one prefix route.
 *
 * Boundaries kept deliberately small:
 * - two whitelisted file names, no directory listing, no path traversal;
 * - read-only `GET`/`HEAD`, everything else is 405;
 * - the route registration belongs to this fiber, so unloading the plugin removes it.
 *
 * Balance data never passes through this half: the browser calls the existing
 * `account` Remote (`ctx.remote.account.getBalance`) directly, exactly like the
 * official Settings → Account page does.
 */
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'whale-balance';

/** Host service this plugin needs before it can serve anything. */
export const inject = ['webServer'];

/** One prefix, so a future asset needs no new route. */
const ROUTE_PREFIX = '/api/whale-balance';

/** Assets directory beside `lib/`. */
const ASSET_ROOT = fileURLToPath(new URL('../assets/', import.meta.url));

/** Exact-name whitelist: request path → file in `assets/`. */
const ASSETS = new Map([
  ['whale-girl.jpg', 'whale-girl.jpg'],
  ['whale-girl-avatar.jpg', 'whale-girl-avatar.jpg'],
]);

/** Content types for whitelisted extensions. */
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Diagnostic sink. The browser half reports where it got to with a fire-and-forget
 * POST; without a console this is the only way for an operator to see that side.
 * Append-only, size-capped, and deliberately absent from the file whitelist.
 */
const DIAG_NAME = 'diag';
const DIAG_LOG = fileURLToPath(new URL('../diag.log', import.meta.url));
const DIAG_LIMIT_BYTES = 64 * 1024;

/** Bumped whenever the Host half changes, so a live route can be identified by probe. */
const HOST_REVISION = 'whale-balance-host/3';

/** 1x1 transparent GIF, the answer to a beacon write. */
const BEACON_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * Append one diagnostic line and cap the file.
 * @param text - already-serialized line content.
 */
async function appendDiag(text) {
  const line = `${new Date().toISOString()} ${text}\n`;
  try {
    const info = await stat(DIAG_LOG).catch(() => ({ size: 0 }));
    if (info.size > DIAG_LIMIT_BYTES) await writeFile(DIAG_LOG, '');
    await appendFile(DIAG_LOG, line);
  } catch (error) {
    console.warn('[whale-balance] diag write failed', error);
  }
}

/**
 * Diagnostic sink. `GET ?e=<json>` appends a line and answers a pixel (the browser
 * writes through an image beacon because the desktop shell carries `fetch` over its
 * own transport), a bare `GET` reports the Host revision, and `POST` appends the body.
 * @param request - node HTTP request.
 * @param response - node HTTP response.
 */
async function collectDiag(request, response) {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (method === 'GET' || method === 'HEAD') {
    const encoded = url.searchParams.get('e');
    if (encoded === null) {
      const body = JSON.stringify({ revision: HOST_REVISION, log: DIAG_LOG });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(method === 'HEAD' ? undefined : body);
      return;
    }
    await appendDiag(decodeURIComponent(encoded));
    response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
    response.end(method === 'HEAD' ? undefined : BEACON_PIXEL);
    return;
  }

  if (method !== 'POST') {
    response.writeHead(405, { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' });
    response.end();
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024) break;
    chunks.push(chunk);
  }
  await appendDiag(Buffer.concat(chunks).toString('utf8').trim());
  response.writeHead(204, { 'cache-control': 'no-store' });
  response.end();
}

/**
 * Answer one whitelisted asset request.
 * @param request - node HTTP request; only method, url and conditional headers are read.
 * @param response - node HTTP response; this handler owns its full lifecycle.
 */
async function serveAsset(request, response) {
  const method = request.method ?? 'GET';
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const requested = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');

  if (requested === DIAG_NAME) {
    await collectDiag(request, response);
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
    response.end();
    return;
  }

  // `new URL` already collapses dot segments; the whitelist is the real fence.
  const file = ASSETS.get(decodeURIComponent(requested));
  if (file === undefined) {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
    return;
  }

  const absolute = join(ASSET_ROOT, file);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
    return;
  }

  const etag = `W/"whale-${info.size}-${Math.round(info.mtimeMs)}"`;
  const headers = {
    'content-type': MIME[extname(absolute).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': 'public, max-age=3600',
    etag,
  };
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { etag, 'cache-control': headers['cache-control'] });
    response.end();
    return;
  }

  const body = await readFile(absolute);
  response.writeHead(200, headers);
  response.end(method === 'HEAD' ? undefined : body);
}

/**
 * Mount the asset route on the current fiber.
 * @param ctx - Host context carrying the webserver service.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: serveAsset }),
    'whale-balance: art assets',
  );
  console.info(`[whale-balance] serving whale-girl art under ${ROUTE_PREFIX}/`);
}
