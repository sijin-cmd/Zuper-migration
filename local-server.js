// ─── Local dev server for Zuper MigrateX ──────────────────────────────────
// Serves public/ as static files and routes /api/<name> to api/<name>.js,
// shimming just enough of the Vercel (req, res) contract that the existing
// handlers need: req.method, req.query, req.body, res.status/setHeader/json/end.
// Run with: node local-server.js   (or: npm run dev)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_DIR = path.join(__dirname, 'api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeRes(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  res.json = function (body) {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  // Vercel's (req,res) functions get an Express-style res.send() — migrate.js relies
  // on it to flush the final NDJSON report. Plain Node http.ServerResponse has no such
  // method, so without this shim every migration run 500s right at the finish line.
  res.send = function (body) {
    if (typeof body === 'string') {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(body);
    } else {
      res.json(body);
    }
    return res;
  };
  return res;
}

async function serveStatic(reqPath, res) {
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(reqPath));
  if (reqPath === '/' || reqPath === '') filePath = path.join(PUBLIC_DIR, 'index.html');

  // Prevent path traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: unknown paths -> index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.statusCode = 404;
          return res.end('Not found');
        }
        res.setHeader('Content-Type', MIME['.html']);
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  makeRes(res);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
    const filePath = path.join(API_DIR, `${name}.js`);

    if (!filePath.startsWith(API_DIR) || !fs.existsSync(filePath)) {
      res.statusCode = 404;
      return res.json({ error: `No API route: ${name}` });
    }

    // req.query
    req.query = Object.fromEntries(url.searchParams.entries());

    // req.body (JSON-parsed, like Vercel does for application/json)
    if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'HEAD') {
      const raw = await readBody(req);
      if (raw) {
        try { req.body = JSON.parse(raw); } catch { req.body = raw; }
      }
    }

    try {
      delete require.cache[require.resolve(filePath)]; // hot-reload each request
      const handler = require(filePath);
      await handler(req, res);
    } catch (err) {
      console.error(`[api/${name}]`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.json({ error: err.message || 'Internal error' });
      }
    }
    return;
  }

  return serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`\n  Zuper MigrateX running locally`);
  console.log(`  → http://localhost:${PORT}\n`);
});
