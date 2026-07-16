const { companyUrlFromRegion, respond, parseBody } = require('./_helpers');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, {});
  if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });

  const body = parseBody(req);
  if (!body) return respond(res, 400, { error: 'Invalid JSON' });

  const { region, apiKey } = body;
  if (!region || !apiKey) return respond(res, 400, { error: 'Region and API key are required.' });

  const url = companyUrlFromRegion(region);
  if (!url) return respond(res, 400, { error: 'Unknown region: ' + region });

  try {
    const zres = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });

    const data = await zres.json();

    if (!zres.ok) {
      const msg = data?.message || data?.error || `HTTP ${zres.status}`;
      if (zres.status === 401 || zres.status === 403) return respond(res, 401, { error: 'Invalid API key.' });
      return respond(res, 400, { error: msg });
    }

    const companyName =
      data?.data?.company_name ||
      data?.data?.name ||
      data?.company_name ||
      data?.name ||
      null;

    if (!companyName) return respond(res, 200, { error: 'Company name not found in response.', raw: data });

    return respond(res, 200, { companyName });
  } catch (err) {
    return respond(res, 500, { error: err.message || 'Request failed' });
  }
};
