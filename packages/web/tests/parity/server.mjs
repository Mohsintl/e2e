/**
 * The parity suite's app: Playwright's test assets (`assets/`, copied from
 * microsoft/playwright `tests/assets` at v1.64.1, Apache-2.0) plus the few
 * dynamic routes Playwright's test server sets per test, fixed here as paths.
 * Serves every interface, so `127.0.0.1` and `localhost` on one port are two
 * origins for the cross-origin cases.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

/** The request body, read whole. */
function body(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const query = url.searchParams;
  switch (url.pathname) {
    case '/content':
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(Buffer.from(query.get('html') ?? '', 'base64url'));
      return;
    case '/echo': {
      const received = await body(request);
      response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ method: request.method, headers: request.headers, body: received.toString(), url: request.url }));
      return;
    }
    case '/status':
      response.writeHead(Number(query.get('code') ?? 200), { 'content-type': 'text/plain' });
      response.end(query.get('body') ?? '');
      return;
    case '/slow':
      setTimeout(() => {
        response.writeHead(200, { 'content-type': query.get('type') ?? 'text/plain', 'access-control-allow-origin': '*' });
        response.end(query.get('body') ?? 'slow');
      }, Number(query.get('ms') ?? 1000));
      return;
    case '/never':
      request.on('close', () => response.destroy());
      return;
    case '/redirect':
      response.writeHead(302, { location: query.get('to') ?? '/empty.html' });
      response.end();
      return;
    case '/download':
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment${query.has('name') ? `; filename=${query.get('name')}` : ''}`,
      });
      response.end(query.get('body') ?? 'Hello world');
      return;
    case '/set-cookie':
      response.writeHead(200, { 'set-cookie': query.get('cookie') ?? 'name=value', 'content-type': 'text/html' });
      response.end('<title>cookie</title>');
      return;
  }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(response);
});

server.listen(Number(process.env.PORT ?? 4311));
