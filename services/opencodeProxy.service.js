const http = require('http');
const net = require('net');
const auth = require('./auth.service');
const sessions = require('../models/session.model');

// Reverse proxy that exposes the local `opencode serve` web UI through an
// admin-session-guarded port. The browser never learns the opencode basic-auth
// password: the proxy injects it server-side. Port 4096 stays unpublished.

function targetOpts() {
  return { host: '127.0.0.1', port: Number(process.env.OPENCODE_PORT || 4096) };
}

function basicAuthHeader() {
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

function isAuthorized(req) {
  return Boolean(sessions.findValid(auth.tokenFromRequest(req)));
}

function upstreamHeaders(req) {
  const target = targetOpts();
  return { ...req.headers, authorization: basicAuthHeader(), host: `${target.host}:${target.port}` };
}

function createOpencodeProxy() {
  const server = http.createServer((req, res) => {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('Sign in to the admin console first, then reload this page.');
    }
    const proxyReq = http.request(
      { ...targetOpts(), path: req.url, method: req.method, headers: upstreamHeaders(req) },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`opencode upstream error: ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  // WebSocket passthrough: replay the upgrade handshake against the upstream
  // and splice the sockets together.
  server.on('upgrade', (req, socket, head) => {
    if (!isAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    const target = targetOpts();
    const upstream = net.connect(target.port, target.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [key, value] of Object.entries(upstreamHeaders(req))) {
        lines.push(`${key}: ${value}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return server;
}

module.exports = { createOpencodeProxy };
