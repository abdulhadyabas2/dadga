/**
 * DADGA — Local Proxy Server
 * Serves the app AND proxies audio to stt.roshnaisunat.com to bypass CORS
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 5050;
const API_HOST = 'stt.roshnaisunat.com';
const API_PATH = '/transcribe';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

const server = http.createServer((req, res) => {
  // ── CORS headers for every response ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);

  // ── BLOCK direct access to users.json ────────────────────────
  if (parsedUrl.pathname === '/users.json') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  // ── LOGIN: POST /login ────────────────────────────────────────
  if (parsedUrl.pathname === '/login' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(Buffer.concat(chunks).toString());
        const usersPath = path.join(__dirname, 'users.json');
        const { users } = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        const match = users.find(u => u.username === username && u.password === password);
        if (match) {
          console.log(`[AUTH]   Login OK: ${username}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, username }));
        } else {
          console.log(`[AUTH]   Login FAIL: ${username}`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'ناوی بەکارهێنەر یان وشەی نهێنی هەڵەیە' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'داواکاری هەڵەیە' }));
      }
    });
    return;
  }

  // ── PROXY: POST /transcribe  ──────────────────────────────────
  if (parsedUrl.pathname === '/transcribe' && req.method === 'POST') {
    console.log(`[PROXY]  Buffering request body...`);

    // Buffer the ENTIRE body first — critical for multipart/form-data
    // (piping directly sends chunked encoding which breaks the upstream API)
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      console.log(`[PROXY]  Body size: ${body.length} bytes, Content-Type: ${req.headers['content-type']}`);

      const options = {
        hostname: API_HOST,
        port: 443,
        path: API_PATH,
        method: 'POST',
        headers: {
          // Only forward the essential headers — no chunked transfer encoding
          'accept': 'application/json',
          'content-type': req.headers['content-type'],   // preserves multipart boundary
          'content-length': body.length,
          'host': API_HOST,
          'user-agent': 'DadgaProxy/1.0',
        },
      };

      const proxyReq = https.request(options, (proxyRes) => {
        // Read full upstream response body for logging
        const respChunks = [];
        proxyRes.on('data', c => respChunks.push(c));
        proxyRes.on('end', () => {
          const respBody = Buffer.concat(respChunks);
          console.log(`[PROXY]  ← ${proxyRes.statusCode}  body: ${respBody.toString().substring(0, 200)}`);
          res.writeHead(proxyRes.statusCode, {
            'Content-Type': proxyRes.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(respBody);
        });
      });

      proxyReq.on('error', (err) => {
        console.error('[PROXY ERROR]', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', detail: err.message }));
      });

      proxyReq.write(body);
      proxyReq.end();
    });

    req.on('error', (err) => {
      console.error('[REQ ERROR]', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request', detail: err.message }));
    });
    return;
  }

  // ── STATIC FILES ──────────────────────────────────────────────
  let filePath = parsedUrl.pathname === '/' ? '/login.html' : parsedUrl.pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + parsedUrl.pathname);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  // Detect local network IP for mobile access
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIP = 'YOUR_PC_IP';
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   داگا — Kurdish Voice Transcription             ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║   PC:     http://localhost:${PORT}                ║`);
  console.log(`  ║   Mobile: http://${localIP}:${PORT}        ║`);
  console.log(`  ║   Proxy:  /transcribe → ${API_HOST}        ║`);
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log('  ║   ⚠  Mobile mic needs same WiFi network          ║');
  console.log('  ║   ⚠  Allow mic in browser settings on phone      ║');
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log('  ║   Press Ctrl+C to stop                           ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');

  // Auto-open browser on PC
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
