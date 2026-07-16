const { respond, parseSession } = require('./_helpers');

function extractList(r) {
  if (!r) return [];
  if (Array.isArray(r)) return r;
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.result)) return r.result;
  return [];
}

async function zuperFetch(baseUrl, apiKey, path) {
  const url = `${baseUrl}/api${path}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.message || body.error || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

async function safe(fn) { try { return await fn(); } catch(e) { return null; } }

const CF_MODULES = ['JOB','CUSTOMER','ORGANIZATION','PROPERTY','PRODUCT','ASSET','ESTIMATE','INVOICE'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, {});

  const params = req.query || {};
  const { sessionToken, module, sub, selected } = params;
  const session = parseSession(sessionToken);
  if (!session) return respond(res, 401, { error: 'Invalid or expired session.' });
  const sel = selected ? selected.split(',').map(s => s.trim()).filter(Boolean) : [];

  try {

    // ── SUMMARY ──────────────────────────────────────────────────────────────
    if (module === 'summary') {
      const [jobCats, productCats, assetCats, customers] = await Promise.all([
        safe(() => zuperFetch(session.srcBase, session.srcKey, '/jobs/category')),
        safe(() => zuperFetch(session.srcBase, session.srcKey, '/products/category')),
        safe(() => zuperFetch(session.srcBase, session.srcKey, '/assets/category')),
        safe(() => zuperFetch(session.srcBase, session.srcKey, '/customers?page=1&page_size=1')),
      ]);
      return respond(res, 200, {
        jobs:         { available: true, count: extractList(jobCats).length },
        customers:    { available: true, count: customers?.total_records || extractList(customers).length },
        parts:        { available: true, count: extractList(productCats).length },
        assets:       { available: true, count: extractList(assetCats).length },
        workflows:    { available: false, count: 0 },
        customfields: { available: true, count: 0 },
      });
    }

    // ── JOBS: CATEGORIES + STATUSES ───────────────────────────────────────────
    // Confirmed field names: category_uid, category_name, job_statuses[]
    // Status fields: status_uid, status_name, status_color
    // NOTE: checklists are NOT in this response — loaded separately per status
    if (module === 'jobs' && sub === 'categories') {
      const r = await zuperFetch(session.srcBase, session.srcKey, '/jobs/category?populate_statuses=true');
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(c => ({
          id:   c.category_uid,
          name: c.category_name,
          statuses: (c.job_statuses || []).map(s => ({
            id:    s.status_uid,
            name:  s.status_name,
            color: s.status_color || '#888888',
          })).filter(s => s.id && s.name),
        })).filter(c => c.id && c.name)
      });
    }

    // ── JOBS: CHECKLISTS per status ───────────────────────────────────────────
    // Uses separate catId and statusId params to avoid URL encoding issues
    if (module === 'jobs' && sub === 'checklists') {
      const categoryUid = params.catId || sel[0];
      const statusUid   = params.statusId || sel[1];
      if (!categoryUid || !statusUid) return respond(res, 200, { data: [] });
      const r = await zuperFetch(
        session.srcBase, session.srcKey,
        `/settings/checklist?category_uid=${categoryUid}&job_status_uid=${statusUid}`
      );
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(c => ({
          id:   c.checklist_uid,
          name: c.field_name,
          type: c.field_type || '',
        })).filter(c => c.id && c.name)
      });
    }

    // ── CUSTOMERS ─────────────────────────────────────────────────────────────
    // Confirmed fields: customer_uid, customer_first_name, customer_last_name,
    // customer_email, customer_contact_no.mobile, customer_address,
    // customer_category.category_name, customer_tags
    if (module === 'customers' && sub === 'list') {
      const r = await zuperFetch(session.srcBase, session.srcKey, '/customers?page=1&page_size=200');
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(c => ({
          id:           c.customer_uid,
          name:         `${c.customer_first_name || ''} ${c.customer_last_name || ''}`.trim() || 'Unknown',
          email:        c.customer_email || '',
          phone:        c.customer_contact_no?.mobile || c.customer_contact_no?.work || c.customer_contact_no?.home || '',
          address:      [
            c.customer_address?.street,
            c.customer_address?.city,
            c.customer_address?.state,
          ].filter(Boolean).join(', '),
          tags:         c.customer_tags || [],
          organization: c.customer_company_name || null,
          type:         c.customer_category?.category_name || 'Other',
        })).filter(c => c.id)
      });
    }

    // ── PARTS & SERVICES: CATEGORIES ─────────────────────────────────────────
    if (module === 'parts' && sub === 'categories') {
      const r = await zuperFetch(session.srcBase, session.srcKey, '/products/category');
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(c => ({
          id:   c.product_category_uid || c.category_uid || c._id,
          name: c.product_category_name || c.category_name || c.name,
        })).filter(c => c.id && c.name)
      });
    }

    // ── PARTS & SERVICES: ITEMS ───────────────────────────────────────────────
    // Confirmed fields: product_uid, product_name, product_type, price,
    // product_category.category_uid, product_category.category_name
    // Confirmed filter: /product?category_uid=X
    if (module === 'parts' && sub === 'items') {
      const catId = sel[0];
      const path = catId ? `/product?category_uid=${catId}` : '/product';
      const r = await zuperFetch(session.srcBase, session.srcKey, path);
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(p => ({
          id:       p.product_uid,
          name:     p.product_name,
          sku:      p.product_id || p.sku || '',
          price:    p.price ?? p.unit_price ?? '',
          type:     (p.product_type || 'PART').toUpperCase(),
          category: p.product_category?.category_name || '',
        })).filter(p => p.id && p.name)
      });
    }

    // ── ASSET CATEGORIES ──────────────────────────────────────────────────────
    if (module === 'assets' && sub === 'categories') {
      const r = await zuperFetch(session.srcBase, session.srcKey, '/assets/category');
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(c => ({
          id:   c.asset_category_uid || c.category_uid || c._id,
          name: c.asset_category_name || c.category_name || c.name,
        })).filter(c => c.id && c.name)
      });
    }

    // ── ASSETS LIST ───────────────────────────────────────────────────────────
    if (module === 'assets' && sub === 'list') {
      const catId = sel[0];
      const r = await zuperFetch(session.srcBase, session.srcKey, '/assets?page=1&page_size=200');
      const list = extractList(r);
      // Filter client-side by category_uid since API filter is unreliable
      const filtered = catId
        ? list.filter(a => {
            const ac = a.asset_category || {};
            return ac.category_uid === catId;
          })
        : list;
      return respond(res, 200, {
        data: filtered.map(a => ({
          id:        a.asset_uid,
          name:      a.asset_name,
          serial:    a.asset_serial_number || '',
          installed: a.placed_in_service || a.created_at || '',
          category:  a.asset_category?.category_name || '',
        })).filter(a => a.id && a.name)
      });
    }

    // ── WORKFLOWS ─────────────────────────────────────────────────────────────
    if (module === 'inspectionforms' && sub === 'list') {
      const r = await zuperFetch(session.srcBase, session.srcKey, '/assets/inspection_form/master?count=200&page=1&sort=DESC&sort_by=created_at');
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(f => ({
          id:         f.asset_form_uid,
          name:       f.asset_form_name,
          fieldCount: (f.asset_form_fields || []).length,
        })).filter(f => f.id && f.name)
      });
    }

    if (module === 'workflows' && sub === 'list') {
      const r = await zuperFetch(session.srcBase, session.srcKey, '/workflow?count=200&page=1&sort=DESC&sort_by=created_at');
      const list = extractList(r);
      return respond(res, 200, {
        data: list.map(w => ({
          id:   w.workflow_uid,
          name: w.workflow_name,
        })).filter(w => w.id && w.name)
      });
    }

    // ── EMAIL & SMS TEMPLATES ─────────────────────────────────────────────────
    if (module === 'emailtemplates' && sub === 'list') {
      // Paginate through all templates (API returns up to 100 per page)
      let page = 1;
      const allTemplates = [];
      while (true) {
        const r = await zuperFetch(
          session.srcBase, session.srcKey,
          `/misc/email_template?count=100&page=${page}&sort=DESC&sort_by=created_at&filter.keyword=`
        );
        const list = extractList(r);
        if (!list.length) break;
        allTemplates.push(...list);
        if (allTemplates.length >= (r.total_records || list.length)) break;
        page++;
      }
      return respond(res, 200, {
        data: allTemplates.map(t => ({
          id:          t.template_uid,
          name:        t.template_name,
          type:        t.type,           // 'EMAIL' or 'SMS'
          module:      t.template_module,
          description: t.template_description || '',
          is_active:   t.is_active,
        })).filter(t => t.id && t.name)
      });
    }

    // ── CUSTOM FIELDS (grouped) ───────────────────────────────────────────────
    if (module === 'customfields') {
      const modName = (sub || '').toUpperCase();
      if (!CF_MODULES.includes(modName)) return respond(res, 400, { error: 'Unknown module: ' + sub });
      const r = await zuperFetch(
        session.srcBase, session.srcKey,
        `/settings/custom_fields?module_name=${modName}&sort=ASC&sort_by=display_order`
      );
      const list = extractList(r);
      const groupsMap = new Map();
      list.forEach(f => {
        const grp = f.group;
        const key  = grp?.group_uid  || '__default__';
        const name = grp?.group_name || 'Default fields';
        if (!groupsMap.has(key)) groupsMap.set(key, { id: key, name, fields: [] });
        groupsMap.get(key).fields.push({
          id:       f.custom_field_uid,
          name:     f.field_name,
          type:     f.field_type,
          required: f.is_required || false,
          options:  f.field_options || [],
        });
      });
      return respond(res, 200, { groups: [...groupsMap.values()] });
    }

    return respond(res, 400, { error: `Unknown: ${module}/${sub}` });

  } catch (err) {
    return respond(res, 500, { error: err.message || 'Request failed', status: err.status || null });
  }
};
