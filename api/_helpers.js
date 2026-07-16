// ─── Shared helpers for all Vercel serverless functions ──────────────────────

const REGION_BASE_URLS = {
  'us-west-1c':   'https://us-west-1c.zuperpro.com',
  'us-east-1':    'https://us-east-1.zuperpro.com',
  'eu-central-1': 'https://eu-central-1.zuperpro.com',
  'apac-staging': 'https://stagingv2.zuperpro.com',
};

const REGION_COMPANY_URLS = {
  'us-west-1c':   'https://us-west-1c.zuperpro.com/api/user/company',
  'us-east-1':    'https://us-east-1.zuperpro.com/api/user/company',
  'eu-central-1': 'https://eu-central-1.zuperpro.com/api/user/company',
  'apac-staging': 'https://stagingv2.zuperpro.com/api/user/company',
};

function baseUrlFromRegion(region) {
  return REGION_BASE_URLS[region] || null;
}

function companyUrlFromRegion(region) {
  return REGION_COMPANY_URLS[region] || null;
}

// Generic Zuper API call
async function zuper(baseUrl, apiKey, method, path, data) {
  const url = `${baseUrl}/api${path}`;
  const opts = {
    method,
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.message || err.error || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Standard CORS + JSON response helper (Vercel req/res style)
function respond(res, statusCode, body) {
  res.status(statusCode);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (statusCode === 204) return res.end();
  return res.json(body);
}

// Vercel auto-parses JSON bodies into req.body when Content-Type is application/json,
// but guard for the raw-string case too.
function parseBody(req) {
  const b = req.body;
  if (b == null) return null;
  if (typeof b === 'object') return b;
  try { return JSON.parse(b); } catch { return null; }
}

// Session is passed as a signed payload in the browser (encrypted client-side token)
// Since serverless functions are stateless, the client stores { srcKey, srcBase, dstKey, dstBase }
// encoded as base64 JSON in sessionStorage and sends it with each request.
// The token is never persisted server-side.
function parseSession(sessionToken) {
  if (!sessionToken) return null;
  try {
    return JSON.parse(Buffer.from(sessionToken, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function makeSessionToken(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

module.exports = {
  baseUrlFromRegion,
  companyUrlFromRegion,
  zuper,
  respond,
  parseBody,
  parseSession,
  makeSessionToken,
};
