const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function reservePort() {
  const server = http.createServer();
  return listen(server).then((port) => new Promise((resolve) => server.close(() => resolve(port))));
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request(port, '/');
      if (response.status === 200) return;
    } catch {
      // The child is still starting.
    }
    if (child.exitCode !== null) throw new Error(`frontend server exited with ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('frontend server did not start');
}

test('serves approved assets and proxy traffic without exposing sibling files', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, trace: req.headers['x-runtime-check'] || null }));
  });
  const upstreamPort = await listen(upstream);
  const frontendPort = await reservePort();
  const frontend = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(frontendPort), HOST: '127.0.0.1', API_PROXY_TARGET: `http://127.0.0.1:${upstreamPort}` },
    stdio: 'ignore',
  });

  t.after(() => {
    frontend.kill();
    upstream.close();
  });

  await waitForServer(frontendPort, frontend);
  const index = await request(frontendPort, '/');
  assert.equal(index.status, 200);
  assert.match(index.body, /^<!doctype html>/i);

  const asset = await request(frontendPort, '/assets/apple-touch-icon.png');
  assert.equal(asset.status, 200);

  const route = await request(frontendPort, '/classrooms/example');
  assert.equal(route.status, 200);
  assert.match(route.body, /^<!doctype html>/i);

  const proxied = await request(frontendPort, '/api/runtime-check?x=1', { 'x-runtime-check': 'legacy-proxy' });
  assert.deepEqual(JSON.parse(proxied.body), { url: '/api/runtime-check?x=1', trace: 'legacy-proxy' });

  assert.equal((await request(frontendPort, '/%2e%2e/package.json')).status, 403);
  const manifest = await request(frontendPort, '/package.json');
  assert.equal(manifest.status, 200);
  assert.match(manifest.body, /^<!doctype html>/i);
});
