const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const API_PROXY_TARGET = normalizeProxyTarget(
  process.env.API_PROXY_TARGET ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://127.0.0.1'
);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Text formats compress well; png/jpg are already compressed, so skip them.
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg']);

/**
 * Compressed-body cache, keyed by resolved file path.
 *
 * `frontend/server.js` reads index.html from disk per request by design — the
 * whole file is hot-patched in place via `docker cp` without a rebuild (see
 * CLAUDE.md). This cache does not change that: every request still stats the
 * file, so a hot-patch is picked up on its very next request. It only avoids
 * re-reading and re-compressing the ~450KB file when the mtime hasn't moved.
 */
const compressedCache = new Map();

function pickEncoding(acceptEncoding) {
  const value = String(acceptEncoding || '');
  if (/\bbr\b/.test(value)) return 'br';
  if (/\bgzip\b/.test(value)) return 'gzip';
  return null;
}

function buildEntry(filePath, stat, raw) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const etag = `"${Math.round(stat.mtimeMs).toString(16)}-${stat.size.toString(16)}"`;
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, contentType, etag, raw };
  if (COMPRESSIBLE_EXTENSIONS.has(ext)) {
    entry.gzip = zlib.gzipSync(raw);
    entry.br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
  }
  return entry;
}

function loadEntry(filePath, callback) {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr) {
      callback(statErr, null);
      return;
    }
    const cached = compressedCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      callback(null, cached);
      return;
    }
    fs.readFile(filePath, (readErr, raw) => {
      if (readErr) {
        callback(readErr, null);
        return;
      }
      const entry = buildEntry(filePath, stat, raw);
      compressedCache.set(filePath, entry);
      callback(null, entry);
    });
  });
}

function sendEntry(req, res, entry) {
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': entry.contentType,
    ETag: entry.etag,
    // Always revalidate rather than a max-age: index.html can be hot-patched
    // at any moment and a stale student session must see the fix, not a cache.
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
  };

  const encoding = pickEncoding(req.headers['accept-encoding']);
  const body = encoding && entry[encoding] ? entry[encoding] : entry.raw;
  if (encoding && entry[encoding]) headers['Content-Encoding'] = encoding;
  headers['Content-Length'] = body.length;

  res.writeHead(200, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  // Inspect the raw path before URL normalization. `new URL()` normalizes
  // encoded dot segments, which otherwise turns `/%2e%2e/package.json` into
  // an apparently in-root request and lets it reach the static-file branch.
  const rawPath = String(req.url || '/').split('?')[0];
  if (!rawPath.startsWith('/') || rawPath.includes('\\') || /%(?:2e|2f|5c)/i.test(rawPath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    res.writeHead(400);
    res.end('Invalid path');
    return;
  }
  if (urlPath.startsWith('/api/')) {
    proxyApiRequest(req, res);
    return;
  }

  const requestedPath = urlPath === '/' ? '/index.html' : urlPath;
  const pdfJsAssets = {
    '/vendor/pdfjs/pdf.mjs': path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.mjs'),
    '/vendor/pdfjs/pdf.worker.mjs': path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.mjs'),
  };
  const assetPath = path.resolve(ROOT, `.${requestedPath}`);
  const allowedAssetRoot = path.join(ROOT, 'assets');
  const filePath = pdfJsAssets[requestedPath]
    || (requestedPath === '/index.html' ? path.join(ROOT, 'index.html') : null)
    || (requestedPath.startsWith('/assets/') && assetPath.startsWith(allowedAssetRoot + path.sep) ? assetPath : null);

  if (!filePath) {
    // The single-file portal does not own arbitrary root files. Preserve the
    // existing SPA-style fallback without exposing package manifests, server
    // source, or other files that happen to live beside index.html.
    loadEntry(path.join(ROOT, 'index.html'), (fallbackErr, fallbackEntry) => {
      if (fallbackErr) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      sendEntry(req, res, fallbackEntry);
    });
    return;
  }

  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  loadEntry(filePath, (err, entry) => {
    if (err) {
      loadEntry(path.join(ROOT, 'index.html'), (fallbackErr, fallbackEntry) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        sendEntry(req, res, fallbackEntry);
      });
      return;
    }
    sendEntry(req, res, entry);
  });
});

function normalizeProxyTarget(value) {
  const raw = String(value || '').trim() || 'http://127.0.0.1';
  const withoutApiSuffix = raw.endsWith('/api') ? raw.slice(0, -4) : raw;
  return withoutApiSuffix.replace(/\/+$/, '');
}

function proxyApiRequest(clientReq, clientRes) {
  let target;
  try {
    target = new URL(clientReq.url, API_PROXY_TARGET);
  } catch (error) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({ error: 'Invalid API proxy target.' }));
    return;
  }

  const headers = {};
  for (const [name, value] of Object.entries(clientReq.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers.host = target.host;

  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: clientReq.method,
    path: `${target.pathname}${target.search}`,
    headers,
  };

  const transport = target.protocol === 'https:' ? https : http;
  const proxyReq = transport.request(requestOptions, proxyRes => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    clientRes.writeHead(proxyRes.statusCode || 502, responseHeaders);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', error => {
    if (clientRes.headersSent) {
      clientRes.destroy(error);
      return;
    }
    clientRes.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    clientRes.end(JSON.stringify({
      error: 'Backend API is not reachable from the frontend server.',
      target: API_PROXY_TARGET,
    }));
  });

  clientReq.pipe(proxyReq);
}

server.listen(PORT, HOST, () => {
  console.log(`[frontend] running at http://${HOST}:${PORT}`);
  console.log(`[frontend] proxying /api/* to ${API_PROXY_TARGET}`);
});
