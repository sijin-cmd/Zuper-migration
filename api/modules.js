const { zuper, respond, parseSession } = require('./_helpers');

const MODULE_PROBES = [
  { key: 'jobs',         name: 'Job categories',  desc: 'Categories, statuses, checklists', endpoint: '/job-categories?page=1&page_size=1' },
  { key: 'customers',    name: 'Customers',        desc: 'Types, contacts, organisations',   endpoint: '/customers?page=1&page_size=1' },
  { key: 'products',     name: 'Parts & services', desc: 'Parts and service items',          endpoint: '/products?page=1&page_size=1' },
  { key: 'assets',       name: 'Assets',           desc: 'Categories and assets',            endpoint: '/assets?page=1&page_size=1' },
  { key: 'workflows',      name: 'Workflows',           desc: 'Automation workflows',             endpoint: '/workflows?page=1&page_size=1' },
  { key: 'customfields',   name: 'Custom fields',       desc: 'Custom fields across all modules', endpoint: '/settings/custom_fields?module_name=JOB' },
  { key: 'emailtemplates', name: 'Email & SMS templates', desc: 'Email and SMS notification templates', endpoint: '/misc/email_template?count=1&page=1' },
];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, {});

  const sessionToken = req.query?.sessionToken;
  const session = parseSession(sessionToken);
  if (!session) return respond(res, 401, { error: 'Invalid or expired session.' });

  try {
    const results = await Promise.allSettled(
      MODULE_PROBES.map(m =>
        zuper(session.srcBase, session.srcKey, 'GET', m.endpoint, null)
          .then(() => ({ ...m, available: true }))
          .catch(() => ({ ...m, available: false }))
      )
    );

    const modules = results
      .map(r => r.value)
      .filter(m => m.available)
      .map(({ key, name, desc }) => ({ key, name, desc }));

    return respond(res, 200, { modules });
  } catch (err) {
    return respond(res, 500, { error: err.message });
  }
};
