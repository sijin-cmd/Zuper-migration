const { zuper, respond, parseBody, parseSession } = require('./_helpers');

// NOTE (Vercel): this handler buffers all NDJSON lines in memory and writes them
// in a single response only after the whole migration loop finishes — it does not
// stream incrementally, on Netlify or here. For large migrations this can run past
// Vercel's serverless function execution limit (10s Hobby / up to 300s Pro,
// configurable via `maxDuration` in vercel.json or a route segment config).
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return respond(res, 204, {});
  if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });

  const body = parseBody(req);
  if (!body) return respond(res, 400, { error: 'Invalid JSON' });

  const { sessionToken, selections } = body;
  const session = parseSession(sessionToken);
  if (!session) return respond(res, 401, { error: 'Invalid or expired session.' });

  const lines = [];
  function emit(obj) { lines.push(JSON.stringify(obj)); }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  let migrated = 0, skipped = 0, failed = 0;

  // ── HELPER: build checklist field payload ─────────────────────────────────
  // Shared between checklist→checklist and checklist→inspection-form paths.
  // dependentFieldsArr: already-resolved array with destination UIDs (or []).
  // nameBasedDep: { on, options } for the name-based mechanism (or null/undefined).
  //
  // CONFIRMED (via live API, 2026-08-06): this account's checklist fields use TWO
  // independent, mutually-exclusive dependency mechanisms:
  //   1) Name-based — `dependent_on` holds the PARENT FIELD'S NAME as plain text (NOT
  //      a UID), paired with `dependent_options` (trigger value(s)). Names are
  //      preserved verbatim, so this needs no UID remapping.
  //   2) UID-based — `dependent_fields[]` holds {field_uid, field_value, ...}
  //      conditions where field_uid is another field's checklist_uid — needs
  //      remapping to the destination UID.
  // ALSO CONFIRMED (2026-08-06, destination re-check): POST /settings/checklist/new
  // silently drops dependency data of EITHER style if sent at creation time — a
  // field created with dependency data already populated still lands with
  // is_dependent:false. So Pass 1 creates with dependentFieldsArr=[] (no dependency
  // at all), then Pass 2 PATCHes the dependency in via PUT — see the loop below.
  //
  // ALSO CONFIRMED (2026-08-06, second destination re-check): `dependent_on` /
  // `dependent_options` are NOT a writable mechanism at all — tried both as the raw
  // source name AND as a resolved destination UID, PUT returned success both times,
  // neither persisted. Meanwhile `dependent_fields[]` verified correctly with real
  // destination UIDs. Conclusion: dependent_on/dependent_options are read-only
  // legacy display fields; `dependent_fields[]` is the only real write mechanism.
  // So name-based dependencies are now synthesized into a dependent_fields[] entry
  // by the caller (see Pass 2) instead of being passed here — this function no
  // longer sets dependent_on/dependent_options to anything but their empty defaults.
  function buildChecklistFieldPayload(field, dependentFieldsArr) {
    const t = field.original_template || {};
    const fieldType = t.field_type || field.field_type || 'SINGLE_LINE';
    const hasDep = !!(dependentFieldsArr && dependentFieldsArr.length > 0);
    const payload = {
      display_order:        field.display_order || 1,
      label:                t.label            || field.field_name || '',
      description:          t.description      || '',
      checklist_view_type:  t.checklist_view_type || field.checklist_view_type || 'SINGLE_PAGE',
      field_type:           fieldType,
      component:            t.component        || 'textInput',
      placeholder:          t.placeholder      || '',
      validation:           t.validation       || '',
      required:             t.required         || false,
      read_only:            t.read_only        || false,
      hide_field:           t.hide_field       || false,
      hide_to_fe:           t.hide_to_fe       || false,
      options:              t.options          || [],
      default_option:       t.default_option   || null,
      is_dependent:         hasDep,
      dependent_on:         null,
      dependent_options:    [],
      dependent_fields:     dependentFieldsArr  || [],
      copy_to_field:        null,
      copy_to_custom_field: null,
      meta_options: {
        restrict_status_update: { restricted_options: [] },
      },
      restrict_status_update: { restricted_options: [] },
    };

    // FIX #3 — TABLE field type: pass field_meta through as-is
    if (fieldType === 'TABLE' && field.field_meta) {
      payload.field_meta = field.field_meta;
    }

    return payload;
  }

  // ── HELPER: build inspection-form field payload for POST (create) ───────────
  function buildInspectionFieldPostPayload(field, dependentFieldsArr) {
    const t = field.original_template || {};
    const fieldType = t.field_type || field.field_type || field.type || 'SINGLE_LINE';
    let component = t.component || 'textInput';
    if (component === 'header') component = 'sectionHeader';

    const payload = {
      display_order:     field.display_order  || 1,
      label:             t.label              || field.field_name || '',
      description:       t.description        || '',
      type:              fieldType,
      component,
      placeholder:       t.placeholder        || '',
      validation:        t.validation         || '',
      is_required:       t.required           || false,
      read_only:         t.read_only          || false,
      hide_field:        t.hide_field         || false,
      hide_to_fe:        t.hide_to_fe         || false,
      field_options:     t.options            || [],
      default_option:    t.default_option     || false,
      meta_options:      t.meta_options       || {},
      is_dependent:      !!(dependentFieldsArr && dependentFieldsArr.length > 0),
      dependent_fields:  dependentFieldsArr   || [],
    };

    // FIX #3 — TABLE field type: pass field_meta through as-is
    if (fieldType === 'TABLE' && field.field_meta) {
      payload.field_meta = field.field_meta;
    }

    return payload;
  }

  // ── HELPER: build inspection-form field payload for PUT (update/patch) ───────
  // Leaner shape confirmed from DevTools — no validation, placeholder,
  // default_option. Just the core fields + dependent_fields.
  function buildInspectionFieldPutPayload(field, dependentFieldsArr) {
    const t = field.original_template || {};
    const fieldType = t.field_type || field.field_type || field.type || 'SINGLE_LINE';
    let component = t.component || 'textInput';
    if (component === 'header') component = 'sectionHeader';

    const payload = {
      display_order:    field.display_order || 1,
      label:            t.label             || field.field_name || '',
      description:      t.description       || '',
      type:             fieldType,
      component,
      meta_options:     t.meta_options      || {},
      field_options:    t.options           || [],
      is_required:      t.required          || false,
      read_only:        t.read_only         || false,
      hide_field:       t.hide_field        || false,
      hide_to_fe:       t.hide_to_fe        || false,
      is_dependent:     !!(dependentFieldsArr && dependentFieldsArr.length > 0),
      dependent_fields: dependentFieldsArr  || [],
    };

    // FIX #3 — TABLE field type: pass field_meta through as-is
    if (fieldType === 'TABLE' && field.field_meta) {
      payload.field_meta = field.field_meta;
    }

    return payload;
  }

  // ── HELPER: two-pass checklist field creation with dependency resolution ──
  // FIX #1 — Dependencies use destination UIDs, so we:
  //   Pass 1: create all fields without dependencies → collect src→dst UID map
  //   Pass 2: patch fields that have dependencies, substituting dst UIDs
  async function migrateChecklistFields(fields, postField) {
    // postField(field, dependentFieldsArr) → Promise<{ dst_uid, field_name }>
    // postField must return the destination UID of the created field.

    const srcToDst = {}; // srcFieldUid → dstFieldUid

    // Pass 1: create all fields without dependencies
    for (const field of fields) {
      try {
        const dstUid = await postField(field, []);
        if (dstUid && field.checklist_uid) {
          srcToDst[field.checklist_uid] = dstUid;
        }
      } catch(_) { /* individual field errors handled inside postField */ }
      await delay(80);
    }

    // Pass 2: patch fields that have dependent_fields
    const fieldsWithDeps = fields.filter(f =>
      f.dependent_fields && f.dependent_fields.length > 0
    );

    for (const field of fieldsWithDeps) {
      const dstFieldUid = srcToDst[field.checklist_uid];
      if (!dstFieldUid) continue; // wasn't created in pass 1, skip

      // Resolve each dependency's field_uid from src → dst
      const resolvedDeps = field.dependent_fields.map(dep => ({
        field_name:     dep.field_name,
        field_value:    dep.field_value,
        field_uid:      srcToDst[dep.field_uid] || dep.field_uid, // fallback to src uid if not found
        field_in:       dep.field_in       || 'CHECKLIST',
        condition_type: dep.condition_type || 'AND',
        operator:       dep.operator       || 'CONTAINS',
      }));

      try {
        await postField(field, resolvedDeps, dstFieldUid);
      } catch(_) { /* patch errors are non-fatal */ }
      await delay(80);
    }
  }

  // ── HELPER: Pass 2 dependency linking for an inspection form ───────────────
  // Mirrors the CHECKLISTS → CHECKLISTS Pass 2 logic. Used by both inspection
  // form paths (form → form, checklist → form). Previously those paths:
  //   - trusted the field-create response for the new field UID (create endpoints
  //     don't reliably echo it — when missing, every dependency was silently skipped),
  //   - ignored name-based dependencies (`dependent_on` / `dependent_options`),
  //   - swallowed every Pass 2 error.
  // Now: re-fetch the destination form after Pass 1, match src→dst fields by name
  // in display order, synthesize name-based deps into dependent_fields[] (the only
  // writable mechanism — see buildChecklistFieldPayload notes), and report failures.
  const fieldNameOf = f => (f.field_name || (f.original_template || {}).label || f.label || '').toLowerCase().trim();
  const fieldUidOf  = f => f.checklist_uid || f.field_uid || f._id || null;
  const depsOf      = f => {
    const t = f.original_template || {};
    if (Array.isArray(f.dependent_fields) && f.dependent_fields.length) return f.dependent_fields;
    if (Array.isArray(t.dependent_fields) && t.dependent_fields.length) return t.dependent_fields;
    return [];
  };
  const dependentOnOf = f => (f.original_template || {}).dependent_on || f.dependent_on || null;

  async function linkInspectionFormDependencies(newFormUid, srcFields, formLabel) {
    const fieldsWithDeps = srcFields.filter(f => depsOf(f).length > 0 || !!dependentOnOf(f));
    if (!fieldsWithDeps.length) return;

    // Build src→dst UID map from the destination form as it actually landed
    const srcToDst = {};
    try {
      const r = await zuper(session.dstBase, session.dstKey, 'GET',
        '/assets/inspection_form/master?count=200&page=1&sort=DESC&sort_by=created_at', null);
      const dstForms = r?.data || (Array.isArray(r) ? r : []);
      const dstForm = dstForms.find(f => f.asset_form_uid === newFormUid);
      if (!dstForm) throw new Error('newly created form not found in destination form list');
      const dstFields = (dstForm.asset_form_fields || [])
        .slice()
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
      const byName = new Map();
      dstFields.forEach(f => {
        const key = fieldNameOf(f);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(fieldUidOf(f));
      });
      srcFields.forEach(f => {
        const bucket = byName.get(fieldNameOf(f));
        const dstUid = bucket && bucket.length ? bucket.shift() : null;
        const srcUid = fieldUidOf(f);
        if (dstUid && srcUid) srcToDst[srcUid] = dstUid;
      });
    } catch(e) {
      emit({ type: 'error', message: `Could not map destination field UIDs for dependency linking (${formLabel}): ${e.message}` });
      return;
    }

    const srcByName = new Map();
    srcFields.forEach(f => srcByName.set(fieldNameOf(f), fieldUidOf(f)));

    for (const field of fieldsWithDeps) {
      const fieldName = field.field_name || (field.original_template || {}).label || '';
      const dstFieldUid = srcToDst[fieldUidOf(field)];
      if (!dstFieldUid) {
        failed++;
        emit({ type: 'record', status: 'error', name: `Dependency link: ${fieldName} (${formLabel})`, reason: 'Could not resolve this field’s destination UID — dependency not linked', migrated, skipped, failed });
        continue;
      }

      // Inspection form PUT only accepts field_in 'INSPECTION_FORM' | 'CUSTOM_FIELDS'
      // (CONFIRMED 2026-10-03 — 'CHECKLIST' is rejected as an invalid enum value).
      // Keep CUSTOM_FIELDS refs as-is; anything else points at a sibling form field.
      const inspectionFieldIn = v => (v === 'CUSTOM_FIELDS' ? 'CUSTOM_FIELDS' : 'INSPECTION_FORM');

      const deps = depsOf(field);
      const unresolved = deps.filter(dep => !srcToDst[dep.field_uid]);
      const resolvedDeps = deps.map(dep => ({
        field_name:     dep.field_name,
        field_value:    dep.field_value,
        field_uid:      srcToDst[dep.field_uid] || dep.field_uid,
        field_in:       inspectionFieldIn(dep.field_in),
        condition_type: dep.condition_type || 'AND',
        operator:       dep.operator       || 'CONTAINS',
      }));

      // Name-based dependency → synthesize a dependent_fields[] entry
      const sourceDependentOnName = dependentOnOf(field);
      let unresolvedNameDep = false;
      if (sourceDependentOnName) {
        const parentSrcUid = srcByName.get(sourceDependentOnName.toLowerCase().trim());
        const parentDstUid = parentSrcUid ? srcToDst[parentSrcUid] : null;
        if (parentDstUid) {
          resolvedDeps.push({
            field_name:     sourceDependentOnName,
            field_value:    (field.original_template || {}).dependent_options || field.dependent_options || [],
            field_uid:      parentDstUid,
            field_in:       'INSPECTION_FORM',
            condition_type: 'AND',
            operator:       'CONTAINS',
          });
        } else {
          unresolvedNameDep = true;
        }
      }

      try {
        const fieldPayload = buildInspectionFieldPutPayload(field, resolvedDeps);
        await zuper(session.dstBase, session.dstKey, 'PUT',
          `/assets/inspection_form/${newFormUid}/${dstFieldUid}`,
          { asset_form_field: fieldPayload }
        );
        if (unresolved.length) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Dependency link: ${fieldName} (${formLabel})`, reason: `${unresolved.length} dependency target(s) not found in destination (e.g. "${unresolved[0].field_name}") — linked with a stale source UID`, migrated, skipped, failed });
        }
        if (unresolvedNameDep) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Dependency link: ${fieldName} (${formLabel})`, reason: `Parent field "${sourceDependentOnName}" not found/not migrated in destination — name-based dependency not linked`, migrated, skipped, failed });
        }
      } catch(e) {
        failed++;
        emit({ type: 'record', status: 'error', name: `Dependency link: ${fieldName} (${formLabel})`, reason: e.message, migrated, skipped, failed });
      }
      await delay(20);
    }
  }

  try {

    // ── JOBS ──────────────────────────────────────────────────────────────────
    if (selections.jobs?.categories?.length) {
      emit({ type: 'progress', message: 'Migrating job categories and statuses…' });

      let srcCats = [];
      try {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/jobs/category?populate_statuses=true', null);
        srcCats = r?.data || (Array.isArray(r) ? r : []);
      } catch(e) {
        emit({ type: 'error', message: 'Could not fetch source job categories: ' + e.message });
      }

      const selectedCatIds = selections.jobs.categories;
      const selectedStatusIds = new Set(selections.jobs.statuses || []);

      for (const catId of selectedCatIds) {
        const srcCat = srcCats.find(c => c.category_uid === catId);
        if (!srcCat) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Category ${catId}`, reason: 'Not found in source', migrated, skipped, failed });
          continue;
        }

        let dstCatUid = null;
        try {
          const catRes = await zuper(session.dstBase, session.dstKey, 'POST', '/jobs/category', {
            category: {
              category_name: srcCat.category_name,
              estimated_duration: srcCat.estimated_duration || { days: 0, hours: 0, minutes: 0 },
              auto_create_status: false,
            },
          });
          dstCatUid = catRes?.data?.category_uid
                   || catRes?.data?.job_category_uid
                   || catRes?.category_uid
                   || catRes?.job_category_uid
                   || null;
          const responseKeys = JSON.stringify(catRes?.data || catRes || {});
          migrated++;
          emit({ type: 'record', status: 'ok', name: `Category: ${srcCat.category_name} [uid=${dstCatUid}, resp=${responseKeys.slice(0,120)}]`, migrated, skipped, failed });
        } catch (e) {
          if (e.status === 409) {
            skipped++;
            emit({ type: 'record', status: 'skip', name: `Category: ${srcCat.category_name}`, reason: 'Already exists', migrated, skipped, failed });
            try {
              const existing = await zuper(session.dstBase, session.dstKey, 'GET', '/jobs/category', null);
              const list = existing?.data || (Array.isArray(existing) ? existing : []);
              const match = list.find(c =>
                (c.category_name || c.job_category_name || '').toLowerCase() === srcCat.category_name.toLowerCase()
              );
              dstCatUid = match?.category_uid || match?.job_category_uid || null;
            } catch(_) {}
          } else {
            failed++;
            const rawDetail = e.raw ? ` [raw: ${JSON.stringify(e.raw).slice(0, 400)}]` : '';
            emit({ type: 'record', status: 'error', name: `Category: ${srcCat.category_name}`, reason: e.message + rawDetail, migrated, skipped, failed });
          }
        }
        await delay(80);

        const srcStatuses = srcCat.job_statuses || [];
        for (const srcStatus of srcStatuses) {
          const uid   = srcStatus.status_uid;
          const name  = srcStatus.status_name;
          const color = srcStatus.status_color || '#888888';
          const type  = srcStatus.status_type || 'NEW';

          if (!selectedStatusIds.has(uid)) continue;
          if (!dstCatUid) {
            failed++;
            emit({ type: 'record', status: 'error', name: `Status: ${name}`, reason: `Parent category uid not found`, migrated, skipped, failed });
            continue;
          }
          try {
            await zuper(session.dstBase, session.dstKey, 'POST', `/jobs/status_new/${dstCatUid}`, {
              job_status: { status_name: name, status_color: color, status_type: type },
            });
            migrated++;
            emit({ type: 'record', status: 'ok', name: `Status: ${name} (${srcCat.category_name})`, migrated, skipped, failed });
          } catch (e) {
            if (e.status === 409) {
              skipped++;
              emit({ type: 'record', status: 'skip', name: `Status: ${name}`, reason: 'Already exists', migrated, skipped, failed });
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: `Status: ${name}`, reason: e.message, migrated, skipped, failed });
            }
          }
          await delay(80);
        }
      }
    }

    // ── ASSETS ────────────────────────────────────────────────────────────────
    if (selections.assets?.assets) {
      const allAssetIds = Object.values(selections.assets.assets).flat().filter(Boolean);
      if (allAssetIds.length) {
        emit({ type: 'progress', message: 'Migrating assets…' });
        for (const assetId of allAssetIds) {
          try {
            const a = await zuper(session.srcBase, session.srcKey, 'GET', `/assets/${assetId}`, null);
            const ad = a.data || a;
            await zuper(session.dstBase, session.dstKey, 'POST', '/assets', {
              asset_name:          ad.asset_name          || '',
              asset_description:   ad.asset_description   || null,
              asset_serial_number: ad.asset_serial_number || '',
              asset_quantity:      ad.asset_quantity       || 1,
              asset_category:      ad.asset_category?.category_uid || ad.asset_category || null,
            });
            migrated++;
            emit({ type: 'record', status: 'ok', name: ad.asset_name, migrated, skipped, failed });
          } catch (e) {
            if (e.status === 409) {
              skipped++;
              emit({ type: 'record', status: 'skip', name: assetId, reason: 'Already exists', migrated, skipped, failed });
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: assetId, reason: e.message, migrated, skipped, failed });
            }
          }
          await delay(80);
        }
      }
    }

    // ── PARTS & SERVICES ──────────────────────────────────────────────────────
    // Mirrors the proven pattern from the sibling Zuper-CPQ migration tool:
    // category remap-with-create-on-miss, product de-dup by product_id/name,
    // and a two-pass BUNDLE resolution (all non-BUNDLE products are created/
    // matched first so their destination UIDs are known before a BUNDLE's
    // associated_products gets remapped).
    //
    // Business units and warehouse locations are remapped by name (bu_name /
    // location_name) rather than UID, same as categories — source-account UIDs
    // never carry over. Neither has a confirmed create API, so an unmatched
    // source BU/location is dropped (not invented) and noted on the record's
    // log line. Business units aren't a standalone list in Zuper — they're
    // harvested from each category's nested business_unit[] (confirmed
    // 2026-08-07 via GET /products/category).
    if (selections.parts?.items) {
      const selectedItemIds = Object.values(selections.parts.items).flat().filter(Boolean);
      if (selectedItemIds.length) {
        emit({ type: 'progress', message: 'Migrating parts & services…' });

        const catObjUid  = c => c.product_category_uid || c.category_uid || c.uid || c._id || '';
        const catObjName = c => c.product_category_name || c.category_name || c.name || c.label || '';
        function catNameFromProduct(cat) {
          if (!cat) return '';
          if (typeof cat === 'object') return (cat.category_name || cat.product_category_name || '').toLowerCase().trim();
          return String(cat).toLowerCase().trim();
        }
        function prodUidFromRef(p) {
          return typeof p === 'object' ? (p?.product_uid || p?._id || '') : (p || '');
        }
        function locNameFromRef(loc) {
          if (!loc) return '';
          if (typeof loc === 'object') return (loc.location_name || '').toLowerCase().trim();
          return String(loc).toLowerCase().trim();
        }
        function isAlreadyExists(e) {
          return e.status === 409 || /already exists/i.test(e.message || '');
        }

        async function fetchAllProductPages(path) {
          const results = [];
          let page = 1;
          const count = 150;
          while (true) {
            const sep  = path.includes('?') ? '&' : '?';
            const data = await zuper(session.dstBase, session.dstKey, 'GET', `${path}${sep}count=${count}&page=${page}`, null);
            const items = data?.data || [];
            results.push(...items);
            const totalPages = data?.total_pages;
            if (totalPages != null) { if (page >= totalPages) break; }
            else if (items.length < count) break;
            page++;
            if (page > 500) break; // safety cap
          }
          return results;
        }

        async function fetchAllSrcProductPages(path) {
          const results = [];
          let page = 1;
          while (true) {
            const sep  = path.includes('?') ? '&' : '?';
            const data = await zuper(session.srcBase, session.srcKey, 'GET', `${path}${sep}count=150&page=${page}`, null);
            const items = data?.data || [];
            results.push(...items);
            const totalPages = data?.total_pages;
            if (totalPages != null) { if (page >= totalPages) break; }
            else if (items.length < 150) break;
            page++;
            if (page > 500) break; // safety cap
          }
          return results;
        }

        // Confirmed create contract (2026-08-07, live POST /product on a staging
        // account): product_category/location are plain destination UIDs (not
        // nested objects), option_values are per-product and simply regenerate
        // fresh (no cross-account UID to remap), custom_fields/formula are NOT
        // part of this payload — they're set through separate endpoints not yet
        // shared, so they're intentionally left out of v1.
        //
        // Locations are matched by location_name only — no create-location API
        // has been confirmed (unlike categories), so an unmatched source location
        // is dropped from location_availability rather than invented.
        function resolveLocationAvailability(srcList, destLocsByName) {
          const resolved   = [];
          const unresolved = [];
          for (const entry of srcList || []) {
            const name   = locNameFromRef(entry.location);
            const dstUid = name ? destLocsByName[name] : '';
            if (dstUid) {
              resolved.push({
                location:     dstUid,
                min_quantity: entry.min_quantity ?? 0,
                quantity:     entry.quantity ?? 0,
                serial_nos:   entry.serial_nos || [],
              });
            } else {
              unresolved.push(entry.location?.location_name || name || 'unknown');
            }
          }
          return { resolved, unresolved };
        }

        function buildProductCreatePayload(src, dstCategoryUid, dstLocationAvailability, dstBuUids) {
          return {
            prefix:                src.prefix || '',
            product_name:          src.product_name || '',
            product_id:            src.product_id || '',
            is_available:          src.is_available !== undefined ? src.is_available : true,
            product_category:      dstCategoryUid || '',
            price:                 src.price ?? 0,
            min_quantity:          src.min_quantity ?? 0,
            currency:              src.currency || '',
            quantity:              src.quantity ?? 0,
            product_manual_link:   src.product_manual_link || '',
            product_description:   src.product_description || '',
            product_image:         src.product_image || '',
            product_type:          src.product_type || 'PARTS',
            pricing_level:         src.pricing_level || 'ROLLUP',
            purchase_price:        src.purchase_price ?? null,
            pre_tax_cost:          src.pre_tax_cost ?? null,
            purchase_tax:          src.purchase_tax ?? null,
            brand:                 src.brand || '',
            track_quantity:        src.track_quantity || false,
            specification:         src.specification || '',
            has_custom_tax:        src.has_custom_tax || false,
            meta_data:             [],
            uom:                   src.uom || '',
            is_billable:           src.is_billable !== undefined ? src.is_billable : true,
            is_commissionable:     src.is_commissionable !== undefined ? src.is_commissionable : true,
            bu_uids:               (dstBuUids && dstBuUids.length) ? dstBuUids : null,
            location_availability: dstLocationAvailability || [],
            tax: {
              tax_exempt: src.tax?.tax_exempt || false,
              tax_name:   src.tax?.tax_name   || '',
              tax_rate:   src.tax?.tax_rate   || '',
            },
            markup:        src.markup ?? null,
            product_files: src.product_files || [],
            option: {
              customer_selection:         src.option?.customer_selection || false,
              mandate_customer_selection: src.option?.mandate_customer_selection || false,
              option_label:               src.option?.option_label || 'Option',
              option_values: (src.option?.option_values || []).map(v => ({
                option_value: v.option_value,
                option_image: v.option_image || '',
                is_available: v.is_available !== undefined ? v.is_available : true,
              })),
            },
          };
        }

        // ── Load destination products (for de-dup) ──────────────────────────────
        // A product counts as existing only when its NAME matches (case/space-
        // insensitive) — and if both sides carry a product_id, those must match
        // too. Matching on product_id alone produced false "already exists"
        // skips. Deleted/archived destination products are ignored.
        const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const normId   = s => String(s ?? '').trim();
        const destProdsByName = {};   // nameKey → [products]
        const createdThisRun  = {};   // nameKey → [{ product_uid, product_id, product_name }]
        try {
          const dstProds = await fetchAllProductPages('/product');
          for (const p of dstProds) {
            if (p.is_deleted === true || p.is_deleted === 1 || p.is_active === false) continue;
            const nameKey = normName(p.product_name);
            if (nameKey) (destProdsByName[nameKey] = destProdsByName[nameKey] || []).push(p);
          }
        } catch(e) {
          emit({ type: 'error', message: 'Could not load destination products: ' + e.message });
        }

        // Returns { product, reason } for a genuine match, else null.
        function findExistingProduct(src) {
          const nameKey = normName(src.product_name);
          const idKey   = normId(src.product_id);
          if (!nameKey) return null;
          const idOk = p => !idKey || !normId(p.product_id) || normId(p.product_id) === idKey;
          const inDest = (destProdsByName[nameKey] || []).find(idOk);
          if (inDest) {
            return { product: inDest, reason: `Already exists in destination as "${inDest.product_name}"` +
              (normId(inDest.product_id) ? ` (Product ID ${normId(inDest.product_id)})` : '') +
              ` [uid ${inDest.product_uid || inDest._id || '?'}]` };
          }
          const inRun = (createdThisRun[nameKey] || []).find(idOk);
          if (inRun) {
            return { product: inRun, reason: `Duplicate of "${inRun.product_name}" in your selection — already created earlier in this run` };
          }
          return null;
        }
        // Part/Service No (product_id) — verify it landed on the destination
        // product and set it with a minimal PUT if it's blank. Never overwrites
        // a different non-blank value. Returns a note for the log, or ''.
        async function ensureProductId(dstUid, src, createdData) {
          const want = normId(src.product_id);
          if (!want || !dstUid) return '';
          let have = createdData ? normId(createdData.product_id) : null;
          if (have === want) return '';
          try {
            if (have === null || have === '') {
              const r = await zuper(session.dstBase, session.dstKey, 'GET', `/product/${dstUid}`, null);
              have = normId((r?.data || r)?.product_id);
            }
            if (have === want) return '';
            if (have) return `Part/Service No differs in destination ("${have}" vs source "${want}") — left unchanged`;
            await zuper(session.dstBase, session.dstKey, 'PUT', `/product/${dstUid}`, { product: { product_uid: dstUid, product_id: want } });
            const v = await zuper(session.dstBase, session.dstKey, 'GET', `/product/${dstUid}`, null);
            return normId((v?.data || v)?.product_id) === want
              ? `Part/Service No "${want}" set`
              : `Part/Service No "${want}" could not be set — please add it manually`;
          } catch(e) {
            return `Part/Service No "${want}" could not be set: ${e.message}`;
          }
        }

        function rememberCreated(src, newUid) {
          const nameKey = normName(src.product_name);
          if (nameKey) (createdThisRun[nameKey] = createdThisRun[nameKey] || [])
            .push({ product_uid: newUid, product_id: src.product_id, product_name: src.product_name });
        }

        // ── Load destination product categories by name ─────────────────────────
        // Business units aren't a separate migratable list — Zuper only exposes
        // them nested inside each category's business_unit[] (confirmed 2026-08-07
        // via GET /products/category). So the bu_name → bu_uid map is harvested
        // from this same fetch, no extra API call needed.
        const destCatsByName = {};
        const destBuByName   = {};
        // Sub-categories are only exposed nested as child_categories[].category
        // under their parent (confirmed 2026-10-15), so index those too.
        function indexDestCats(list) {
          for (const c of list) {
            const name = catObjName(c).toLowerCase().trim();
            const uid  = catObjUid(c);
            if (name && uid) destCatsByName[name] = uid;
            for (const cc of c.child_categories || []) {
              const child = cc.category || cc;
              if (!child || child.is_deleted) continue;
              const cn = catObjName(child).toLowerCase().trim();
              const cu = catObjUid(child);
              if (cn && cu) destCatsByName[cn] = cu;
            }
          }
        }
        try {
          const dstCats = await fetchAllProductPages('/products/category');
          indexDestCats(dstCats);
          for (const c of dstCats) {
            for (const bu of c.business_unit || []) {
              const buName = (bu.bu_name || '').toLowerCase().trim();
              if (buName && bu.bu_uid) destBuByName[buName] = bu.bu_uid;
            }
          }
        } catch(e) {
          emit({ type: 'error', message: 'Could not load destination categories: ' + e.message });
        }

        function resolveBusinessUnits(srcList) {
          const resolved   = [];
          const unresolved = [];
          for (const bu of srcList || []) {
            const name   = (bu.bu_name || '').toLowerCase().trim();
            const dstUid = name ? destBuByName[name] : '';
            if (dstUid) resolved.push(dstUid);
            else unresolved.push(bu.bu_name || bu.bu_uid || 'unknown');
          }
          return { resolved, unresolved };
        }

        // ── Load destination locations by name (match-only — no create API confirmed) ──
        const destLocsByName = {};
        try {
          const dstLocs = await fetchAllProductPages('/products/location');
          for (const l of dstLocs) {
            const name = (l.location_name || '').toLowerCase().trim();
            if (name && l.location_uid) destLocsByName[name] = l.location_uid;
          }
        } catch(e) {
          emit({ type: 'error', message: 'Could not load destination locations: ' + e.message });
        }

        // Source sub-category name → its parent category object, so a missing
        // sub-category is recreated under the right parent in the destination.
        const srcParentByChildName = {};
        try {
          const srcCats = await fetchAllSrcProductPages('/products/category');
          for (const c of srcCats) {
            for (const cc of c.child_categories || []) {
              const child = cc.category || cc;
              const cn = catObjName(child || {}).toLowerCase().trim();
              if (cn) srcParentByChildName[cn] = c;
            }
          }
        } catch(e) {
          emit({ type: 'error', message: 'Could not load source categories: ' + e.message });
        }

        async function resolveOrCreateCategory(srcCategory) {
          const catName = catNameFromProduct(srcCategory);
          if (!catName) return '';
          if (destCatsByName[catName]) return destCatsByName[catName];
          const catLabel = typeof srcCategory === 'object'
            ? (srcCategory?.category_name || srcCategory?.product_category_name || catName)
            : catName;
          const srcParent = srcParentByChildName[catName];
          let parentUid = null;
          if (srcParent) {
            parentUid = await resolveOrCreateCategory(srcParent) || null;
            if (!parentUid) emit({ type: 'error', message: `Parent category "${catObjName(srcParent)}" unavailable — creating "${catLabel}" as top-level` });
          }
          try {
            const cr  = await zuper(session.dstBase, session.dstKey, 'POST', '/products/category', {
              product_category: { category_name: catLabel, category_description: '', bu_uids: [], parent_category_uid: parentUid },
            });
            const uid = cr?.data?.category_uid || '';
            if (uid) {
              destCatsByName[catName] = uid;
              emit({ type: 'record', status: 'ok', name: `Category: ${catLabel}`, migrated, skipped, failed });
            }
            return uid;
          } catch(e) {
            if (isAlreadyExists(e)) {
              try {
                indexDestCats(await fetchAllProductPages('/products/category'));
              } catch(_) {}
              return destCatsByName[catName] || '';
            }
            emit({ type: 'error', message: `Could not create category "${catLabel}": ${e.message}` });
            return '';
          }
        }

        // ── Fetch full source detail for every selected item ────────────────────
        const srcProductsByUid = {};
        for (const uid of selectedItemIds) {
          try {
            const r = await zuper(session.srcBase, session.srcKey, 'GET', `/product/${uid}`, null);
            const p = r?.data || r;
            if (p?.product_uid) srcProductsByUid[p.product_uid] = p;
          } catch(e) {
            failed++;
            emit({ type: 'record', status: 'error', name: `Product ${uid}`, reason: 'Could not fetch from source: ' + e.message, migrated, skipped, failed });
          }
          await delay(50);
        }

        // BUNDLEs need their associated_products created first — pull those in
        // too, even if the user didn't select them individually. A bundle is
        // meaningless in the destination without its components.
        const bundleUids = Object.values(srcProductsByUid).filter(p => p.product_type === 'BUNDLE').map(p => p.product_uid);
        for (const bUid of bundleUids) {
          const bundle = srcProductsByUid[bUid];
          for (const ap of bundle.associated_products || []) {
            const apUid = prodUidFromRef(ap.product);
            if (apUid && !srcProductsByUid[apUid]) {
              try {
                const r = await zuper(session.srcBase, session.srcKey, 'GET', `/product/${apUid}`, null);
                const p = r?.data || r;
                if (p?.product_uid) srcProductsByUid[p.product_uid] = p;
              } catch(e) {
                emit({ type: 'progress', message: `Could not fetch bundle component ${ap.product_name || apUid}: ${e.message}` });
              }
              await delay(50);
            }
          }
        }

        // ── Pass 1: create/match every non-BUNDLE product ───────────────────────
        const productUidMap = {}; // srcUid -> dstUid
        const nonBundle = Object.values(srcProductsByUid).filter(p => p.product_type !== 'BUNDLE');
        for (const src of nonBundle) {
          const found = findExistingProduct(src);
          if (found) {
            const exUid = found.product.product_uid || found.product._id || '';
            productUidMap[src.product_uid] = exUid;
            skipped++;
            const idNote = await ensureProductId(exUid, src, found.product);
            emit({ type: 'record', status: 'skip', name: `${src.product_name} (${src.product_type})`, reason: [found.reason, idNote].filter(Boolean).join('; '), migrated, skipped, failed });
            continue;
          }

          const dstCatUid = await resolveOrCreateCategory(src.product_category);
          const { resolved: dstLocationAvailability, unresolved: unresolvedLocs } =
            resolveLocationAvailability(src.location_availability, destLocsByName);
          const { resolved: dstBuUids, unresolved: unresolvedBus } = resolveBusinessUnits(src.business_unit);
          const payload = buildProductCreatePayload(src, dstCatUid, dstLocationAvailability, dstBuUids);
          try {
            const cr     = await zuper(session.dstBase, session.dstKey, 'POST', '/product', { product: payload, vendor: [] });
            const newUid = cr?.data?.product_uid || '';
            if (newUid) {
              productUidMap[src.product_uid] = newUid;
              rememberCreated(src, newUid);
              migrated++;
              const noteParts = [];
              const idNote = await ensureProductId(newUid, src, cr?.data);
              if (idNote) noteParts.push(idNote);
              if (unresolvedBus.length)  noteParts.push(`business unit(s) not found in destination: ${unresolvedBus.join(', ')}`);
              if (unresolvedLocs.length) noteParts.push(`location(s) not found in destination: ${unresolvedLocs.join(', ')}`);
              emit({ type: 'record', status: 'ok', name: `${src.product_name} (${src.product_type})`, reason: noteParts.join('; ') || undefined, migrated, skipped, failed });
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: src.product_name, reason: 'No product_uid returned', migrated, skipped, failed });
            }
          } catch(e) {
            if (isAlreadyExists(e)) {
              skipped++;
              emit({ type: 'record', status: 'skip', name: src.product_name, reason: 'Already exists', migrated, skipped, failed });
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: src.product_name, reason: e.message, migrated, skipped, failed });
            }
          }
          await delay(80);
        }

        // ── Pass 2: create/match selected BUNDLE products ───────────────────────
        const bundles = Object.values(srcProductsByUid).filter(p =>
          p.product_type === 'BUNDLE' && selectedItemIds.includes(p.product_uid)
        );
        for (const src of bundles) {
          const found = findExistingProduct(src);
          if (found) {
            const exUid = found.product.product_uid || found.product._id || '';
            productUidMap[src.product_uid] = exUid;
            skipped++;
            const idNote = await ensureProductId(exUid, src, found.product);
            emit({ type: 'record', status: 'skip', name: `${src.product_name} (BUNDLE)`, reason: [found.reason, idNote].filter(Boolean).join('; '), migrated, skipped, failed });
            continue;
          }

          const remappedAssoc = [];
          const unresolved    = [];
          for (const ap of src.associated_products || []) {
            const srcApUid = prodUidFromRef(ap.product);
            const dstApUid = productUidMap[srcApUid];
            if (dstApUid) {
              remappedAssoc.push({
                product_uid:  dstApUid,
                product_name: ap.product_name,
                product_type: ap.product_type || 'PARTS',
                quantity:     ap.quantity != null ? ap.quantity : 1,
              });
            } else {
              unresolved.push(ap.product_name || srcApUid);
            }
          }

          if (!remappedAssoc.length) {
            failed++;
            emit({ type: 'record', status: 'error', name: `${src.product_name} (BUNDLE)`, reason: 'No associated products could be resolved in destination — skipped', migrated, skipped, failed });
            continue;
          }

          const dstCatUid = await resolveOrCreateCategory(src.product_category);
          try {
            const cr = await zuper(session.dstBase, session.dstKey, 'POST', '/product', {
              product: {
                product_name:        src.product_name,
                product_id:          src.product_id || '',
                product_type:        'BUNDLE',
                product_category:    dstCatUid || '',
                pricing_level:       src.pricing_level || 'ROLLUP',
                associated_products: remappedAssoc,
              },
              vendor: [],
            });
            const newUid = cr?.data?.product_uid || '';
            if (newUid) {
              productUidMap[src.product_uid] = newUid;
              rememberCreated(src, newUid);
              migrated++;
              const idNote = await ensureProductId(newUid, src, cr?.data);
              const note = [
                unresolved.length ? `${unresolved.length} component(s) not found in destination — skipped from bundle` : '',
                idNote,
              ].filter(Boolean).join('; ') || undefined;
              emit({ type: 'record', status: 'ok', name: `${src.product_name} (BUNDLE, ${remappedAssoc.length} components)`, reason: note, migrated, skipped, failed });
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: src.product_name, reason: 'No product_uid returned', migrated, skipped, failed });
            }
          } catch(e) {
            if (isAlreadyExists(e)) {
              skipped++;
              emit({ type: 'record', status: 'skip', name: `${src.product_name} (BUNDLE)`, reason: 'Already exists', migrated, skipped, failed });
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: `${src.product_name} (BUNDLE)`, reason: e.message, migrated, skipped, failed });
            }
          }
          await delay(80);
        }
      }
    }

    // ── CUSTOM FIELDS ─────────────────────────────────────────────────────────
    if (selections.customfields) {
      emit({ type: 'progress', message: 'Migrating custom fields…' });

      const CF_MODULES = ['JOB','CUSTOMER','ORGANIZATION','PROPERTY','PRODUCT','ASSET','ESTIMATE','INVOICE'];

      for (const mod of CF_MODULES) {
        const groupMap = selections.customfields[mod.toLowerCase()] || {};
        const fieldIds = Object.values(groupMap).flat().filter(Boolean);
        if (!fieldIds.length) continue;

        emit({ type: 'progress', message: `Migrating ${mod} custom fields…` });

        try {
          const srcRes = await zuper(
            session.srcBase, session.srcKey,
            'GET', `/settings/custom_fields?module_name=${mod}&sort=ASC&sort_by=display_order`,
            null
          );
          const allFields = srcRes?.data || (Array.isArray(srcRes) ? srcRes : []);
          const fields = allFields.filter(f => fieldIds.includes(f.custom_field_uid));

          const dstGroupMap = {};
          try {
            const dstGrpRes = await zuper(
              session.dstBase, session.dstKey,
              'GET', `/settings/custom_fields/group?filter.module_name=${mod}`,
              null
            );
            (dstGrpRes?.data || []).forEach(g => {
              if (g.group_name && g.group_uid) {
                dstGroupMap[g.group_name.toLowerCase()] = g.group_uid;
              }
            });
          } catch(_) {}

          const srcGroups = {};
          fields.forEach(f => {
            if (f.group?.group_name && f.group?.group_uid) {
              srcGroups[f.group.group_uid] = f.group;
            }
          });

          for (const srcGroup of Object.values(srcGroups)) {
            const key = srcGroup.group_name.toLowerCase();
            if (!dstGroupMap[key]) {
              try {
                const grpRes = await zuper(
                  session.dstBase, session.dstKey,
                  'POST', '/settings/custom_fields/group',
                  {
                    custom_field_group: {
                      group_name:        srcGroup.group_name,
                      module_name:       mod,
                      group_description: srcGroup.group_description || '',
                      associated_to:     [],
                      category:          '',
                      order_no:          srcGroup.order_no || 1,
                    },
                  }
                );
                const newUid = grpRes?.data?.group_uid || null;
                if (newUid) {
                  dstGroupMap[key] = newUid;
                  emit({ type: 'record', status: 'ok', name: `Group: ${srcGroup.group_name} (${mod})`, migrated, skipped, failed });
                }
              } catch(e) {
                if (e.status === 409) {
                  try {
                    const reRes = await zuper(
                      session.dstBase, session.dstKey,
                      'GET', `/settings/custom_fields/group?filter.module_name=${mod}`,
                      null
                    );
                    (reRes?.data || []).forEach(g => {
                      if (g.group_name && g.group_uid) {
                        dstGroupMap[g.group_name.toLowerCase()] = g.group_uid;
                      }
                    });
                  } catch(_) {}
                } else {
                  emit({ type: 'record', status: 'error', name: `Group: ${srcGroup.group_name} (${mod})`, reason: e.message, migrated, skipped, failed });
                }
              }
              await delay(80);
            }
          }

          for (const field of fields) {
            try {
              const srcGroupName = field.group?.group_name || null;
              const dstGroupUid  = srcGroupName ? (dstGroupMap[srcGroupName.toLowerCase()] || null) : null;

              const customFieldPayload = {
                label:         field.field_name,
                field_type:    field.field_type,
                description:   field.field_description || '',
                placeholder:   field.field_placeholder || '',
                required:      field.is_required       || false,
                display_order: field.display_order     || 0,
                options:       field.field_options     || [],
                read_only:     false,
                hide_field:    false,
                hide_to_fe:    false,
                restrict_to_access_role: { is_enabled: false, roles: [] },
              };

              if (dstGroupUid) customFieldPayload.group = dstGroupUid;

              await zuper(session.dstBase, session.dstKey, 'POST', '/settings/custom_fields/new', {
                module_name:  mod,
                custom_field: customFieldPayload,
              });
              migrated++;
              emit({ type: 'record', status: 'ok', name: `${field.field_name} (${mod})`, migrated, skipped, failed });
            } catch (e) {
              if (e.status === 409) {
                skipped++;
                emit({ type: 'record', status: 'skip', name: `${field.field_name} (${mod})`, reason: 'Already exists', migrated, skipped, failed });
              } else {
                failed++;
                emit({ type: 'record', status: 'error', name: `${field.field_name} (${mod})`, reason: e.message, migrated, skipped, failed });
              }
            }
            await delay(80);
          }
        } catch (e) {
          emit({ type: 'error', message: `Failed to fetch ${mod} custom fields: ${e.message}` });
        }
      }
    }

    // ── CHECKLISTS → INSPECTION FORMS ─────────────────────────────────────────
    // FIX #2: Route to /assets/inspection_form/master, not job category.
    // FIX #1 + #3 applied via helpers.
    if (selections.checklists2form?.checklists?.length) {
      emit({ type: 'progress', message: 'Migrating checklists as inspection forms…' });

      const byStatus2form = {};
      for (const cl of selections.checklists2form.checklists) {
        const k = `${cl.catId}|||${cl.statusId}`;
        if (!byStatus2form[k]) byStatus2form[k] = { ...cl, fieldIds: [] };
        byStatus2form[k].fieldIds.push(cl.id);
      }

      for (const entry of Object.values(byStatus2form)) {
        const formName = `${entry.catName} — ${entry.statusName}`;
        try {
          // Fetch source checklist fields
          const r = await zuper(session.srcBase, session.srcKey, 'GET',
            `/settings/checklist?category_uid=${entry.catId}&job_status_uid=${entry.statusId}`, null);
          const allFields = r?.data || [];
          const fields = allFields
            .filter(f => entry.fieldIds.includes(f.checklist_uid))
            .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

          // FIX #2: Create inspection form (not a job category)
          const formRes = await zuper(session.dstBase, session.dstKey, 'POST', '/assets/inspection_form/master', {
            asset_inspection_form: {
              asset_form_name:        formName,
              asset_form_description: '',
              asset_form_fields:      [],
            },
          });
          const newFormUid = formRes?.data?.asset_form_uid || formRes?.asset_form_uid || null;
          if (!newFormUid) throw new Error('Inspection form created but no UID returned');

          // Pass 1: create all fields without dependencies
          let fieldCount = 0;
          for (const field of fields) {
            try {
              const fieldPayload = buildInspectionFieldPostPayload(field, []);
              await zuper(session.dstBase, session.dstKey, 'POST',
                `/assets/inspection_form/${newFormUid}`,
                { asset_form_field: fieldPayload }
              );
              fieldCount++;
            } catch(_) {}
            await delay(20);
          }

          // Pass 2: link dependencies
          await linkInspectionFormDependencies(newFormUid, fields, formName);

          migrated++;
          emit({ type: 'record', status: 'ok', name: `Inspection form: ${formName} (${fieldCount} fields)`, migrated, skipped, failed });
        } catch(e) {
          if (e.status === 409) {
            skipped++;
            emit({ type: 'record', status: 'skip', name: `Inspection form: ${formName}`, reason: 'Already exists', migrated, skipped, failed });
          } else {
            failed++;
            emit({ type: 'record', status: 'error', name: `Inspection form: ${formName}`, reason: e.message, migrated, skipped, failed });
          }
        }
        await delay(80);
      }
    }

    // ── CHECKLISTS → CHECKLISTS ───────────────────────────────────────────────
    // FIX #1: two-pass dependency resolution.
    // FIX #3: TABLE field_meta passed through.
    if (selections.checklists?.checklists?.length) {
      emit({ type: 'progress', message: 'Migrating checklists…' });

      // Fetch destination categories once to build name→uid map
      const dstCatMap = {};
      try {
        const dstCats = await zuper(session.dstBase, session.dstKey, 'GET', '/jobs/category?populate_statuses=true', null);
        (dstCats?.data || []).forEach(c => {
          const statMap = {};
          (c.job_statuses || []).forEach(s => { statMap[s.status_name.toLowerCase().trim()] = s.status_uid; });
          dstCatMap[c.category_name.toLowerCase().trim()] = { uid: c.category_uid, statuses: statMap };
        });
      } catch(e) {
        emit({ type: 'error', message: 'Could not fetch destination categories: ' + e.message });
      }

      // Group selected checklists by catId+statusId
      const byStatusCl = {};
      for (const cl of selections.checklists.checklists) {
        const k = `${cl.catId}|||${cl.statusId}`;
        if (!byStatusCl[k]) byStatusCl[k] = { ...cl, fieldIds: [] };
        byStatusCl[k].fieldIds.push(cl.id);
      }

      // ── Target-status mode (chosen on the Modules step) ──────────────────
      //   'existing' → each source status group goes into a destination status the
      //                user picked (any category/status, same or other account).
      //   'new'      → each group goes into a NEW status the user named, under a
      //                destination category they picked (or a category created with
      //                the source category's name). Refuses if the name is taken.
      //   (none)     → legacy behaviour: match/create category+status by source name.
      const clMode    = selections.checklists.mode || null;
      const clTargets = selections.checklists.targets || {};
      const normName  = s => String(s || '').toLowerCase().trim();
      const createdStatusesThisRun = {}; // `${catUid}|${name}` → status_uid

      async function fetchDstCats() {
        const r = await zuper(session.dstBase, session.dstKey, 'GET', '/jobs/category?populate_statuses=true', null);
        return r?.data || [];
      }

      async function resolveChecklistTarget(entry) {
        const label = `Checklist group ${entry.catName} — ${entry.statusName}`;
        const fail = reason => {
          failed++;
          emit({ type: 'record', status: 'error', name: label, reason, migrated, skipped, failed });
          return null;
        };
        const t = clTargets[entry.statusId];
        if (!t) return fail('No destination status was chosen for this group');

        let cats;
        try { cats = await fetchDstCats(); }
        catch(e) { return fail('Could not fetch destination categories: ' + e.message); }

        if (clMode === 'existing') {
          const cat = cats.find(c => c.category_uid === t.catId);
          if (!cat) return fail(`Destination category "${t.catName}" was not found`);
          const st = (cat.job_statuses || []).find(s => s.status_uid === t.statusId);
          if (!st) return fail(`Destination status "${t.statusName}" was not found in "${cat.category_name}"`);
          return { dstCatUid: cat.category_uid, dstStatusUid: st.status_uid, catName: cat.category_name, statusName: st.status_name };
        }

        // clMode === 'new'
        const newName = String(t.statusName || '').trim();
        if (!newName) return fail('No name was given for the new status');

        let cat = null;
        if (t.catId) {
          cat = cats.find(c => c.category_uid === t.catId);
          if (!cat) return fail(`Destination category "${t.catName}" was not found`);
        } else {
          // "Create category" option — reuse one with that name if it already exists
          const wantCat = String(t.catName || entry.catName).trim();
          cat = cats.find(c => normName(c.category_name) === normName(wantCat));
          if (!cat) {
            try {
              await zuper(session.dstBase, session.dstKey, 'POST', '/jobs/category', { category: { category_name: wantCat } });
              await delay(200);
              cats = await fetchDstCats();
              cat = cats.find(c => normName(c.category_name) === normName(wantCat));
              if (!cat) return fail(`Category "${wantCat}" was created but could not be found afterwards`);
              emit({ type: 'record', status: 'ok', name: `Category: ${wantCat}`, migrated, skipped, failed });
            } catch(e) {
              return fail(`Could not create category "${wantCat}": ${e.message}`);
            }
          }
        }

        const runKey = `${cat.category_uid}|${normName(newName)}`;
        if (createdStatusesThisRun[runKey]) {
          // Another source group in this same run already created it — share it.
          return { dstCatUid: cat.category_uid, dstStatusUid: createdStatusesThisRun[runKey], catName: cat.category_name, statusName: newName };
        }
        if ((cat.job_statuses || []).some(s => normName(s.status_name) === normName(newName))) {
          return fail(`A status named "${newName}" already exists in "${cat.category_name}". Use "Into an existing status" to add questions to it, or pick a different name`);
        }

        const createStatus = type => zuper(session.dstBase, session.dstKey, 'POST', `/jobs/status_new/${cat.category_uid}`, {
          job_status: { status_name: newName, status_type: type, status_color: t.statusColor || '#02B875' },
        });
        const wantType = t.statusType || 'NEW';
        try {
          await createStatus(wantType);
        } catch(e) {
          if (wantType === 'NEW') return fail(`Could not create status "${newName}": ${e.message}`);
          try {
            await createStatus('NEW');
            emit({ type: 'progress', message: `Note: status type "${wantType}" was rejected for "${newName}" (${e.message}) — created as NEW instead.` });
          } catch(e2) {
            return fail(`Could not create status "${newName}": ${e2.message}`);
          }
        }
        await delay(200);
        try {
          cats = await fetchDstCats();
        } catch(e) {
          return fail(`Status "${newName}" was created but the category could not be re-read: ${e.message}`);
        }
        const freshCat = cats.find(c => c.category_uid === cat.category_uid);
        const st = (freshCat?.job_statuses || []).find(s => normName(s.status_name) === normName(newName));
        if (!st) return fail(`Status "${newName}" was created but could not be found afterwards`);
        createdStatusesThisRun[runKey] = st.status_uid;
        emit({ type: 'record', status: 'ok', name: `Status: ${newName} (${cat.category_name})`, migrated, skipped, failed });
        return { dstCatUid: cat.category_uid, dstStatusUid: st.status_uid, catName: cat.category_name, statusName: newName };
      }

      for (const entry of Object.values(byStatusCl)) {
        let dstCatUid = null, dstStatusUid = null;
        // Names shown in the log for where the questions landed
        let tgtCatName = entry.catName, tgtStatusName = entry.statusName;

        if (clMode === 'existing' || clMode === 'new') {
          const tgt = await resolveChecklistTarget(entry);
          if (!tgt) continue;
          dstCatUid = tgt.dstCatUid; dstStatusUid = tgt.dstStatusUid;
          tgtCatName = tgt.catName; tgtStatusName = tgt.statusName;
        } else {
        // STEP 1: Ensure category exists in destination
        dstCatUid = dstCatMap[entry.catName.toLowerCase()]?.uid || null;
        if (!dstCatUid) {
          try {
            const catRes = await zuper(session.dstBase, session.dstKey, 'POST', '/jobs/category', {
              category: { category_name: entry.catName },
            });
            dstCatUid = catRes?.data?.category_uid || catRes?.category_uid || null;
            if (dstCatUid) dstCatMap[entry.catName.toLowerCase()] = { uid: dstCatUid, statuses: {} };
            emit({ type: 'record', status: 'ok', name: `Category: ${entry.catName}`, migrated, skipped, failed });
          } catch(e) {
            if (e.status === 409) {
              try {
                const r = await zuper(session.dstBase, session.dstKey, 'GET', '/jobs/category?populate_statuses=true', null);
                const match = (r?.data||[]).find(c => c.category_name.toLowerCase().trim() === entry.catName.toLowerCase().trim());
                if (match) {
                  dstCatUid = match.category_uid;
                  const statMap = {};
                  (match.job_statuses||[]).forEach(s => { statMap[s.status_name.toLowerCase().trim()] = s.status_uid; });
                  dstCatMap[entry.catName.toLowerCase()] = { uid: dstCatUid, statuses: statMap };
                }
              } catch(_) {}
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: `Category: ${entry.catName}`, reason: e.message, migrated, skipped, failed });
              continue;
            }
          }
          await delay(80);
        }

        if (!dstCatUid) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Checklist group ${entry.catName} — ${entry.statusName}`, reason: 'Could not find/create destination category', migrated, skipped, failed });
          continue;
        }

        // STEP 2: Ensure status exists in destination
        dstStatusUid = dstCatMap[entry.catName.toLowerCase()]?.statuses?.[entry.statusName.toLowerCase()] || null;
        if (!dstStatusUid) {
          try {
            await zuper(session.dstBase, session.dstKey, 'POST', `/jobs/status_new/${dstCatUid}`, {
              job_status: { status_name: entry.statusName, status_type: 'NEW', status_color: '#02B875' },
            });
            await delay(200);
            const stList = await zuper(session.dstBase, session.dstKey, 'GET', `/jobs/category?populate_statuses=true`, null);
            const stCat = (stList?.data||[]).find(c => c.category_uid === dstCatUid);
            const stMatch = (stCat?.job_statuses||[]).find(s => s.status_name.toLowerCase().trim() === entry.statusName.toLowerCase().trim());
            dstStatusUid = stMatch?.status_uid || null;
            if (!dstCatMap[entry.catName.toLowerCase()]) dstCatMap[entry.catName.toLowerCase()] = { uid: dstCatUid, statuses: {} };
            if (dstStatusUid) dstCatMap[entry.catName.toLowerCase()].statuses[entry.statusName.toLowerCase()] = dstStatusUid;
            emit({ type: 'record', status: 'ok', name: `Status: ${entry.statusName} (${entry.catName})`, migrated, skipped, failed });
          } catch(e) {
            if (e.status === 409) {
              try {
                const r = await zuper(session.dstBase, session.dstKey, 'GET', `/jobs/category?populate_statuses=true`, null);
                const cat = (r?.data||[]).find(c => c.category_uid === dstCatUid);
                const match = (cat?.job_statuses||[]).find(s => s.status_name.toLowerCase().trim() === entry.statusName.toLowerCase().trim());
                if (match) dstStatusUid = match.status_uid;
              } catch(_) {}
            } else {
              failed++;
              emit({ type: 'record', status: 'error', name: `Status: ${entry.statusName}`, reason: e.message, migrated, skipped, failed });
              continue;
            }
          }
          await delay(80);
        }

        if (!dstStatusUid) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Checklist group ${entry.catName} — ${entry.statusName}`, reason: 'Could not find/create destination status', migrated, skipped, failed });
          continue;
        }
        } // end legacy name-matching path

        // STEP 3: Fetch source checklist fields and migrate with two-pass dependency resolution
        try {
          const r = await zuper(session.srcBase, session.srcKey, 'GET',
            `/settings/checklist?category_uid=${entry.catId}&job_status_uid=${entry.statusId}`, null);
          const allFields = r?.data || [];
          const fields = allFields
            .filter(f => entry.fieldIds.includes(f.checklist_uid))
            .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

          // Track src_uid → dst_uid for dependency resolution.
          // NOTE: POST /settings/checklist/new does not reliably echo the new field's
          // UID in its response (confirmed against this same endpoint by the sibling
          // CPQ migration tool, which had to work around exactly this). So instead of
          // trusting the create response, we re-fetch the destination checklist after
          // Pass 1 and match src→dst by field_name (see below).
          const srcToDst = {};
          let createdCount = 0;

          // Snapshot the questions already in the target status, so the name-based
          // src→dst mapping after Pass 1 only matches questions created in THIS run
          // (otherwise an existing question with the same label could be picked up
          // and have its dependencies overwritten). Matters for "existing status"
          // targets and for same-account cloning.
          const preExistingDst = new Set();
          try {
            const pre = await zuper(session.dstBase, session.dstKey, 'GET',
              `/settings/checklist?category_uid=${dstCatUid}&job_status_uid=${dstStatusUid}`, null);
            (pre?.data || []).forEach(f => { if (f.checklist_uid) preExistingDst.add(f.checklist_uid); });
          } catch(_) { /* fall back to matching against everything */ }

          // When appending into a status that already has questions, place the
          // new ones after them (keeping their relative source order).
          const orderOffset = (clMode === 'existing' && preExistingDst.size) ? preExistingDst.size : 0;
          const applyOrder = (field, payload) => {
            if (orderOffset) payload.display_order = orderOffset + fields.indexOf(field) + 1;
            return payload;
          };

          // Pass 1: create all fields without dependencies
          for (const field of fields) {
            try {
              const checklistPayload = applyOrder(field, buildChecklistFieldPayload(field, []));
              await zuper(session.dstBase, session.dstKey, 'POST', '/settings/checklist/new', {
                prefill_checklist: false,
                job_status_uid:    dstStatusUid,
                category_uid:      dstCatUid,
                checklist:         checklistPayload,
              });
              createdCount++;
              migrated++;
              emit({ type: 'record', status: 'ok', name: `Checklist: ${field.field_name} → ${tgtCatName} — ${tgtStatusName}`, migrated, skipped, failed });
            } catch(e) {
              failed++;
              emit({ type: 'record', status: 'error', name: `Checklist: ${field.field_name}`, reason: e.message, migrated, skipped, failed });
            }
            await delay(80);
          }

          // Any field using EITHER dependency mechanism needs a Pass 2 PATCH — creation
          // drops both styles, so this can't be narrowed to just the UID-based one.
          const fieldsWithDeps = fields.filter(f => {
            const ft = f.original_template || {};
            return (f.dependent_fields && f.dependent_fields.length > 0) || !!ft.dependent_on || !!f.dependent_on;
          });

          // Build src→dst UID map by re-fetching the destination checklist and matching
          // on field_name (both lists sorted by display_order, consumed in order to
          // disambiguate duplicate labels).
          if (createdCount > 0) {
            try {
              const dstListRes = await zuper(session.dstBase, session.dstKey, 'GET',
                `/settings/checklist?category_uid=${dstCatUid}&job_status_uid=${dstStatusUid}`, null);
              const dstFields = (dstListRes?.data || [])
                .filter(f => !preExistingDst.has(f.checklist_uid))
                .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
              const byName = new Map();
              dstFields.forEach(f => {
                const key = (f.field_name || '').toLowerCase().trim();
                if (!byName.has(key)) byName.set(key, []);
                byName.get(key).push(f.checklist_uid);
              });
              fields.forEach(f => {
                const key = (f.field_name || '').toLowerCase().trim();
                const bucket = byName.get(key);
                const dstUid = bucket && bucket.length ? bucket.shift() : null;
                if (dstUid) srcToDst[f.checklist_uid] = dstUid;
              });
              if (Object.keys(srcToDst).length < createdCount) {
                emit({ type: 'progress', message: `Note: matched ${Object.keys(srcToDst).length}/${createdCount} created fields back by name for ${entry.catName} — ${entry.statusName}.` });
              }
            } catch(e) {
              emit({ type: 'error', message: `Could not map destination checklist UIDs for dependency linking (${entry.catName} — ${entry.statusName}): ${e.message}` });
            }
          }

          // Pre-index source fields by name — used below to resolve a name-based
          // dependency's parent (identified by name, per the GET response) back to
          // that parent's own checklist_uid, so it can be mapped through srcToDst
          // exactly like a UID-based dependency.
          const srcByName = new Map();
          fields.forEach(f => srcByName.set((f.field_name || '').toLowerCase().trim(), f.checklist_uid));

          // Pass 2: patch fields that have dependencies
          for (const field of fieldsWithDeps) {
            const dstFieldUid = srcToDst[field.checklist_uid];
            if (!dstFieldUid) {
              failed++;
              emit({ type: 'record', status: 'error', name: `Dependency link: ${field.field_name}`, reason: 'Could not resolve this field’s destination UID — dependency not linked', migrated, skipped, failed });
              continue;
            }

            const unresolved = field.dependent_fields.filter(dep => !srcToDst[dep.field_uid]);
            const resolvedDeps = field.dependent_fields.map(dep => ({
              field_name:     dep.field_name,
              field_value:    dep.field_value,
              field_uid:      srcToDst[dep.field_uid] || dep.field_uid,
              field_in:       dep.field_in       || 'CHECKLIST',
              condition_type: dep.condition_type || 'AND',
              operator:       dep.operator       || 'CONTAINS',
            }));

            // Name-based mechanism: `dependent_on`/`dependent_options` are read-only
            // display fields (CONFIRMED 2026-08-06 — writing either the parent's name
            // or its resolved UID into `dependent_on` is silently accepted and
            // silently ignored by the API). The only mechanism that actually persists
            // is `dependent_fields[]`, so synthesize an equivalent entry into it:
            // resolve the parent by name → source UID → destination UID, same as any
            // other dependent_fields condition.
            const ft = field.original_template || {};
            const sourceDependentOnName = ft.dependent_on || field.dependent_on || null;
            let unresolvedNameDep = false;
            if (sourceDependentOnName) {
              const parentSrcUid = srcByName.get(sourceDependentOnName.toLowerCase().trim());
              const parentDstUid = parentSrcUid ? srcToDst[parentSrcUid] : null;
              if (parentDstUid) {
                resolvedDeps.push({
                  field_name:     sourceDependentOnName,
                  field_value:    ft.dependent_options || field.dependent_options || [],
                  field_uid:      parentDstUid,
                  field_in:       'CHECKLIST',
                  condition_type: 'AND',
                  operator:       'CONTAINS',
                });
              } else {
                unresolvedNameDep = true;
              }
            }

            try {
              const checklistPayload = applyOrder(field, buildChecklistFieldPayload(field, resolvedDeps));
              await zuper(session.dstBase, session.dstKey, 'PUT',
                `/settings/checklist/${dstFieldUid}`,
                {
                  job_status_uid: dstStatusUid,
                  category_uid:   dstCatUid,
                  checklist:      checklistPayload,
                }
              );
              if (unresolved.length) {
                failed++;
                emit({ type: 'record', status: 'error', name: `Dependency link: ${field.field_name}`, reason: `${unresolved.length} dependency target(s) not found in destination (e.g. "${unresolved[0].field_name}") — linked with a stale source UID`, migrated, skipped, failed });
              }
              if (unresolvedNameDep) {
                failed++;
                emit({ type: 'record', status: 'error', name: `Dependency link: ${field.field_name}`, reason: `Parent field "${sourceDependentOnName}" not found/not migrated in destination — name-based dependency not linked`, migrated, skipped, failed });
              }
            } catch(e) {
              failed++;
              emit({ type: 'record', status: 'error', name: `Dependency link: ${field.field_name}`, reason: e.message, migrated, skipped, failed });
            }
            await delay(80);
          }

        } catch(e) {
          emit({ type: 'error', message: `Failed to fetch checklists for ${entry.catName} — ${entry.statusName}: ${e.message}` });
        }
      }
    }

    // ── INSPECTION FORMS ──────────────────────────────────────────────────────
    // FIX #1 + #3 applied via helpers.
    if (selections.inspectionforms?.forms?.length) {
      emit({ type: 'progress', message: 'Migrating inspection forms…' });

      let srcForms = [];
      try {
        const r = await zuper(session.srcBase, session.srcKey, 'GET', '/assets/inspection_form/master?count=200&page=1&sort=DESC&sort_by=created_at', null);
        srcForms = r?.data || (Array.isArray(r) ? r : []);
      } catch(e) {
        emit({ type: 'error', message: 'Could not fetch source inspection forms: ' + e.message });
      }

      for (const formId of selections.inspectionforms.forms) {
        const srcForm = srcForms.find(f => f.asset_form_uid === formId);
        if (!srcForm) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Form ${formId}`, reason: 'Not found in source', migrated, skipped, failed });
          continue;
        }

        try {
          // STEP 1: Create empty form
          const formRes = await zuper(session.dstBase, session.dstKey, 'POST', '/assets/inspection_form/master', {
            asset_inspection_form: {
              asset_form_name:        srcForm.asset_form_name,
              asset_form_description: srcForm.asset_form_description || '',
              asset_form_fields:      [],
            },
          });
          const newFormUid = formRes?.data?.asset_form_uid || formRes?.asset_form_uid || null;
          if (!newFormUid) throw new Error('Form created but no UID returned');

          const srcFields = (srcForm.asset_form_fields || [])
            .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

          // Pass 1: create all fields without dependencies
          let fieldCount = 0;
          for (const field of srcFields) {
            try {
              const fieldPayload = buildInspectionFieldPostPayload(field, []);
              await zuper(session.dstBase, session.dstKey, 'POST',
                `/assets/inspection_form/${newFormUid}`,
                { asset_form_field: fieldPayload }
              );
              fieldCount++;
            } catch(_) {}
            await delay(20);
          }

          // Pass 2: link dependencies
          await linkInspectionFormDependencies(newFormUid, srcFields, srcForm.asset_form_name);

          migrated++;
          emit({ type: 'record', status: 'ok', name: `${srcForm.asset_form_name} (${fieldCount} fields)`, migrated, skipped, failed });
        } catch(e) {
          if (e.status === 409) {
            skipped++;
            emit({ type: 'record', status: 'skip', name: srcForm.asset_form_name, reason: 'Already exists', migrated, skipped, failed });
          } else {
            failed++;
            emit({ type: 'record', status: 'error', name: srcForm.asset_form_name, reason: e.message, migrated, skipped, failed });
          }
        }
        await delay(80);
      }
    }

    // ── TASK TEMPLATES ────────────────────────────────────────────────────────
    // Runs after INSPECTION FORMS so forms migrated in this same run can be linked.
    //
    // Read is confirmed (2026-10-23 capture): GET /service_tasks/master?count&page,
    // with total_pages. Create is NOT confirmed — no capture of the save call was
    // possible. POST /service_tasks/master is inferred from inspection forms, which
    // read and create on the same /master path. The body wrapper and the shapes of
    // assigned_to / business_unit are guesses, so each create is checked against
    // the response and anything that didn't stick is noted on the log line.
    if (selections.tasktemplates?.templates?.length) {
      emit({ type: 'progress', message: 'Migrating task templates…' });

      const norm = s => String(s || '').trim().toLowerCase();
      const rawOf = e => e.raw && Object.keys(e.raw).length ? ' — ' + JSON.stringify(e.raw).slice(0, 300) : '';

      // Pages with page + count; stops on total_pages, or a short page when absent.
      async function fetchAllPages(base, key, path, size = 100) {
        const all = [];
        for (let page = 1; page <= 100; page++) {
          const sep = path.includes('?') ? '&' : '?';
          const r = await zuper(base, key, 'GET', `${path}${sep}count=${size}&page=${page}`, null);
          const list = Array.isArray(r) ? r : (r?.data || []);
          all.push(...list);
          if (r?.total_pages != null ? page >= r.total_pages : list.length < size) break;
        }
        return all;
      }

      // Destination name → uid lookups. Source templates carry the names inline,
      // so no source-side lookups are needed.
      async function dstLookup(label, path, uidKey, nameKey, paged = true) {
        const map = {};
        try {
          const list = paged
            ? await fetchAllPages(session.dstBase, session.dstKey, path)
            : (r => Array.isArray(r) ? r : (r?.data || []))(await zuper(session.dstBase, session.dstKey, 'GET', path, null));
          list.forEach(x => { if (x[uidKey] && x[nameKey]) map[norm(x[nameKey])] = x[uidKey]; });
        } catch(e) {
          emit({ type: 'error', message: `Could not load destination ${label} (they won't be linked): ${e.message}` });
        }
        return map;
      }
      const dstForms = await dstLookup('inspection forms', '/assets/inspection_form/master?sort=DESC&sort_by=created_at', 'asset_form_uid', 'asset_form_name');
      const dstBus   = await dstLookup('trade types', '/business_units?filter.show_all_bu=true', 'bu_uid', 'bu_name', false);
      const dstUsers = await dstLookup('users', '/user/all', 'user_uid', 'email');
      const dstTeams = await dstLookup('teams', '/teams/summary', 'team_uid', 'team_name', false);

      // Existing destination templates, for de-dup on title.
      const dstTitles = new Set();
      try {
        (await fetchAllPages(session.dstBase, session.dstKey, '/service_tasks/master?filter.keyword='))
          .forEach(t => { if (!t.is_deleted) dstTitles.add(norm(t.service_task_title)); });
      } catch(e) {
        emit({ type: 'error', message: 'Could not load destination task templates (duplicate check skipped): ' + e.message });
      }

      let srcTemplates = [];
      try {
        srcTemplates = await fetchAllPages(session.srcBase, session.srcKey, '/service_tasks/master?filter.keyword=');
      } catch(e) {
        emit({ type: 'error', message: 'Could not load source task templates: ' + e.message });
      }

      // Body wrapper is unknown. { service_task: … } and the bare object both got
      // 400 "Task master Data is missing" (2026-10-23), so the route exists and
      // only the wrapper key is wrong. Only a 400/422 moves on to the next shape —
      // those don't create anything. The first shape that succeeds is used for
      // the rest of the run.
      const BODY_SHAPES = {
        service_task_master:      p => ({ service_task_master: p }),
        task_master:              p => ({ task_master: p }),
        service_task_master_list: p => ({ service_task_master: [p] }),
        service_task_masters:     p => ({ service_task_masters: [p] }),
        service_tasks:            p => ({ service_tasks: [p] }),
        data:                     p => ({ data: p }),
        service_task:             p => ({ service_task: p }),
        bare:                     p => p,
      };
      let bodyShape = null;
      async function createTemplate(payload) {
        const shapes = bodyShape ? [bodyShape] : Object.keys(BODY_SHAPES);
        let lastErr;
        for (const shape of shapes) {
          try {
            const r = await zuper(session.dstBase, session.dstKey, 'POST', '/service_tasks/master', BODY_SHAPES[shape](payload));
            if (!bodyShape) {
              bodyShape = shape;
              emit({ type: 'progress', message: `Task template create accepted with the "${shape}" body format — using it for the rest.` });
            }
            return r;
          } catch(e) {
            // Keep the first error whose message differs from the generic one —
            // that's the shape that got furthest.
            if (!lastErr || (/master data is missing/i.test(lastErr.message) && !/master data is missing/i.test(e.message))) lastErr = e;
            if (bodyShape || ![400, 422].includes(e.status)) break;
          }
        }
        throw lastErr;
      }

      for (const tplId of selections.tasktemplates.templates) {
        const src = srcTemplates.find(t => t.service_task_master_uid === tplId);
        if (!src) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Task template ${tplId}`, reason: 'Not found in source', migrated, skipped, failed });
          continue;
        }
        const title = src.service_task_title || '';
        if (dstTitles.has(norm(title))) {
          skipped++;
          emit({ type: 'record', status: 'skip', name: `Task template: ${title}`, reason: 'A template with this title already exists in destination', migrated, skipped, failed });
          continue;
        }

        const notes = [];
        const payload = {
          service_task_title:       title,
          service_task_description: src.service_task_description || '',
          task_type:                src.task_type || 'TASK',
          priority:                 src.priority || 'NONE',
          estimated_duration:       src.estimated_duration || { days: 0, hours: 0, minutes: 0 },
          is_active:                src.is_active !== false,
        };

        const srcForm = src.inspection_form;
        if (srcForm?.asset_form_uid && !srcForm.is_deleted) {
          const uid = dstForms[norm(srcForm.asset_form_name)];
          if (uid) payload.inspection_form = { asset_form_uid: uid, asset_form_name: srcForm.asset_form_name };
          else notes.push(`inspection form "${srcForm.asset_form_name}" not found in destination — left blank`);
        }

        const bus = [];
        for (const bu of src.business_unit || []) {
          const uid = dstBus[norm(bu.bu_name)];
          if (uid) bus.push(uid);
          else notes.push(`trade type "${bu.bu_name}" not found in destination`);
        }
        if (bus.length) payload.business_unit = bus;

        const assignees = [];
        for (const a of src.assigned_to || []) {
          const email = a.user?.email, teamName = a.team?.team_name;
          const userUid = email ? dstUsers[norm(email)] : null;
          const teamUid = teamName ? dstTeams[norm(teamName)] : null;
          if (email && !userUid) { notes.push(`user ${email} not found in destination`); continue; }
          if (teamName && !teamUid) notes.push(`team "${teamName}" not found in destination`);
          if (userUid || teamUid) assignees.push({ ...(userUid && { user_uid: userUid }), ...(teamUid && { team_uid: teamUid }) });
        }
        if (assignees.length) payload.assigned_to = assignees;

        try {
          const r = await createTemplate(payload);
          const created = r?.data || r || {};
          if (!created.service_task_master_uid) notes.push('created, but no template ID came back — check it in the destination');

          // Verify the guessed field shapes actually stuck.
          if (payload.inspection_form && !created.inspection_form?.asset_form_uid) notes.push('inspection form was sent but not saved');
          if (bus.length && !(created.business_unit || []).length) notes.push('trade types were sent but not saved');
          if (assignees.length && !(created.assigned_to || []).length) notes.push('assignees were sent but not saved');
          if (src.is_active === false && created.is_active !== false) notes.push('created as Active — source is Inactive, deactivate it in Settings → Jobs → Task Template');

          dstTitles.add(norm(title));
          migrated++;
          emit({ type: 'record', status: 'ok', name: `Task template: ${title}`, reason: notes.join('; ') || undefined, migrated, skipped, failed });
        } catch(e) {
          failed++;
          emit({ type: 'record', status: 'error', name: `Task template: ${title}`, reason: `${e.message} (HTTP ${e.status || '?'})${rawOf(e)}${bodyShape ? '' : ` [tried ${Object.keys(BODY_SHAPES).length} body formats: ${Object.keys(BODY_SHAPES).join(', ')}]`} [sent: ${JSON.stringify(payload).slice(0, 300)}]`, migrated, skipped, failed });
        }
        await delay(80);
      }
    }

    // ── WORKFLOWS ─────────────────────────────────────────────────────────────
    if (selections.workflows?.workflows?.length) {
      emit({ type: 'progress', message: 'Migrating workflows…' });
      try {
        const srcWfs = await zuper(session.srcBase, session.srcKey, 'GET', '/workflow?count=200&page=1&sort=DESC&sort_by=created_at', null);
        const toMigrate = (srcWfs.data || []).filter(w => selections.workflows.workflows.includes(w.workflow_uid));
        for (const wf of toMigrate) {
          try {
            await zuper(session.dstBase, session.dstKey, 'POST', '/workflow', {
              workflow: {
                workflow_name:             wf.workflow_name,
                workflow_description:      wf.workflow_description      || '',
                trigger_module:            wf.trigger_module,
                trigger_event:             wf.trigger_event,
                trigger_event_name:        wf.trigger_event_name        || '',
                actions:                   wf.actions                   || [],
                conditions:                wf.conditions                || [],
                workflow_access:           wf.workflow_access           || 'USERS',
                allowed_users:             wf.allowed_users             || [],
                allowed_teams:             wf.allowed_teams             || [],
                allow_workflow_to_trigger: wf.allow_workflow_to_trigger || false,
              },
            });
            migrated++;
            emit({ type: 'record', status: 'ok', name: wf.workflow_name, migrated, skipped, failed });
          } catch (e) {
            failed++;
            emit({ type: 'record', status: 'error', name: wf.workflow_name, reason: e.message, migrated, skipped, failed });
          }
          await delay(80);
        }
      } catch (e) {
        emit({ type: 'error', message: 'Failed to fetch workflows: ' + e.message });
      }
    }

    // ── EMAIL & SMS TEMPLATES ─────────────────────────────────────────────────
    if (selections.emailtemplates?.templates?.length) {
      emit({ type: 'progress', message: 'Migrating email & SMS templates…' });
      try {
        // Fetch full list so we can look up each selected template by UID
        let page = 1;
        const allSrcTemplates = [];
        while (true) {
          const r = await zuper(session.srcBase, session.srcKey, 'GET',
            `/misc/email_template?count=100&page=${page}&sort=DESC&sort_by=created_at&filter.keyword=`, null);
          const list = r.data || [];
          if (!list.length) break;
          allSrcTemplates.push(...list);
          if (allSrcTemplates.length >= (r.total_records || list.length)) break;
          page++;
        }

        const toMigrate = allSrcTemplates.filter(t =>
          selections.emailtemplates.templates.includes(t.template_uid)
        );

        for (const tmpl of toMigrate) {
          try {
            // Fetch full template body/subject via individual GET
            const full = await zuper(session.srcBase, session.srcKey, 'GET',
              `/misc/email_template/${tmpl.template_uid}`, null);
            const src = full.data || full || tmpl;

            await zuper(session.dstBase, session.dstKey, 'POST', '/misc/email_templateRequest', {
              template: {
                template_name:        src.template_name,
                type:                 src.type,
                template_module:      src.template_module,
                template_description: src.template_description || '',
                template_subject:     src.template_subject     || '',
                template_body:        src.template_body        || '',
              },
            });

            migrated++;
            emit({ type: 'record', status: 'ok', name: `${src.template_name} (${src.type})`, migrated, skipped, failed });
          } catch (e) {
            failed++;
            emit({ type: 'record', status: 'error', name: tmpl.template_name, reason: e.message, migrated, skipped, failed });
          }
          await delay(80);
        }
      } catch (e) {
        emit({ type: 'error', message: 'Failed to fetch templates: ' + e.message });
      }
    }

    emit({ type: 'done' });
    emit({ type: 'summary', migrated, skipped, failed });

  } catch (err) {
    emit({ type: 'error', message: err.message });
  }

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.send(lines.join('\n'));
};
