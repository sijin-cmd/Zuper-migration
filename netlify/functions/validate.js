const { baseUrlFromRegion, respond, makeSessionToken } = require('./_helpers');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body); } catch { return respond(400, { error: 'Invalid JSON' }); }

  const { srcKey, srcRegion, dstKey, dstRegion } = body;
  if (!srcKey || !srcRegion || !dstKey || !dstRegion) {
    return respond(400, { error: 'Region and API key required for both accounts.' });
  }

  const srcBase = baseUrlFromRegion(srcRegion);
  const dstBase = baseUrlFromRegion(dstRegion);
  if (!srcBase) return respond(400, { error: 'Unknown source region.' });
  if (!dstBase) return respond(400, { error: 'Unknown destination region.' });

  try {
    // Use the same /api/user/company endpoint that identify uses — confirmed working
    const [srcRes, dstRes] = await Promise.all([
      fetch(`${srcBase}/api/user/company`, { headers: { 'x-api-key': srcKey, 'Content-Type': 'application/json' } }),
      fetch(`${dstBase}/api/user/company`, { headers: { 'x-api-key': dstKey, 'Content-Type': 'application/json' } }),
    ]);

    if (srcRes.status === 401 || srcRes.status === 403) return respond(401, { error: 'Invalid source API key.' });
    if (dstRes.status === 401 || dstRes.status === 403) return respond(401, { error: 'Invalid destination API key.' });
    if (!srcRes.ok) return respond(400, { error: `Source account error: HTTP ${srcRes.status}` });
    if (!dstRes.ok) return respond(400, { error: `Destination account error: HTTP ${dstRes.status}` });

    const [srcData, dstData] = await Promise.all([srcRes.json(), dstRes.json()]);

    const srcCompany = srcData?.data?.company_name || srcData?.data?.name || srcData?.company_name || '';
    const dstCompany = dstData?.data?.company_name || dstData?.data?.name || dstData?.company_name || '';

    const sessionToken = makeSessionToken({ srcKey, srcBase, dstKey, dstBase });

    return respond(200, {
      sessionToken,
      src: { company: srcCompany, region: srcBase },
      dst: { company: dstCompany, region: dstBase },
    });

  } catch (err) {
    return respond(400, { error: err.message || 'Validation failed' });
  }
};
