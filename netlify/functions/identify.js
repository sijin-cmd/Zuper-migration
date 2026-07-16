const { companyUrlFromRegion, respond } = require('./_helpers');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const { region, apiKey } = body;
  if (!region || !apiKey) return respond(400, { error: 'Region and API key are required.' });

  const url = companyUrlFromRegion(region);
  if (!url) return respond(400, { error: 'Unknown region: ' + region });

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data?.message || data?.error || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) return respond(401, { error: 'Invalid API key.' });
      return respond(400, { error: msg });
    }

    const companyName =
      data?.data?.company_name ||
      data?.data?.name ||
      data?.company_name ||
      data?.name ||
      null;

    if (!companyName) return respond(200, { error: 'Company name not found in response.', raw: data });

    return respond(200, { companyName });
  } catch (err) {
    return respond(500, { error: err.message || 'Request failed' });
  }
};
