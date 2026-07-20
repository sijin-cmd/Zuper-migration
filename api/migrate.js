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
  function buildChecklistFieldPayload(field, dependentFieldsArr) {
    const t = field.original_template || {};
    const fieldType = t.field_type || field.field_type || 'SINGLE_LINE';
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
      is_dependent:         !!(dependentFieldsArr && dependentFieldsArr.length > 0),
      dependent_on:         t.dependent_on     || null,
      dependent_options:    t.dependent_options|| [],
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
            category_name: srcCat.category_name,
            estimated_duration: srcCat.estimated_duration || { days: 0, hours: 0, minutes: 0 },
            auto_create_status: false,
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
            emit({ type: 'record', status: 'error', name: `Category: ${srcCat.category_name}`, reason: e.message, migrated, skipped, failed });
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

          // Build a src uid → name map so we can resolve dependency field_name from dst response
          const srcUidToField = {};
          fields.forEach(f => { if (f.checklist_uid) srcUidToField[f.checklist_uid] = f; });

          // Track src_uid → dst_uid for dependency resolution (Pass 1 + 2)
          const srcToDst = {};

          // Pass 1: create all fields without dependencies
          let fieldCount = 0;
          for (const field of fields) {
            try {
              const fieldPayload = buildInspectionFieldPostPayload(field, []);
              const fRes = await zuper(session.dstBase, session.dstKey, 'POST',
                `/assets/inspection_form/${newFormUid}`,
                { asset_form_field: fieldPayload }
              );
              // Capture the destination field UID from the response
              const dstFieldUid = fRes?.data?.checklist_uid
                                || fRes?.data?.field_uid
                                || fRes?.data?._id
                                || fRes?.checklist_uid
                                || null;
              if (dstFieldUid && field.checklist_uid) {
                srcToDst[field.checklist_uid] = dstFieldUid;
              }
              fieldCount++;
            } catch(_) {}
            await delay(20);
          }

          // Pass 2: patch fields that have dependencies
          const fieldsWithDeps = fields.filter(f =>
            f.dependent_fields && f.dependent_fields.length > 0
          );
          for (const field of fieldsWithDeps) {
            const dstFieldUid = srcToDst[field.checklist_uid];
            if (!dstFieldUid) continue;

            const resolvedDeps = field.dependent_fields.map(dep => ({
              field_name:     dep.field_name,
              field_value:    dep.field_value,
              field_uid:      srcToDst[dep.field_uid] || dep.field_uid,
              field_in:       dep.field_in       || 'CHECKLIST',
              condition_type: dep.condition_type || 'AND',
              operator:       dep.operator       || 'CONTAINS',
            }));

            try {
              const fieldPayload = buildInspectionFieldPutPayload(field, resolvedDeps);
              await zuper(session.dstBase, session.dstKey, 'PUT',
                `/assets/inspection_form/${newFormUid}/${dstFieldUid}`,
                { asset_form_field: fieldPayload }
              );
            } catch(_) {}
            await delay(20);
          }

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

      for (const entry of Object.values(byStatusCl)) {
        // STEP 1: Ensure category exists in destination
        let dstCatUid = dstCatMap[entry.catName.toLowerCase()]?.uid || null;
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
        let dstStatusUid = dstCatMap[entry.catName.toLowerCase()]?.statuses?.[entry.statusName.toLowerCase()] || null;
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

        // STEP 3: Fetch source checklist fields and migrate with two-pass dependency resolution
        try {
          const r = await zuper(session.srcBase, session.srcKey, 'GET',
            `/settings/checklist?category_uid=${entry.catId}&job_status_uid=${entry.statusId}`, null);
          const allFields = r?.data || [];
          const fields = allFields
            .filter(f => entry.fieldIds.includes(f.checklist_uid))
            .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

          // Track src_uid → dst_uid for dependency resolution
          const srcToDst = {};

          // Pass 1: create all fields without dependencies
          for (const field of fields) {
            try {
              const checklistPayload = buildChecklistFieldPayload(field, []);
              const fRes = await zuper(session.dstBase, session.dstKey, 'POST', '/settings/checklist/new', {
                prefill_checklist: false,
                job_status_uid:    dstStatusUid,
                category_uid:      dstCatUid,
                checklist:         checklistPayload,
              });
              // Capture destination field UID
              const dstFieldUid = fRes?.data?.checklist_uid
                                || fRes?.data?.field_uid
                                || fRes?.checklist_uid
                                || null;
              if (dstFieldUid && field.checklist_uid) {
                srcToDst[field.checklist_uid] = dstFieldUid;
              }
              migrated++;
              emit({ type: 'record', status: 'ok', name: `Checklist: ${field.field_name} (${entry.catName} — ${entry.statusName})`, migrated, skipped, failed });
            } catch(e) {
              failed++;
              emit({ type: 'record', status: 'error', name: `Checklist: ${field.field_name}`, reason: e.message, migrated, skipped, failed });
            }
            await delay(80);
          }

          // Pass 2: patch fields that have dependencies
          const fieldsWithDeps = fields.filter(f =>
            f.dependent_fields && f.dependent_fields.length > 0
          );
          for (const field of fieldsWithDeps) {
            const dstFieldUid = srcToDst[field.checklist_uid];
            if (!dstFieldUid) continue;

            const resolvedDeps = field.dependent_fields.map(dep => ({
              field_name:     dep.field_name,
              field_value:    dep.field_value,
              field_uid:      srcToDst[dep.field_uid] || dep.field_uid,
              field_in:       dep.field_in       || 'CHECKLIST',
              condition_type: dep.condition_type || 'AND',
              operator:       dep.operator       || 'CONTAINS',
            }));

            try {
              const checklistPayload = buildChecklistFieldPayload(field, resolvedDeps);
              await zuper(session.dstBase, session.dstKey, 'PUT',
                `/settings/checklist/${dstFieldUid}`,
                {
                  job_status_uid: dstStatusUid,
                  category_uid:   dstCatUid,
                  checklist:      checklistPayload,
                }
              );
            } catch(_) { /* patch errors are non-fatal */ }
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

          // Track src_uid → dst_uid for dependency resolution
          const srcToDst = {};

          // Pass 1: create all fields without dependencies
          let fieldCount = 0;
          for (const field of srcFields) {
            try {
              const fieldPayload = buildInspectionFieldPostPayload(field, []);
              const fRes = await zuper(session.dstBase, session.dstKey, 'POST',
                `/assets/inspection_form/${newFormUid}`,
                { asset_form_field: fieldPayload }
              );
              const dstFieldUid = fRes?.data?.checklist_uid
                                || fRes?.data?.field_uid
                                || fRes?.data?._id
                                || fRes?.checklist_uid
                                || null;
              if (dstFieldUid && field.checklist_uid) {
                srcToDst[field.checklist_uid] = dstFieldUid;
              }
              fieldCount++;
            } catch(_) {}
            await delay(20);
          }

          // Pass 2: patch fields that have dependencies
          const fieldsWithDeps = srcFields.filter(f =>
            f.dependent_fields && f.dependent_fields.length > 0
          );
          for (const field of fieldsWithDeps) {
            const dstFieldUid = srcToDst[field.checklist_uid];
            if (!dstFieldUid) continue;

            const resolvedDeps = field.dependent_fields.map(dep => ({
              field_name:     dep.field_name,
              field_value:    dep.field_value,
              field_uid:      srcToDst[dep.field_uid] || dep.field_uid,
              field_in:       dep.field_in       || 'CHECKLIST',
              condition_type: dep.condition_type || 'AND',
              operator:       dep.operator       || 'CONTAINS',
            }));

            try {
              const fieldPayload = buildInspectionFieldPutPayload(field, resolvedDeps);
              await zuper(session.dstBase, session.dstKey, 'PUT',
                `/assets/inspection_form/${newFormUid}/${dstFieldUid}`,
                { asset_form_field: fieldPayload }
              );
            } catch(_) {}
            await delay(20);
          }

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
