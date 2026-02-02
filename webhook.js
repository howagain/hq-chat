#!/usr/bin/env node
// hq-webhook.js — HTTP webhook that injects HQ chat messages into OpenClaw session
// Listens for POST /hq-webhook with {from, content, channel}
// Sends the message to the local OpenClaw gateway via WebSocket chat.send

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = parseInt(process.env.WEBHOOK_PORT || '18791');
const GW_URL = process.env.GW_URL || 'ws://localhost:18789/gateway';
const GW_TOKEN = process.env.GW_TOKEN || '0cc836b9d020a50f6f30cf5ebbc74d35a498a779a82f7227';
const SESSION = process.env.GW_SESSION || 'agent:main:main';

// Dedup: track recent message hashes to prevent duplicate delivery
const recentHashes = new Map(); // hash → timestamp
const DEDUP_WINDOW_MS = 60000; // 60 seconds

function msgHash(from, content) {
  return crypto.createHash('sha256').update(`${from}:${content}`).digest('hex').slice(0, 16);
}

function isDuplicate(from, content) {
  const hash = msgHash(from, content);
  const now = Date.now();
  // Clean old entries
  for (const [h, ts] of recentHashes) {
    if (now - ts > DEDUP_WINDOW_MS) recentHashes.delete(h);
  }
  if (recentHashes.has(hash)) return true;
  recentHashes.set(hash, now);
  return false;
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// Send a message to the gateway via WebSocket
function sendToGateway(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GW_URL);
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); reject(new Error('timeout')); }
    }, 15000);

    ws.on('open', () => {});

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Handle connect challenge
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const nonce = msg.payload?.nonce || '';
          const connectReq = {
            type: 'req',
            id: crypto.randomUUID(),
            method: 'connect',
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: 'gateway-client', version: '1.0.0', platform: 'linux', mode: 'backend' },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [], commands: [], permissions: {},
              auth: { token: GW_TOKEN },
              locale: 'en-US',
              userAgent: 'hq-webhook/1.0.0'
            }
          };
          ws.send(JSON.stringify(connectReq));
          return;
        }

        // Handle connect response
        if (msg.type === 'res' && msg.ok) {
          // Connected! Send chat message and immediately resolve (fire-and-forget)
          const chatReq = {
            type: 'req',
            id: crypto.randomUUID(),
            method: 'chat.send',
            params: {
              sessionKey: SESSION,
              message: text,
              idempotencyKey: crypto.randomUUID()
            }
          };
          ws.send(JSON.stringify(chatReq));
          // Don't wait for agent response — fire and forget
          resolved = true;
          clearTimeout(timeout);
          setTimeout(() => ws.close(), 500);
          resolve({ ok: true });
          return;
        }

        // Handle error responses
        if (msg.type === 'res' && !msg.ok) {
          resolved = true;
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.error?.message || 'failed'));
          return;
        }
      } catch (e) {
        // ignore parse errors from events
      }
    });

    ws.on('error', (err) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
    });

    ws.on('close', () => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(new Error('ws closed')); }
    });
  });
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/hq-webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const from = data.from || 'unknown';
        const content = data.content || '';
        const channel = data.channel || 'hq';

        // Don't notify myself about my own messages
        if (from === 'op') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, skipped: 'self' }));
          return;
        }

        // Deduplicate — skip if we've seen this exact message recently
        if (isDuplicate(from, content)) {
          log(`Dedup skip: ${from}: ${content.substring(0, 40)}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, skipped: 'duplicate' }));
          return;
        }

        log(`HQ message from ${from}: ${content.substring(0, 80)}`);

        // Inject as system event into OpenClaw session
        const eventText = `[HQ Chat] ${from}: ${content}`;
        await sendToGateway(eventText);

        log(`Delivered to gateway`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log('Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'hq-webhook', port: PORT }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`HQ webhook server listening on 0.0.0.0:${PORT}`);
  log(`Gateway: ${GW_URL}`);
  log(`POST /hq-webhook — inject HQ chat messages`);
  log(`GET /health — health check`);
});
