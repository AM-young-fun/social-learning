import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { openDatabase } from './db.js';
import { InputError, Repository } from './repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const publicDir = join(projectRoot, 'public');
const vendorFiles = new Map([
  ['/vendor/echarts.min.js', join(projectRoot, 'node_modules', 'echarts', 'dist', 'echarts.min.js')]
]);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3197);

const repository = new Repository(openDatabase());

const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
      sendJson(res, { ok: true, service: 'social-learning', now: new Date().toISOString() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/profile-observation') {
      const body = await readJson(req);
      const profile = repository.recordProfile(body);
      sendJson(res, { ok: true, profile });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/timeline-observations') {
      const body = await readJson(req);
      const result = repository.recordTimelineBatch(body);
      sendJson(res, { ok: true, ...result });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/profiles') {
      sendJson(res, { profiles: repository.listProfiles() });
      return;
    }

    const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (req.method === 'GET' && profileMatch) {
      const summary = repository.getProfileSummary(decodeURIComponent(profileMatch[1]), url.searchParams.get('days'));
      if (!summary) {
        sendJson(res, { error: 'Profile not found.' }, 404);
        return;
      }
      sendJson(res, summary);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      sendJson(res, { events: repository.listEvents(url.searchParams.get('limit')) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/export.json') {
      sendJson(res, repository.exportAll(), 200, {
        'Content-Disposition': `attachment; filename="social-learning-${Date.now()}.json"`
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (vendorFiles.has(url.pathname)) {
        serveFile(vendorFiles.get(url.pathname), res, req.method === 'HEAD');
        return;
      }
      serveStatic(url.pathname, res, req.method === 'HEAD');
      return;
    }

    sendJson(res, { error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof InputError) {
      sendJson(res, { error: error.message }, 400);
      return;
    }

    console.error(error);
    sendJson(res, { error: 'Internal server error.' }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Social Learning server running at http://${host}:${port}`);
  console.log('Load the Chrome extension from ./extension after starting the server.');
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new InputError('Payload too large.');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('Invalid JSON.');
  }
}

function sendJson(res, body, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  res.end(JSON.stringify(body, null, 2));
}

function serveStatic(pathname, res, headOnly = false) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '');
  const fullPath = join(publicDir, safePath);

  if (!fullPath.startsWith(publicDir) || !existsSync(fullPath)) {
    sendJson(res, { error: 'Not found.' }, 404);
    return;
  }

  serveFile(fullPath, res, headOnly);
}

function serveFile(fullPath, res, headOnly = false) {
  if (!fullPath || !existsSync(fullPath)) {
    sendJson(res, { error: 'Not found.' }, 404);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType(extname(fullPath)),
    'Cache-Control': 'no-store'
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(fullPath).pipe(res);
}

function contentType(extension) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
  }[extension] || 'application/octet-stream';
}
