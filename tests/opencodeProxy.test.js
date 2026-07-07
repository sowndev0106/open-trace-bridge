const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.OTB_DB_PATH = ':memory:';
process.env.OPENCODE_SERVER_PASSWORD = 'oc-secret';

const { resetDbForTest } = require('../lib/db');
const sessions = require('../models/session.model');
const { createOpencodeProxy } = require('../services/opencodeProxy.service');

let upstream;
let upstreamRequests;
let proxy;
let proxyPort;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxyPort, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

beforeEach(async () => {
  resetDbForTest();
  if (upstream) upstream.close();
  if (proxy) proxy.close();
  upstreamRequests = [];
  upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream saw ${req.url}`);
  });
  process.env.OPENCODE_PORT = String(await listen(upstream));
  proxy = createOpencodeProxy();
  proxyPort = await listen(proxy);
});

after(() => {
  if (upstream) upstream.close();
  if (proxy) proxy.close();
});

test('proxy rejects requests without a valid admin session', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 401);
  assert.match(res.body, /admin/i);
  assert.strictEqual(upstreamRequests.length, 0);

  const bad = await get('/', { cookie: 'otb_session=deadbeef' });
  assert.strictEqual(bad.status, 401);
});

test('proxy forwards authenticated requests and injects opencode basic auth', async () => {
  const token = sessions.create();
  const res = await get('/session?foo=1', { cookie: `otb_session=${token}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, 'upstream saw /session?foo=1');
  assert.strictEqual(upstreamRequests.length, 1);
  const expected = 'Basic ' + Buffer.from('opencode:oc-secret').toString('base64');
  assert.strictEqual(upstreamRequests[0].auth, expected);
});

test('proxy returns 502 when upstream is down', async () => {
  const token = sessions.create();
  upstream.close();
  await new Promise((r) => setTimeout(r, 20));
  const res = await get('/', { cookie: `otb_session=${token}` });
  assert.strictEqual(res.status, 502);
});
