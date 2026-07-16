const { zuper, respond, parseSession } = require('./_helpers');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});

  const { sessionToken, module, level, selected } = event.queryStringParameters || {};
  const session = parseSession(sessionToken);
  if (!session) return respond(401, { error: 'Invalid or expired session.' });

  const sel = selected ? selected.split(',').map(s => s.trim()).filter(Boolean) : [];

  try {
    let data = [];

    if (module === 'jobs') {
      if (level === 'categories') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/job-categories?page=1&page_size=200', null);
        data = (r.data || []).map(c => ({ id: c.job_category_uid, name: c.job_category_name }));
      } else if (level === 'statuses') {
        const allStatuses = new Map();
        await Promise.all(sel.map(async (catId) => {
          const r = await zuper(session.srcBase, session.srcKey, 'GET', `/job-status?job_category_uid=${catId}`, null);
          (r.data || []).forEach(s => allStatuses.set(s.job_status_uid, { id: s.job_status_uid, name: s.job_status_name }));
        }));
        data = [...allStatuses.values()];
      } else if (level === 'checklists') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/checklists?page=1&page_size=200', null);
        data = (r.data || []).map(c => ({ id: c.checklist_uid, name: c.checklist_name }));
      }
    }

    else if (module === 'customers') {
      if (level === 'types') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/customer-types?page=1&page_size=200', null);
        data = (r.data || []).map(t => ({ id: t.customer_type_uid, name: t.customer_type_name }));
      } else if (level === 'tags') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/customer-tags?page=1&page_size=200', null);
        data = (r.data || []).map(t => ({ id: t.tag_uid || t.tag, name: t.tag }));
      }
    }

    else if (module === 'assets') {
      if (level === 'categories') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/asset-categories?page=1&page_size=200', null);
        data = (r.data || []).map(c => ({ id: c.asset_category_uid, name: c.asset_category_name }));
      } else if (level === 'statuses') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/asset-statuses?page=1&page_size=200', null);
        data = (r.data || []).map(s => ({ id: s.asset_status_uid, name: s.asset_status_name }));
      }
    }

    else if (module === 'users') {
      if (level === 'roles') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/roles?page=1&page_size=200', null);
        data = (r.data || []).map(r => ({ id: r.role_uid, name: r.role_name }));
      } else if (level === 'teams') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/teams?page=1&page_size=200', null);
        data = (r.data || []).map(t => ({ id: t.team_uid, name: t.team_name }));
      }
    }

    else if (module === 'products') {
      if (level === 'categories') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/product-categories?page=1&page_size=200', null);
        data = (r.data || []).map(c => ({ id: c.product_category_uid, name: c.product_category_name }));
      } else if (level === 'items') {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', `/products?page=1&page_size=200&category_uid=${sel.join(',')}`, null);
        data = (r.data || []).map(p => ({ id: p.product_uid, name: p.product_name }));
      }
    }

    else if (module === 'timesheets' && level === 'types') {
      data = [
        { id: 'regular', name: 'Regular' },
        { id: 'overtime', name: 'Overtime' },
        { id: 'travel', name: 'Travel time' },
      ];
    }

    else if (module === 'invoices' && level === 'statuses') {
      data = [
        { id: 'draft', name: 'Draft' },
        { id: 'sent', name: 'Sent' },
        { id: 'paid', name: 'Paid' },
        { id: 'overdue', name: 'Overdue' },
        { id: 'voided', name: 'Voided' },
      ];
    }

    else if (module === 'contracts' && level === 'types') {
      const r = await zuper(session.srcBase, session.srcKey, 'GET', '/contract-types?page=1&page_size=200', null);
      data = (r.data || []).map(c => ({ id: c.contract_type_uid, name: c.contract_type_name }));
    }

    else if (module === 'vendors' && level === 'categories') {
      const r = await zuper(session.srcBase, session.srcKey, 'GET', '/vendor-categories?page=1&page_size=200', null);
      data = (r.data || []).map(c => ({ id: c.vendor_category_uid, name: c.vendor_category_name }));
    }

    else if (module === 'forms' && level === 'forms') {
      const r = await zuper(session.srcBase, session.srcKey, 'GET', '/forms?page=1&page_size=200', null);
      data = (r.data || []).map(f => ({ id: f.form_uid, name: f.form_name }));
    }

    return respond(200, { data });
  } catch (err) {
    return respond(500, { error: err.message || 'Failed to fetch data' });
  }
};
