// ─── Shared helpers for all Netlify functions ────────────────────────────────

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

// Standard CORS + JSON response helper
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

// Session is passed as a signed payload in the browser (encrypted client-side token)
// Since Netlify Functions are stateless, the client stores { srcKey, srcBase, dstKey, dstBase }
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
  parseSession,
  makeSessionToken,
};
