/**
 * Sway – Server (Node.js)
 *
 * Responsibilities:
 *  - HTTPS static file server (public/)
 *  - HTTP → HTTPS redirect
 *  - WebSocket relay: routes motion/calibrated messages between
 *    controllers and dashboards that share the same room code.
 *  - /api/qrcode  → { qr: <data-URL>, url: <controller URL> }
 *  - /api/status  → quick health check
 *
 * Room codes come from public/scripts/room.js (ES module, shared
 * with the browser). The server imports it via createRequire workaround
 * using a dynamic import so the ESM export works in both contexts.
 *
 * Protocol (all messages are JSON):
 *
 *  Client → Server:
 *    { type: 'ping',       t: <timestamp> }
 *    { type: 'motion',     value, valueY, tiltX, tiltY, timestamp }
 *    { type: 'calibrated', timestamp }
 *
 *  Server → Client:
 *    { type: 'welcome',    clientId }
 *    { type: 'pong',       echo: <t> }
 *    { type: 'status',     controllers, dashboards }   (broadcast on change)
 *    { type: 'motion',     ...fields from controller }  (relayed to dashboards)
 *    { type: 'calibrated', timestamp }                 (relayed to dashboards)
 *
 *  WS URL query params:
 *    ?role=dashboard   — registers as the booth (laptop)
 *    ?role=controller  — registers as the phone
 *    ?room=CODE        — joins a specific room (optional; falls back to default)
 */

import fs   from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

// ─── Paths ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.join(__dirname, '..', 'public');
const CERT      = path.join(__dirname, 'cert.pem');
const KEY       = path.join(__dirname, 'key.pem');

// ─── Config ──────────────────────────────────────────────────────────────────

const HTTP_PORT  = parseInt(process.env.PORT       ?? '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT ?? '3443', 10);

// ─── MIME types ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

// ─── Static file handler ─────────────────────────────────────────────────────

function serveStatic(req, res, urlPath) {
  // Default to index.html for /
  let filePath = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // If no extension, try .html suffix then /index.html
  if (!path.extname(filePath)) {
    if (fs.existsSync(filePath + '.html')) {
      filePath += '.html';
    } else if (fs.existsSync(path.join(filePath, 'index.html'))) {
      filePath = path.join(filePath, 'index.html');
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${urlPath}`);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ─── API handlers ────────────────────────────────────────────────────────────

async function handleQrCode(req, res) {
  try {
    const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
    const room  = parsedUrl.searchParams.get('room') ?? '';
    const host  = req.headers.host ?? `localhost:${HTTPS_PORT}`;
    // Always HTTPS — phone sensors need a secure context
    const url   = room
      ? `https://${host}/controller/${room.toUpperCase()}`
      : `https://${host}/controller`;
    const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url, qr }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── HTTP request router ─────────────────────────────────────────────────────

function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `https://${req.headers.host}`);
  const pathname  = parsedUrl.pathname;

  // API routes
  if (pathname === '/api/qrcode' && req.method === 'GET') {
    return handleQrCode(req, res);
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }

  // /controller/CODE → serve controller.html (the code is read client-side from the URL)
  if (/^\/controller(\/[^/]*)?$/.test(pathname)) {
    return serveStatic(req, res, '/controller.html');
  }

  // Static files
  serveStatic(req, res, pathname);
}

// ─── Rooms ───────────────────────────────────────────────────────────────────
// rooms: Map<roomCode, { dashboards: Set<ws>, controllers: Set<ws> }>

const rooms = new Map();

function getRoom(code) {
  // Use a sanitised code; fall back to a literal 'DEFAULT' only for bare /controller connections
  const key = (code || 'DEFAULT').toUpperCase();
  if (!rooms.has(key)) rooms.set(key, { dashboards: new Set(), controllers: new Set() });
  return [key, rooms.get(key)];
}

function cleanRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.dashboards.size === 0 && room.controllers.size === 0) rooms.delete(code);
}

function broadcastStatus(room) {
  const msg = JSON.stringify({
    type:        'status',
    controllers: room.controllers.size,
    dashboards:  room.dashboards.size,
  });
  for (const ws of [...room.dashboards, ...room.controllers]) {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  }
}

// ─── WebSocket server ────────────────────────────────────────────────────────

let clientIdSeq = 0;

function attachWss(server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const params   = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
    const role     = params.get('role') ?? 'controller';
    const rawCode  = params.get('room') ?? '';

    const [roomKey, room] = getRoom(rawCode);
    const bucket = role === 'dashboard' ? room.dashboards : room.controllers;
    bucket.add(ws);

    const clientId = ++clientIdSeq;
    ws.send(JSON.stringify({ type: 'welcome', clientId, role, room: roomKey }));
    broadcastStatus(room);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', echo: msg.t }));
          break;

        case 'motion':
        case 'calibrated':
          // Relay controller messages to all dashboards in the same room
          if (role === 'controller') {
            const payload = JSON.stringify(msg);
            for (const dash of room.dashboards) {
              if (dash.readyState === 1) dash.send(payload);
            }
          }
          break;

        default:
          break;
      }
    });

    ws.on('close', () => {
      bucket.delete(ws);
      broadcastStatus(room);
      cleanRoom(roomKey);
    });

    ws.on('error', () => {
      bucket.delete(ws);
      cleanRoom(roomKey);
    });
  });
}

// ─── Servers ─────────────────────────────────────────────────────────────────

const hasCerts = fs.existsSync(CERT) && fs.existsSync(KEY);

if (hasCerts) {
  // Local Development: Use HTTPS with self-signed certs (needed for mobile sensors)
  const tlsOptions = {
    cert: fs.readFileSync(CERT),
    key:  fs.readFileSync(KEY),
  };
  const httpsServer = https.createServer(tlsOptions, handleRequest);
  attachWss(httpsServer);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`\n  Sway is running:`);
    console.log(`  ┌──────────────────────────────────────────┐`);
    console.log(`  │  Booth      https://localhost:${HTTPS_PORT}     │`);
    console.log(`  │  Controller https://localhost:${HTTPS_PORT}/controller │`);
    console.log(`  └──────────────────────────────────────────┘`);
    console.log(`\n  Accept the self-signed cert warning in your browser.\n`);
  });

  // HTTP → HTTPS redirect
  const httpServer = http.createServer((req, res) => {
    const host = (req.headers.host ?? `localhost:${HTTPS_PORT}`).replace(/:\d+$/, '');
    res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
    res.end();
  });
  httpServer.listen(HTTP_PORT, () => {
    console.log(`  HTTP  :${HTTP_PORT}  → redirecting to HTTPS :${HTTPS_PORT}`);
  });
} else {
  // Production (e.g. Render): Use plain HTTP.
  // The platform handles SSL termination so the app gets a secure context automatically.
  const port = process.env.PORT || 3000;
  const server = http.createServer(handleRequest);
  attachWss(server);
  server.listen(port, () => {
    console.log(`\n  Sway is running in production on port ${port}\n`);
  });
}
