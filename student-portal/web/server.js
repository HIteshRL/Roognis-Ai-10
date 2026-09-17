// Tiny production server for the built SPA: serves ./dist with history
// (SPA) fallback and reverse-proxies /api/* to the gateway. Mirrors the
// existing frontend/server.js so deployment stays consistent. Zero deps.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.PORT) || 3000
const HOST = process.env.HOST || '0.0.0.0'
const DIST = path.join(__dirname, 'dist')

function normalizeTarget(raw) {
  let t = raw || 'http://traefik'
  if (!/^https?:\/\//.test(t)) t = 'http://' + t
  return new URL(t)
}
const API_TARGET = normalizeTarget(process.env.API_PROXY_TARGET || process.env.NEXT_PUBLIC_API_URL || 'http://traefik')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
}

function proxyApi(req, res) {
  const mod = API_TARGET.protocol === 'https:' ? https : http
  const options = {
    protocol: API_TARGET.protocol,
    hostname: API_TARGET.hostname,
    port: API_TARGET.port || (API_TARGET.protocol === 'https:' ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: API_TARGET.host },
  }
  const preq = mod.request(options, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers)
    pres.pipe(res)
  })
  preq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Bad gateway' }))
  })
  req.pipe(preq)
}

function sendFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      return res.end('Not found')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' })
    res.end(data)
  })
}

function serveStatic(req, res) {
  let urlPath
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]) } catch { res.writeHead(400); return res.end('Invalid path') }
  const filePath = path.join(DIST, urlPath)
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    res.writeHead(403)
    return res.end('Forbidden')
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) return sendFile(filePath, res)
    // SPA history fallback → index.html
    sendFile(path.join(DIST, 'index.html'), res)
  })
}

http
  .createServer((req, res) => {
    if ((req.url || '').startsWith('/api/')) return proxyApi(req, res)
    serveStatic(req, res)
  })
  .listen(PORT, HOST, () => {
    console.log(`roognis web on http://${HOST}:${PORT} → api ${API_TARGET.href}`)
  })
