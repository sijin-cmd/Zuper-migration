const { respond, parseSession } = require('./_helpers');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, {});

  const { sessionToken, path, find, side } = req.query || {};
  const session = parseSession(sessionToken);
  if (!session) return respond(res, 401, { error: 'Invalid or expired session.' });

  try {
    // side=dst — inspect the DESTINATION account instead of source (default), so we
    // can confirm what actually landed after a migration, not just what we sent.
    const base = side === 'dst' ? session.dstBase : session.srcBase;
    const key  = side === 'dst' ? session.dstKey  : session.srcKey;
    const url = `${base}/api/${path}`;
    const zres = await fetch(url, {
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' }
    });
    const raw = await zres.json().catch(() => ({ _parseError: true }));

    // Diagnostic mode: &find=dependent — scan raw.data for any item that looks like
    // it carries a dependency, at either the top level or nested in original_template,
    // and return a few full (untruncated) samples so we can see exactly where the
    // dependency fields actually live in this account's real API response.
    if (find === 'dependent' && Array.isArray(raw.data)) {
      const hasDep = (f) => {
        const t = f.original_template || {};
        return (Array.isArray(f.dependent_fields) && f.dependent_fields.length > 0)
            || (Array.isArray(t.dependent_fields) && t.dependent_fields.length > 0)
            || !!f.dependent_on || !!t.dependent_on
            || !!f.is_dependent || !!t.is_dependent;
      };
      const matches = raw.data.filter(hasDep);
      return respond(res, 200, {
        url,
        httpStatus: zres.status,
        totalItems: raw.data.length,
        matchedDependentItems: matches.length,
        samples: matches.slice(0, 3),
      });
    }

    return respond(res, 200, {
      url,
      httpStatus: zres.status,
      topLevelKeys: Object.keys(raw),
      isArray: Array.isArray(raw),
      dataType: raw.data ? (Array.isArray(raw.data) ? 'array' : typeof raw.data) : 'none',
      dataLength: Array.isArray(raw.data) ? raw.data.length : (Array.isArray(raw) ? raw.length : 'n/a'),
      firstItem: Array.isArray(raw.data) && raw.data[0] ? Object.keys(raw.data[0]) : (Array.isArray(raw) && raw[0] ? Object.keys(raw[0]) : null),
      data: raw.data !== undefined ? raw.data : (Array.isArray(raw) ? raw : undefined), // full, untruncated
      raw: JSON.stringify(raw).slice(0, 2000),
    });
  } catch (err) {
    return respond(res, 500, { error: err.message });
  }
};
