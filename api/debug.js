const { respond, parseSession } = require('./_helpers');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, {});

  const { sessionToken, path } = req.query || {};
  const session = parseSession(sessionToken);
  if (!session) return respond(res, 401, { error: 'Invalid or expired session.' });

  try {
    const url = `${session.srcBase}/api/${path}`;
    const zres = await fetch(url, {
      headers: { 'x-api-key': session.srcKey, 'Content-Type': 'application/json' }
    });
    const raw = await zres.json().catch(() => ({ _parseError: true }));
    return respond(res, 200, {
      url,
      httpStatus: zres.status,
      topLevelKeys: Object.keys(raw),
      isArray: Array.isArray(raw),
      dataType: raw.data ? (Array.isArray(raw.data) ? 'array' : typeof raw.data) : 'none',
      dataLength: Array.isArray(raw.data) ? raw.data.length : (Array.isArray(raw) ? raw.length : 'n/a'),
      firstItem: Array.isArray(raw.data) && raw.data[0] ? Object.keys(raw.data[0]) : (Array.isArray(raw) && raw[0] ? Object.keys(raw[0]) : null),
      raw: JSON.stringify(raw).slice(0, 2000),
    });
  } catch (err) {
    return respond(res, 500, { error: err.message });
  }
};
