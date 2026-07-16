// State
const state = {
  sessionToken: null,
  srcCompany: null, srcRegion: null,
  dstCompany: null, dstRegion: null,
  selectedModules: [],
  selections: {},
  migrationLog: [],
  summary: null,
};

// Helpers
function api(fn) { return '/api/' + fn; }
function showError(id, msg) { const el = document.getElementById(id); if(!el)return; el.textContent=msg; el.style.display='block'; }
function hideError(id) { const el = document.getElementById(id); if(el) el.style.display='none'; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function loadingDots() { return '<div class="loading-dots"><span></span><span></span><span></span></div>'; }

function goTo(n) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page'+n).classList.add('active');
  updateStepper(n);
  if(n===2) initModulePage();
  if(n===3) initSelectPage();
  if(n===4) initReviewPage();
  window.scrollTo(0,0);
}

function updateStepper(active) {
  for(let i=1;i<=4;i++){
    const num=document.getElementById('sn'+i);
    const lbl=document.getElementById('sl'+i);
    const line=document.getElementById('sc'+i);
    if(i<active){ num.className='step-num done'; num.textContent='✓'; lbl.className='step-label done'; if(line)line.className='step-line done'; }
    else if(i===active){ num.className='step-num active'; num.textContent=i; lbl.className='step-label active'; if(line)line.className='step-line'; }
    else{ num.className='step-num pending'; num.textContent=i; lbl.className='step-label'; if(line)line.className='step-line'; }
  }
}

async function apiGet(params) {
  const res = await fetch(api('module-data')+'?'+params+'&sessionToken='+encodeURIComponent(state.sessionToken));
  return res.json();
}

// PAGE 1 — CONNECT
const identified = {src:false, dst:false};

async function identifyAccount(side) {
  const region = document.getElementById(side+'-region').value;
  const key = document.getElementById(side+'-key').value.trim();
  const box = document.getElementById(side+'-company-box');
  if(!region||!key) return;
  box.className='company-identify-box';
  box.innerHTML='<div class="company-identify-spinner"></div><span class="company-identify-placeholder">Identifying&#x2026;</span>';
  identified[side]=false; updateConnectBtn();
  try {
    const res = await fetch(api('identify'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({region,apiKey:key})});
    const data = await res.json();
    if(!res.ok||data.error) throw new Error(data.error||'Could not identify account');
    box.className='company-identify-box identified';
    box.innerHTML=`<span class="company-identify-name">${esc(data.companyName)}</span><span class="identify-badge ok">Verified</span>`;
    box.dataset.company=data.companyName;
    identified[side]=true;
    if(side==='src'){state.srcCompany=data.companyName;state.srcRegion=region;}
    else{state.dstCompany=data.companyName;state.dstRegion=region;}
  } catch(err) {
    box.className='company-identify-box error';
    box.innerHTML=`<span class="company-identify-placeholder">${esc(err.message)}</span><span class="identify-badge fail">Failed</span>`;
    identified[side]=false;
  }
  updateConnectBtn();
}

function updateConnectBtn() {
  document.getElementById('connect-btn').disabled=!(identified.src&&identified.dst);
}

async function doConnect() {
  hideError('connect-error');
  const srcKey=document.getElementById('src-key').value.trim();
  const dstKey=document.getElementById('dst-key').value.trim();
  const srcRegion=document.getElementById('src-region').value;
  const dstRegion=document.getElementById('dst-region').value;
  const btn=document.getElementById('connect-btn');
  btn.textContent='Validating\u2026'; btn.disabled=true;
  try {
    const res=await fetch(api('validate'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({srcKey,srcRegion,dstKey,dstRegion})});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||'Validation failed');
    state.sessionToken=data.sessionToken;
    state.srcCompany=data.src.company||state.srcCompany;
    state.dstCompany=data.dst.company||state.dstCompany;
    btn.textContent='Connected \u2713'; btn.style.background='#006B51';
    setTimeout(()=>goTo(2),500);
  } catch(err) {
    showError('connect-error',err.message);
    btn.textContent='Continue \u2192'; btn.disabled=false;
  }
}

// PAGE 2 — MODULES
const MODULE_DEFS = [
  {key:'jobs',icon:'\uD83D\uDDC2',name:'Job categories',desc:'Categories and statuses only'},
  {key:'checklists2form',icon:'\uD83D\uDD04',name:'Checklists → Inspection Forms',desc:'Convert checklists to inspection form templates'},
  {key:'checklists',icon:'\u2705',name:'Checklists',desc:'Migrate checklists to destination account'},
  {key:'assets',icon:'\uD83C\uDFD7',name:'Assets',desc:'Asset categories and items'},
  {key:'inspectionforms',icon:'\uD83D\uDCCB',name:'Inspection forms',desc:'Asset inspection form templates'},
  {key:'workflows',icon:'⚡',name:'Workflows',desc:'Automation workflows'},
  {key:'emailtemplates',icon:'✉️',name:'Email & SMS templates',desc:'Email and SMS notification templates'},
  {key:'customfields',icon:'🔧',name:'Custom fields',desc:'Custom fields across all modules (including Parts & Services)'},
];

let moduleSummary={};

async function initModulePage() {
  document.getElementById('mod-sub').textContent='Fetching modules from '+(state.srcCompany||'source account')+'\u2026';
  const grid=document.getElementById('mod-grid');
  grid.innerHTML='<div style="grid-column:1/-1;padding:2rem;text-align:center;color:var(--muted2)">'+loadingDots()+'</div>';
  try {
    const res=await fetch(api('module-data')+'?module=summary&sessionToken='+encodeURIComponent(state.sessionToken));
    const data=await res.json();
    if(!data.error) moduleSummary=data;
  } catch(e){moduleSummary={};}

  grid.innerHTML=MODULE_DEFS.map(m=>{
    const info=moduleSummary[m.key];
    const count=info?info.count:0;
    const isOn=state.selectedModules.includes(m.key);
    return `<div class="module-card${isOn?' selected':''}" data-key="${m.key}" onclick="toggleModule(this,'${m.key}')">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:20px">${m.icon}</span>
        <div class="mod-check${isOn?' on':''}"></div>
      </div>
      <div class="module-name">${m.name}</div>
      <div class="module-desc">${count?count+' items found':m.desc}</div>
    </div>`;
  }).join('');

  document.getElementById('mod-sub').textContent=MODULE_DEFS.length+' modules available in '+(state.srcCompany||'source account')+'. Select what you want to migrate.';
  updateModCount();
}

function toggleModule(el,key) {
  el.classList.toggle('selected');
  el.querySelector('.mod-check').classList.toggle('on',el.classList.contains('selected'));
  if(el.classList.contains('selected')){ if(!state.selectedModules.includes(key)) state.selectedModules.push(key); }
  else state.selectedModules=state.selectedModules.filter(k=>k!==key);
  updateModCount();
}

function updateModCount() {
  const count=state.selectedModules.length;
  document.getElementById('mod-sel-count').textContent=count;
  document.getElementById('mod-next-btn').disabled=count===0;
}

// PAGE 3 — SELECT DATA
async function initSelectPage() {
  const tabBar=document.getElementById('main-tab-bar');
  const views=document.getElementById('module-views');
  tabBar.innerHTML=''; views.innerHTML='';
  state.selectedModules.forEach((key,idx)=>{
    const m=MODULE_DEFS.find(d=>d.key===key);
    if(!m) return;
    const tab=document.createElement('div');
    tab.className='main-tab'+(idx===0?' active':'');
    tab.dataset.key=key;
    tab.innerHTML=m.name+' <span class="tab-count" id="tc-'+key+'">0</span>';
    tab.onclick=()=>switchModuleTab(key);
    tabBar.appendChild(tab);
    const view=document.createElement('div');
    view.className='module-view'+(idx===0?' active':'');
    view.id='mv-'+key;
    view.innerHTML='<div class="loading-state">'+loadingDots()+'<span>Loading '+m.name.toLowerCase()+'\u2026</span></div>';
    views.appendChild(view);
    loadModuleView(key,view);
  });
}

function switchModuleTab(key) {
  document.querySelectorAll('.main-tab').forEach(t=>t.classList.toggle('active',t.dataset.key===key));
  document.querySelectorAll('.module-view').forEach(v=>v.classList.toggle('active',v.id==='mv-'+key));
}

function updateTabCount(key) {
  const el=document.getElementById('tc-'+key); if(!el) return;
  el.textContent=countSelections(key);
}

function countSelections(key) {
  const s=state.selections[key]||{};
  if(key==='jobs') return (s.statuses||[]).length;
  if(key==='checklists2form') return (s.checklists||[]).length;
  if(key==='checklists') return (s.checklists||[]).length;
  if(key==='assets') return Object.values(s.assets||{}).flat().length;
  if(key==='inspectionforms') return (s.forms||[]).length;
  if(key==='workflows') return (s.workflows||[]).length;
  if(key==='emailtemplates') return (s.templates||[]).length;
  if(key==='customfields') return ['job','customer','organization','property','product','asset','estimate','invoice'].reduce((a,sub)=>a+Object.values(s[sub]||{}).flat().length,0);
  return 0;
}

async function loadModuleView(key,container) {
  if(key==='jobs') await loadJobsView(container);
  else if(key==='checklists2form') await loadChecklistsModuleView('checklists2form', container);
  else if(key==='checklists') await loadChecklistsModuleView('checklists', container);
  else if(key==='assets') await loadAssetsView(container);
  else if(key==='inspectionforms') await loadInspectionFormsView(container);
  else if(key==='workflows') await loadWorkflowsView(container);
  else if(key==='emailtemplates') await loadEmailTemplatesView(container);
  else if(key==='customfields') await loadCustomFieldsView(container);
}

// JOBS
async function loadJobsView(container) {
  if(!state.selections.jobs) state.selections.jobs={categories:[],statuses:[]};
  container.innerHTML='<div class="loading-state">'+loadingDots()+'<span>Loading job categories…</span></div>';
  const data=await apiGet('module=jobs&sub=categories');
  const cats=data.data||[];
  if(!cats.length){container.innerHTML='<div class="empty-state">No job categories found.</div>';return;}
  container.innerHTML=cats.map(cat=>{
    const statuses=cat.statuses||[];
    const statusRows=statuses.map(s=>`<div class="s-row">
      <div class="s-item" id="jsi-${s.id}" onclick="toggleJobStatus('${s.id}','${cat.id}')">
        <div class="sm-cb"></div>
        <div class="s-dot" style="background:${esc(s.color||'#888')}"></div>
        <span class="s-name">${esc(s.name)}</span>
      </div>
    </div>`).join('');
    return `<div class="cat-block" id="jcat-${cat.id}">
      <div class="cat-header" onclick="toggleCatBody('jbody-${cat.id}')">
        <div class="big-cb" id="jcb-${cat.id}" onclick="event.stopPropagation();toggleJobCat('${cat.id}')"></div>
        <span class="cat-name">${esc(cat.name)}</span>
        <span class="cat-sel-count" id="jcsc-${cat.id}"></span>
        <span class="cat-meta-txt">${statuses.length} status${statuses.length!==1?'es':''}</span>
        <span class="chev open">&#9660;</span>
      </div>
      <div class="cat-body" id="jbody-${cat.id}">
        ${statuses.length?'<div class="sub-lbl">Statuses</div>'+statusRows:'<div class="empty-state" style="padding:1rem">No statuses found.</div>'}
      </div>
    </div>`;
  }).join('');
}

const CL_TYPE_MAP={
  SINGLE_LINE:'Single line',MULTI_LINE:'Multi line',SINGLE_ITEM:'Dropdown',
  MULTI_ITEM:'Multi select',NUMBER:'Number',DATE:'Date',PHOTO:'Photo',
  MULTI_IMAGE:'Multi image',IMAGE:'Image',SIGNATURE:'Signature',
  BOOLEAN:'Boolean',FILE:'File',RADIO:'Radio',CHECKBOX:'Checkbox',
  MULTI_LINE_TEXT:'Multi line',TEXT:'Text',
};


function toggleJobCat(catId) {
  const sel=state.selections.jobs;
  const idx=sel.categories.indexOf(catId);
  if(idx>=0) sel.categories.splice(idx,1); else sel.categories.push(catId);
  const on=sel.categories.includes(catId);
  const cb=document.getElementById('jcb-'+catId); if(cb) cb.className='big-cb'+(on?' on':'');
  const block=document.getElementById('jcat-'+catId); if(block) block.classList.toggle('has-sel',on);
  updateTabCount('jobs');
}

function toggleJobStatus(statusId,catId) {
  const sel=state.selections.jobs;
  const el=document.getElementById("jsi-"+statusId);
  const isOn=el.classList.toggle("on");
  el.querySelector(".sm-cb").classList.toggle("on",isOn);
  if(isOn){if(!sel.statuses.includes(statusId)) sel.statuses.push(statusId);}
  else sel.statuses=sel.statuses.filter(id=>id!==statusId);
  if(isOn&&!sel.categories.includes(catId)){
    sel.categories.push(catId);
    const cb=document.getElementById("jcb-"+catId); if(cb) cb.className="big-cb partial";
    const block=document.getElementById("jcat-"+catId); if(block) block.classList.add("has-sel");
  }
  updateTabCount("jobs");
}


function toggleCatBody(bodyId) {
  const body=document.getElementById(bodyId); if(!body) return;
  body.style.display=body.style.display==='none'?'block':'none';
}

// CUSTOMERS
async function loadCustomersView(container) {
  if(!state.selections.customers) state.selections.customers={customers:[]};
  container.innerHTML='<div class="loading-state">'+loadingDots()+'<span>Loading customers…</span></div>';
  const data=await apiGet('module=customers&sub=list');
  const customers=data.data||[];
  if(!customers.length){container.innerHTML='<div class="empty-state">No customers found.</div>';return;}

  // Group by type
  const typeMap=new Map();
  customers.forEach(c=>{
    const typeKey=c.type||'Other';
    if(!typeMap.has(typeKey)) typeMap.set(typeKey,[]);
    typeMap.get(typeKey).push(c);
  });

  container.innerHTML=
    `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <span class="sub-lbl" style="margin-bottom:0">${customers.length} customers</span>
      <div style="display:flex;gap:10px;">
        <button class="lnk" onclick="custSelectAll()">Select all</button>
        <button class="lnk" onclick="custClearAll()">Clear all</button>
      </div>
    </div>`+
    [...typeMap.entries()].map(([typeName,typeCusts])=>`
      <div class="cat-block has-sel" style="margin-bottom:10px;">
        <div class="cat-header" onclick="toggleCatBody('cbody-${typeName.replace(/\s+/g,'_')}')">
          <span class="cat-name">${esc(typeName)}</span>
          <span class="cat-meta-txt">${typeCusts.length} customers</span>
          <span class="chev open">&#9660;</span>
        </div>
        <div class="cat-body" id="cbody-${typeName.replace(/\s+/g,'_')}">
          <div class="sub-lbl">Customers</div>
          <div class="item-grid">${typeCusts.map(c=>`
            <div class="item-card" id="cc-${c.id}" onclick="toggleCustomer('${c.id}')">
              <div class="sm-cb"></div>
              <div class="i-info">
                <div class="i-name">${esc(c.name)}</div>
                ${c.email?`<div class="i-detail">${esc(c.email)}</div>`:''}
                ${c.phone?`<div class="i-detail">${esc(c.phone)}</div>`:''}
                ${c.address?`<div class="i-detail">${esc(c.address)}</div>`:''}
                ${c.organization?`<div class="org-pill"><svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="4" width="10" height="7" rx="1"/></svg>${esc(c.organization)}</div>`:''}
                ${(c.tags||[]).length?`<div class="tag-row">${c.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div>`:''}
              </div>
            </div>`).join('')}
          </div>
        </div>
      </div>`).join('');
}

function custSelectAll() {
  document.querySelectorAll('[id^="cc-"]').forEach(el=>{
    el.classList.add('on'); el.querySelector('.sm-cb').classList.add('on');
    const id=el.id.replace('cc-','');
    if(!state.selections.customers.customers.includes(id)) state.selections.customers.customers.push(id);
  });
  updateTabCount('customers');
}

function custClearAll() {
  document.querySelectorAll('[id^="cc-"]').forEach(el=>{
    el.classList.remove('on'); el.querySelector('.sm-cb').classList.remove('on');
  });
  state.selections.customers.customers=[];
  updateTabCount('customers');
}

function toggleCustomer(custId) {
  const sel=state.selections.customers;
  const el=document.getElementById('cc-'+custId);
  const isOn=el.classList.toggle('on');
  el.querySelector('.sm-cb').classList.toggle('on',isOn);
  if(isOn){if(!sel.customers.includes(custId)) sel.customers.push(custId);}
  else sel.customers=sel.customers.filter(id=>id!==custId);
  updateTabCount('customers');
}


// PARTS & SERVICES
async function loadPartsView(container) {
  if(!state.selections.parts) state.selections.parts={categories:[],items:[]};
  const data=await apiGet('module=parts&sub=categories');
  const cats=data.data||[];
  if(!cats.length){container.innerHTML='<div class="empty-state">No product categories found.</div>';return;}
  container.innerHTML=`<div class="type-toggle"><div class="tt active" id="pt-parts" onclick="switchPartsType('parts')">Parts</div><div class="tt" id="pt-services" onclick="switchPartsType('services')">Services</div></div><div id="pv-parts"></div><div id="pv-services" style="display:none"></div>`;
  const allItems={};
  // Load items per category using confirmed filter.category_uid param
  await Promise.all(cats.map(async cat=>{
    const d=await apiGet('module=parts&sub=items&selected='+cat.id); // calls /product/{catId}
    allItems[cat.id]={cat,items:d.data||[]};
  }));
  renderPartsView(allItems,'parts');
  renderPartsView(allItems,'services');
}

function renderPartsView(allItems,type) {
  const container=document.getElementById('pv-'+type);
  let html='';
  Object.values(allItems).forEach(({cat,items})=>{
    const filtered=items.filter(i=>type==='services'?(i.type||'').toUpperCase()==='SERVICE':(i.type||'').toUpperCase()!=='SERVICE');
    if(!filtered.length) return;
    html+=`<div class="cat-block" id="pcat-${type}-${cat.id}">
      <div class="cat-header" onclick="toggleCatBody('pbody-${type}-${cat.id}')">
        <div class="big-cb" id="pcb-${type}-${cat.id}" onclick="event.stopPropagation();togglePartsCat('${cat.id}','${type}')"></div>
        <span class="cat-name">${esc(cat.name)}</span>
        <span class="cat-sel-count" id="pcsc-${type}-${cat.id}"></span>
        <span class="cat-meta-txt">${filtered.length} items</span>
        <span class="chev open">&#9660;</span>
      </div>
      <div class="cat-body" id="pbody-${type}-${cat.id}">
        <div class="sub-lbl">${type==='services'?'Services':'Parts'}</div>
        <div class="item-grid">${filtered.map(p=>`
          <div class="item-card" id="pi-${p.id}" onclick="togglePart('${p.id}','${cat.id}','${type}')">
            <div class="sm-cb"></div>
            <div class="i-info">
              <div class="i-name">${esc(p.name)}</div>
              <div class="i-detail">${p.sku?'SKU: '+esc(p.sku)+' \u00b7 ':''}${p.price!==''?'$'+p.price:''}</div>
            </div>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  });
  container.innerHTML=html||`<div class="empty-state">No ${type} found.</div>`;
}

function switchPartsType(type) {
  document.getElementById('pv-parts').style.display=type==='parts'?'block':'none';
  document.getElementById('pv-services').style.display=type==='services'?'block':'none';
  document.getElementById('pt-parts').classList.toggle('active',type==='parts');
  document.getElementById('pt-services').classList.toggle('active',type==='services');
}

function togglePartsCat(catId,type) {
  const sel=state.selections.parts;
  const isOn=!sel.categories.includes(catId);
  if(isOn) sel.categories.push(catId); else sel.categories=sel.categories.filter(id=>id!==catId);
  const cb=document.getElementById('pcb-'+type+'-'+catId); if(cb) cb.className='big-cb'+(isOn?' on':'');
  updateTabCount('parts');
}

function togglePart(itemId,catId,type) {
  const sel=state.selections.parts;
  const el=document.getElementById('pi-'+itemId);
  const isOn=el.classList.toggle('on');
  el.querySelector('.sm-cb').classList.toggle('on',isOn);
  if(isOn){if(!sel.items.includes(itemId)) sel.items.push(itemId);}
  else sel.items=sel.items.filter(id=>id!==itemId);
  if(isOn&&!sel.categories.includes(catId)) sel.categories.push(catId);
  const catSel=document.querySelectorAll('#pbody-'+type+'-'+catId+' .item-card.on').length;
  const csc=document.getElementById('pcsc-'+type+'-'+catId);
  if(csc){csc.textContent=catSel+' sel';csc.className='cat-sel-count'+(catSel?' vis':'');}
  const block=document.getElementById('pcat-'+type+'-'+catId); if(block) block.classList.toggle('has-sel',catSel>0);
  updateTabCount('parts');
}

// ASSETS
async function loadAssetsView(container) {
  if(!state.selections.assets) state.selections.assets={categories:[],assets:{}};
  const data=await apiGet('module=assets&sub=categories');
  const cats=data.data||[];
  if(!cats.length){container.innerHTML='<div class="empty-state">No asset categories found.</div>';return;}
  container.innerHTML=cats.map(cat=>`
    <div class="cat-block" id="acat-${cat.id}">
      <div class="cat-header" onclick="toggleCatBody('abody-${cat.id}')">
        <div class="big-cb" id="acb-${cat.id}" onclick="event.stopPropagation();toggleAssetCat('${cat.id}')"></div>
        <span class="cat-name">${esc(cat.name)}</span>
        <span class="cat-sel-count" id="acsc-${cat.id}"></span>
        <span class="cat-meta-txt" id="ameta-${cat.id}">Loading\u2026</span>
        <span class="chev open">&#9660;</span>
      </div>
      <div class="cat-body" id="abody-${cat.id}">${loadingDots()}</div>
    </div>`).join('');
  cats.forEach(cat=>loadAssetList(cat));
}

async function loadAssetList(cat) {
  const data=await apiGet('module=assets&sub=list&selected='+cat.id);
  const assets=data.data||[];
  const meta=document.getElementById('ameta-'+cat.id); if(meta) meta.textContent=assets.length+' assets';
  if(!state.selections.assets.assets[cat.id]) state.selections.assets.assets[cat.id]=[];
  const body=document.getElementById('abody-'+cat.id);
  if(!assets.length){body.innerHTML='<div class="empty-state" style="padding:1rem">No assets found.</div>';return;}
  body.innerHTML='<div class="sub-lbl">Assets</div><div class="item-grid">'+
    assets.map(a=>`
      <div class="item-card" id="ai-${cat.id}-${a.id}" onclick="toggleAsset('${a.id}','${cat.id}')">
        <div class="sm-cb"></div>
        <div class="i-info">
          <div class="i-name">${esc(a.name)}</div>
          <div class="i-detail">${[a.model,a.serial?'S/N: '+a.serial:''].filter(Boolean).join(' \u00b7 ')}</div>
          ${a.installed?`<div class="i-detail">Installed: ${esc(a.installed)}</div>`:''}
        </div>
      </div>`).join('')+'</div>';
}

function toggleAssetCat(catId) {
  const sel=state.selections.assets;
  const isOn=!sel.categories.includes(catId);
  if(isOn) sel.categories.push(catId); else sel.categories=sel.categories.filter(id=>id!==catId);
  const cb=document.getElementById('acb-'+catId); if(cb) cb.className='big-cb'+(isOn?' on':'');
  updateTabCount('assets');
}

function toggleAsset(assetId,catId) {
  const sel=state.selections.assets;
  if(!sel.assets[catId]) sel.assets[catId]=[];
  const el=document.getElementById('ai-'+catId+'-'+assetId);
  const isOn=el.classList.toggle('on');
  el.querySelector('.sm-cb').classList.toggle('on',isOn);
  if(isOn){if(!sel.assets[catId].includes(assetId)) sel.assets[catId].push(assetId);}
  else sel.assets[catId]=sel.assets[catId].filter(id=>id!==assetId);
  if(isOn&&!sel.categories.includes(catId)) sel.categories.push(catId);
  const catSel=(sel.assets[catId]||[]).length;
  const csc=document.getElementById('acsc-'+catId);
  if(csc){csc.textContent=catSel+' sel';csc.className='cat-sel-count'+(catSel?' vis':'');}
  const block=document.getElementById('acat-'+catId); if(block) block.classList.toggle('has-sel',catSel>0);
  updateTabCount('assets');
}

// WORKFLOWS
async function loadWorkflowsView(container) {
  if(!state.selections.workflows) state.selections.workflows={workflows:[]};
  const data=await apiGet('module=workflows&sub=list');
  const wfs=data.data||[];
  if(!wfs.length){container.innerHTML='<div class="empty-state">No workflows found.</div>';return;}
  container.innerHTML='<div class="wf-list">'+wfs.map(w=>`
    <div class="wf-item" id="wi-${w.id}" onclick="toggleWorkflow('${w.id}')">
      <div class="wf-icon"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div><div class="wf-name">${esc(w.name)}</div>${w.trigger?`<div class="wf-trigger">Trigger: ${esc(w.trigger)}</div>`:''}</div>
      <div class="wf-ck"></div>
    </div>`).join('')+'</div>';
}

function toggleWorkflow(wfId) {
  const sel=state.selections.workflows;
  const el=document.getElementById('wi-'+wfId);
  const isOn=el.classList.toggle('on');
  if(isOn){if(!sel.workflows.includes(wfId)) sel.workflows.push(wfId);}
  else sel.workflows=sel.workflows.filter(id=>id!==wfId);
  updateTabCount('workflows');
}

// CHECKLISTS (shared view for both checklists2form and checklists modules)
// moduleKey is either 'checklists2form' or 'checklists'
async function loadChecklistsModuleView(moduleKey, container) {
  if(!state.selections[moduleKey]) state.selections[moduleKey]={checklists:[]};
  const modeLabel = moduleKey==='checklists2form' ? 'will become inspection form' : 'will be migrated as checklist';
  container.innerHTML='<div class="loading-state">'+loadingDots()+'<span>Loading job categories…</span></div>';
  const data=await apiGet('module=jobs&sub=categories');
  const cats=data.data||[];
  if(!cats.length){container.innerHTML='<div class="empty-state">No job categories found.</div>';return;}
  container.innerHTML=cats.map(cat=>{
    const statuses=cat.statuses||[];
    const catNameSafe=encodeURIComponent(cat.name);
    const statusRows=statuses.map(s=>{
      const statusNameSafe=encodeURIComponent(s.name);
      return `<div class="s-row">
        <div class="s-item s-item-locked" id="${moduleKey}-si-${s.id}">
          <div class="s-dot" style="background:${esc(s.color||'#888')}"></div>
          <span class="s-name">${esc(s.name)}</span>
          <span class="cl-loading-badge" id="${moduleKey}-clb-${s.id}"></span>
        </div>
        <div class="cl-drawer open" id="${moduleKey}-cl-${s.id}">
          <div class="cl-lbl">${modeLabel==='will become inspection form'?'Checklists — will become inspection form "<strong>'+esc(cat.name)+' — '+esc(s.name)+'</strong>"':'Checklists — select to migrate'}</div>
          <div class="cl-chips" id="${moduleKey}-cl-chips-${s.id}"
            data-modulekey="${moduleKey}"
            data-catid="${cat.id}"
            data-catname="${catNameSafe}"
            data-statusid="${s.id}"
            data-statusname="${statusNameSafe}">
            <span style="font-size:12px;color:var(--muted)">Loading…</span>
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div class="cat-block has-sel" id="${moduleKey}-cat-${cat.id}">
      <div class="cat-header" onclick="toggleCatBody('${moduleKey}-body-${cat.id}')">
        <div class="big-cb on" id="${moduleKey}-cb-${cat.id}"></div>
        <span class="cat-name">${esc(cat.name)}</span>
        <span class="cat-sel-count" id="${moduleKey}-csc-${cat.id}"></span>
        <span class="cat-meta-txt">${statuses.length} status${statuses.length!==1?'es':''}</span>
        <span class="chev open">&#9660;</span>
      </div>
      <div class="cat-body" id="${moduleKey}-body-${cat.id}">
        ${statuses.length?statusRows:'<div class="empty-state" style="padding:1rem">No statuses found.</div>'}
      </div>
    </div>`;
  }).join('');

  // Load checklists for all statuses
  for(const cat of cats){
    for(const s of (cat.statuses||[])){
      loadChecklistChips(moduleKey, cat.id, cat.name, s.id, s.name);
    }
  }
}

async function loadChecklistChips(moduleKey, catId, catName, statusId, statusName) {
  const chipsEl = document.getElementById(moduleKey+'-cl-chips-'+statusId);
  if(!chipsEl) return;
  try {
    const data = await apiGet('module=jobs&sub=checklists&catId='+encodeURIComponent(catId)+'&statusId='+encodeURIComponent(statusId));
    const checklists = data.data||[];
    const badge = document.getElementById(moduleKey+'-clb-'+statusId);
    if(!checklists.length){
      chipsEl.innerHTML='<span class="no-cl">No checklists</span>';
      return;
    }
    if(badge){badge.className='cl-pill';badge.textContent=checklists.length+' item'+(checklists.length>1?'s':'');}
    const catNameE=encodeURIComponent(catName);
    const statusNameE=encodeURIComponent(statusName);
    chipsEl.innerHTML=`<div style="display:flex;gap:8px;margin-bottom:6px;">
      <button class="lnk" onclick="clModuleSelectAll('${moduleKey}','${statusId}')">Select all</button>
      <button class="lnk" onclick="clModuleClearAll('${moduleKey}','${statusId}')">Clear all</button>
    </div>`+
    checklists.map(c=>{
      const typeLabel=CL_TYPE_MAP[c.type]||c.type||'';
      return `<div class="cl-chip" id="${moduleKey}-clc-${c.id}"
        data-modulekey="${moduleKey}" data-clgrp="${statusId}"
        data-catid="${catId}" data-catname="${catNameE}"
        data-statusid="${statusId}" data-statusname="${statusNameE}"
        onclick="toggleChecklistModule('${moduleKey}','${c.id}','${catId}','${statusId}')">
        <div class="ck"></div>
        <span style="flex:1">${esc(c.name)}</span>
        ${typeLabel?`<span style="font-size:10px;padding:1px 6px;border-radius:20px;background:var(--surface2);color:var(--muted2);margin-left:4px">${typeLabel}</span>`:''}
      </div>`;
    }).join('');
  } catch(e) {
    chipsEl.innerHTML='<span class="no-cl">Could not load</span>';
  }
}

function toggleChecklistModule(moduleKey, clId, catId, statusId) {
  const sel=state.selections[moduleKey];
  const el=document.getElementById(moduleKey+'-clc-'+clId);
  if(!el) return;
  const isOn=el.classList.toggle('on');
  el.querySelector('.ck').classList.toggle('on',isOn);
  const catName    = decodeURIComponent(el.dataset.catname    || '');
  const statusName = decodeURIComponent(el.dataset.statusname || '');
  if(isOn){
    if(!sel.checklists.find(c=>c.id===clId)){
      sel.checklists.push({ id:clId, catId, catName, statusId, statusName });
    }
  } else {
    sel.checklists = sel.checklists.filter(c=>c.id!==clId);
  }
  // Update count badge
  const grpCount = sel.checklists.filter(c=>c.statusId===statusId).length;
  const csc = document.getElementById(moduleKey+'-csc-'+document.getElementById(moduleKey+'-clc-'+clId)?.dataset?.catid);
  updateTabCount(moduleKey);
}

function clModuleSelectAll(moduleKey, statusId) {
  document.querySelectorAll(`[data-modulekey="${moduleKey}"][data-clgrp="${statusId}"]`).forEach(el=>{
    if(!el.classList.contains('on')){
      el.classList.add('on');
      const ck=el.querySelector('.ck'); if(ck) ck.classList.add('on');
      const id         = el.id.replace(moduleKey+'-clc-','');
      const catId      = el.dataset.catid      || '';
      const catName    = decodeURIComponent(el.dataset.catname    || '');
      const statusName = decodeURIComponent(el.dataset.statusname || '');
      if(!state.selections[moduleKey].checklists.find(c=>c.id===id)){
        state.selections[moduleKey].checklists.push({ id, catId, catName, statusId, statusName });
      }
    }
  });
  updateTabCount(moduleKey);
}

function clModuleClearAll(moduleKey, statusId) {
  const ids=new Set();
  document.querySelectorAll(`[data-modulekey="${moduleKey}"][data-clgrp="${statusId}"]`).forEach(el=>{
    el.classList.remove('on');
    const ck=el.querySelector('.ck'); if(ck) ck.classList.remove('on');
    ids.add(el.id.replace(moduleKey+'-clc-',''));
  });
  state.selections[moduleKey].checklists = state.selections[moduleKey].checklists.filter(c=>!ids.has(c.id));
  updateTabCount(moduleKey);
}
async function loadInspectionFormsView(container) {
  if(!state.selections.inspectionforms) state.selections.inspectionforms={forms:[]};
  container.innerHTML='<div class="loading-state">'+loadingDots()+'<span>Loading inspection forms…</span></div>';
  const data=await apiGet('module=inspectionforms&sub=list');
  const forms=data.data||[];
  if(!forms.length){container.innerHTML='<div class="empty-state">No inspection forms found.</div>';return;}
  container.innerHTML=`
    <div class="sel-all-bar">
      <span>${forms.length} inspection form${forms.length!==1?'s':''} found</span>
      <button class="sel-all-btn" onclick="selectAllForms(true)">Select all</button>
      <button class="sel-all-btn" onclick="selectAllForms(false)">Deselect all</button>
    </div>
    <div class="wf-list">
      ${forms.map(f=>`
        <div class="wf-item" id="iform-${f.id}" onclick="toggleInspectionForm('${f.id}')">
          <div class="sm-cb"></div>
          <span class="wf-name">${esc(f.name)}</span>
          <span class="wf-meta">${f.fieldCount} field${f.fieldCount!==1?'s':''}</span>
        </div>`).join('')}
    </div>`;
}

function toggleInspectionForm(formId) {
  const sel=state.selections.inspectionforms;
  const el=document.getElementById('iform-'+formId);
  const isOn=el.classList.toggle('on');
  el.querySelector('.sm-cb').classList.toggle('on',isOn);
  if(isOn){if(!sel.forms.includes(formId)) sel.forms.push(formId);}
  else sel.forms=sel.forms.filter(id=>id!==formId);
  updateTabCount('inspectionforms');
}

function selectAllForms(on) {
  const sel=state.selections.inspectionforms;
  document.querySelectorAll('[id^="iform-"]').forEach(el=>{
    const id=el.id.replace('iform-','');
    el.classList.toggle('on',on);
    const cb=el.querySelector('.sm-cb'); if(cb) cb.classList.toggle('on',on);
    if(on){if(!sel.forms.includes(id)) sel.forms.push(id);}
  });
  if(!on) sel.forms=[];
  updateTabCount('inspectionforms');
}

// EMAIL & SMS TEMPLATES
async function loadEmailTemplatesView(container) {
  if(!state.selections.emailtemplates) state.selections.emailtemplates={templates:[]};
  container.innerHTML='<div class="loading-state">'+loadingDots()+'<span>Loading templates…</span></div>';
  const data=await apiGet('module=emailtemplates&sub=list');
  const items=data.data||[];
  if(!items.length){container.innerHTML='<div class="empty-state">No email or SMS templates found.</div>';return;}

  // Group by type: EMAIL then SMS
  const emails=items.filter(t=>t.type==='EMAIL');
  const sms=items.filter(t=>t.type==='SMS');

  function renderGroup(groupLabel,groupItems,typeClass) {
    if(!groupItems.length) return '';
    return `<div class="cf-group">
      <div class="cf-group-header">
        <span class="cf-group-name">${esc(groupLabel)}</span>
        <div class="cf-group-actions">
          <button class="btn-link" onclick="selectAllTemplates(true,'${typeClass}')">All</button>
          <button class="btn-link" onclick="selectAllTemplates(false,'${typeClass}')">None</button>
        </div>
      </div>
      ${groupItems.map(t=>{
        const tid=t.id;
        const isOn=(state.selections.emailtemplates.templates||[]).includes(tid);
        return `<div class="sm-item ${isOn?'on':''}" id="etpl-${esc(tid)}" data-type="${typeClass}" onclick="toggleTemplate('${esc(tid)}')">
          <div class="sm-info">
            <div class="sm-name">${esc(t.name)}</div>
            <div class="sm-meta">${esc(t.module||'')}${t.description?' · '+esc(t.description.substring(0,60)):''}</div>
          </div>
          <div class="sm-cb ${isOn?'on':''}"></div>
        </div>`;
      }).join('')}
    </div>`;
  }

  container.innerHTML=
    `<div class="section-actions">
       <button class="btn-link" onclick="selectAllTemplates(true,'etpl-all')">Select all</button>
       <button class="btn-link" onclick="selectAllTemplates(false,'etpl-all')">Clear all</button>
     </div>`+
    renderGroup('Email templates',emails,'EMAIL')+
    renderGroup('SMS templates',sms,'SMS');
}

function toggleTemplate(tplId) {
  const sel=state.selections.emailtemplates;
  const el=document.getElementById('etpl-'+tplId);
  const isOn=el.classList.toggle('on');
  el.querySelector('.sm-cb').classList.toggle('on',isOn);
  if(isOn){if(!sel.templates.includes(tplId)) sel.templates.push(tplId);}
  else sel.templates=sel.templates.filter(id=>id!==tplId);
  updateTabCount('emailtemplates');
}

function selectAllTemplates(on,typeClass) {
  const sel=state.selections.emailtemplates;
  let els;
  if(typeClass==='etpl-all') {
    els=document.querySelectorAll('[id^="etpl-"]');
  } else {
    els=document.querySelectorAll(`[id^="etpl-"][data-type="${typeClass}"]`);
  }
  els.forEach(el=>{
    const id=el.id.replace('etpl-','');
    el.classList.toggle('on',on);
    const cb=el.querySelector('.sm-cb'); if(cb) cb.classList.toggle('on',on);
    if(on){if(!sel.templates.includes(id)) sel.templates.push(id);}
    else sel.templates=sel.templates.filter(x=>x!==id);
  });
  updateTabCount('emailtemplates');
}

// CUSTOM FIELDS
const CF_SUBS=[
  {key:'job',label:'Jobs'},{key:'customer',label:'Customers'},
  {key:'organization',label:'Organizations'},{key:'property',label:'Properties'},
  {key:'product',label:'Parts & services'},{key:'asset',label:'Assets'},
  {key:'estimate',label:'Quotes'},{key:'invoice',label:'Invoices'},
];
const FT_MAP={
  SINGLE_LINE:['Single line','ft-sl'],SINGLE_ITEM:['Dropdown','ft-dd'],
  MULTI_LINE:['Multi line','ft-ml'],MULTI_ITEM:['Multi select','ft-ms'],
  NUMBER:['Number','ft-nm'],DATE:['Date','ft-dt'],PHOTO:['Photo','ft-ph'],
  SIGNATURE:['Signature','ft-sg'],BOOLEAN:['Boolean','ft-bl'],FILE:['File','ft-fi'],
};

async function loadCustomFieldsView(container) {
  if(!state.selections.customfields) state.selections.customfields={};
  container.innerHTML=`
    <div class="cf-sub-tab-bar">
      ${CF_SUBS.map((s,i)=>`<div class="cf-stab${i===0?' active':''}" data-sub="${s.key}" onclick="switchCFTab('${s.key}')">${s.label} <span class="cf-sc" id="cfsc-${s.key}">0</span></div>`).join('')}
    </div>
    <div id="cf-views">
      ${CF_SUBS.map((s,i)=>`<div class="cf-view${i===0?' active':''}" id="cfv-${s.key}"><div class="loading-state">${loadingDots()}</div></div>`).join('')}
    </div>`;
  CF_SUBS.forEach(s=>loadCFSubView(s));
}

async function loadCFSubView(sub) {
  if(!state.selections.customfields[sub.key]) state.selections.customfields[sub.key]={};
  const data=await apiGet('module=customfields&sub='+sub.key);
  const groups=data.groups||[];
  const view=document.getElementById('cfv-'+sub.key);
  if(!groups.length||groups.every(g=>!g.fields.length)){
    view.innerHTML='<div class="empty-state">No custom fields found.</div>';return;
  }
  const total=groups.reduce((a,g)=>a+g.fields.length,0);
  groups.forEach(g=>{if(!state.selections.customfields[sub.key][g.id]) state.selections.customfields[sub.key][g.id]=[];});
  view.innerHTML=`
    <div class="cf-sel-bar">
      <div class="cf-sel-left"><span class="cf-sel-label">${sub.label} custom fields</span><span class="cf-sel-count" id="cfct-${sub.key}">0 of ${total} selected</span></div>
      <div class="cf-sel-actions">
        <button class="lnk" onclick="cfSelectAll('${sub.key}',${total})">Select all</button>
        <span style="color:var(--muted)"> · </span>
        <button class="lnk" onclick="cfClearAll('${sub.key}',${total})">Clear all</button>
      </div>
    </div>`+
    groups.map(g=>`
      <div style="margin-bottom:1rem;">
        <div class="sub-lbl" style="margin-bottom:8px">${esc(g.name)}</div>
        <div class="fields-grid">${g.fields.map(f=>{
          const [label,cls]=FT_MAP[f.type]||['Other','ft-other'];
          return `<div class="fc" data-cf="${sub.key}" data-grp="${g.id}" data-fid="${f.id}" onclick="toggleCF(this,'${sub.key}','${g.id}','${f.id}',${total})">
            <div class="sm-cb"></div>
            <div><div class="fc-name">${esc(f.name)}</div><span class="ft ${cls}">${label}</span></div>
          </div>`;
        }).join('')}</div>
      </div>`).join('');
  document.getElementById('cfsc-'+sub.key).textContent=0;
}

function switchCFTab(key) {
  document.querySelectorAll('.cf-stab').forEach(t=>t.classList.toggle('active',t.dataset.sub===key));
  document.querySelectorAll('.cf-view').forEach(v=>v.classList.toggle('active',v.id==='cfv-'+key));
}

function toggleCF(el,sub,grpId,fid,total) {
  const isOn=el.classList.toggle('on');
  el.querySelector('.sm-cb').classList.toggle('on',isOn);
  if(!state.selections.customfields[sub]) state.selections.customfields[sub]={};
  if(!state.selections.customfields[sub][grpId]) state.selections.customfields[sub][grpId]=[];
  if(isOn){if(!state.selections.customfields[sub][grpId].includes(fid)) state.selections.customfields[sub][grpId].push(fid);}
  else state.selections.customfields[sub][grpId]=state.selections.customfields[sub][grpId].filter(id=>id!==fid);
  const count=Object.values(state.selections.customfields[sub]).flat().length;
  const sc=document.getElementById('cfsc-'+sub); if(sc) sc.textContent=count;
  const ct=document.getElementById('cfct-'+sub); if(ct) ct.textContent=count+' of '+total+' selected';
  updateTabCount('customfields');
}

function cfSelectAll(sub,total) {
  if(!state.selections.customfields[sub]) state.selections.customfields[sub]={};
  document.querySelectorAll('[data-cf="'+sub+'"]').forEach(el=>{
    el.classList.add('on'); el.querySelector('.sm-cb').classList.add('on');
    const grpId=el.dataset.grp; const fid=el.dataset.fid;
    if(!state.selections.customfields[sub][grpId]) state.selections.customfields[sub][grpId]=[];
    if(!state.selections.customfields[sub][grpId].includes(fid)) state.selections.customfields[sub][grpId].push(fid);
  });
  const sc=document.getElementById('cfsc-'+sub); if(sc) sc.textContent=total;
  const ct=document.getElementById('cfct-'+sub); if(ct) ct.textContent=total+' of '+total+' selected';
  updateTabCount('customfields');
}

function cfClearAll(sub,total) {
  state.selections.customfields[sub]={};
  document.querySelectorAll('[data-cf="'+sub+'"]').forEach(el=>{el.classList.remove('on');el.querySelector('.sm-cb').classList.remove('on');});
  const sc=document.getElementById('cfsc-'+sub); if(sc) sc.textContent=0;
  const ct=document.getElementById('cfct-'+sub); if(ct) ct.textContent='0 of '+total+' selected';
  updateTabCount('customfields');
}
// PAGE 4 — REVIEW
function initReviewPage() {
  document.getElementById('rev-src-name').textContent=state.srcCompany||'—';
  document.getElementById('rev-src-region').textContent=state.srcRegion||'—';
  document.getElementById('rev-dst-name').textContent=state.dstCompany||'—';
  document.getElementById('rev-dst-region').textContent=state.dstRegion||'—';
  const body=document.getElementById('review-body');
  let html='<div class="divider"></div>';
  state.selectedModules.forEach(key=>{
    const m=MODULE_DEFS.find(d=>d.key===key); if(!m) return;
    const s=state.selections[key]||{};
    html+=`<div class="review-section"><div class="rs-title">${m.name}</div>`;
    if(key==='jobs'){
      if((s.categories||[]).length) html+=rRow('Categories',s.categories.length+' selected');
      if((s.statuses||[]).length) html+=rRow('Statuses',s.statuses.length+' selected');
    } else if(key==='checklists2form'){
      if((s.checklists||[]).length) html+=rRow('Checklists → Inspection forms',s.checklists.length+' checklist'+(s.checklists.length!==1?'s':''));
    } else if(key==='checklists'){
      if((s.checklists||[]).length) html+=rRow('Checklists',s.checklists.length+' checklist'+(s.checklists.length!==1?'s':''));
    } else if(key==='assets'){
      const all=Object.values(s.assets||{}).flat();
      if(all.length) html+=rRow('Assets',all.length+' assets');
    } else if(key==='inspectionforms'){
      if((s.forms||[]).length) html+=rRow('Inspection forms',s.forms.length+' form'+(s.forms.length!==1?'s':''));
    } else if(key==='workflows'){
      if((s.workflows||[]).length) html+=rRow('Workflows',s.workflows.length+' workflows');
    } else if(key==='customfields'){
      CF_SUBS.forEach(sub=>{
        const count=Object.values(s[sub.key]||{}).flat().filter(Boolean).length;
        if(count) html+=rRow(sub.label,count+' field'+(count!==1?'s':''));
      });
    }
    html+='</div><div class="divider"></div>';
  });
  body.innerHTML=html;
  document.getElementById('migrate-progress').style.display='none';
  document.getElementById('done-banner').style.display='none';
  document.getElementById('migrate-btn').disabled=false;
  document.getElementById('migrate-btn').textContent='Start migration \u2192';
  document.getElementById('back-btn-4').disabled=false;
}

function rRow(label,value) {
  return `<div class="r-row"><span class="r-key">${esc(label)}</span><div class="r-tags"><span class="r-tag">${esc(value)}</span></div></div>`;
}

// MIGRATION
let migrationLog=[];

async function startMigration() {
  const btn=document.getElementById('migrate-btn');
  btn.disabled=true; btn.textContent='Migrating\u2026';
  document.getElementById('back-btn-4').disabled=true;
  document.getElementById('migrate-progress').style.display='block';
  document.getElementById('done-banner').style.display='none';
  hideError('migrate-error');
  migrationLog=[]; let ok=0,skip=0,fail=0;
  const logWrap=document.getElementById('log-wrap');
  logWrap.innerHTML='';

  function addLog(msg,cls){
    migrationLog.push({msg,cls});
    const line=document.createElement('div');
    line.className=cls||'log-info'; line.textContent=msg;
    logWrap.appendChild(line); logWrap.scrollTop=logWrap.scrollHeight;
  }
  function updateStats(o,s,f){
    document.getElementById('stat-ok').textContent=o;
    document.getElementById('stat-skip').textContent=s;
    document.getElementById('stat-fail').textContent=f;
  }

  try {
    const res=await fetch(api('migrate'),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sessionToken:state.sessionToken,selectedModules:state.selectedModules,selections:state.selections})});
    const text=await res.text();
    text.split('\n').filter(Boolean).forEach(line=>{
      try {
        const ev=JSON.parse(line);
        if(ev.type==='start'||ev.type==='progress') addLog(ev.message,'log-info');
        else if(ev.type==='record'){
          if(ev.status==='ok'){ok++;addLog('\u2713 '+ev.name,'log-ok');}
          else if(ev.status==='skip'){skip++;addLog('\u21B7 '+ev.name+(ev.reason?' \u2014 '+ev.reason:''),'log-skip');}
          else{fail++;addLog('\u2717 '+ev.name+(ev.reason?' \u2014 '+ev.reason:''),'log-err');}
          updateStats(ok,skip,fail);
        } else if(ev.type==='error') addLog('Error: '+ev.message,'log-err');
      } catch(e){}
    });
  } catch(err) { showError('migrate-error',err.message); }

  state.summary={ok,skip,fail};
  document.getElementById('done-text').textContent=ok+' records migrated'+(skip?', '+skip+' skipped':'')+(fail?', '+fail+' failed':'')+'.';
  document.getElementById('done-banner').style.display='flex';
  btn.textContent='Done \u2713';
}

function downloadReport() {
  const rows=[['Status','Record','Detail']];
  migrationLog.forEach(({msg,cls})=>{
    if(cls==='log-ok') rows.push(['Migrated',msg.replace('\u2713 ',''),'']);
    else if(cls==='log-skip'){const p=msg.replace('\u21B7 ','').split(' \u2014 ');rows.push(['Skipped',p[0],p[1]||'']);}
    else if(cls==='log-err'){const p=msg.replace('\u2717 ','').split(' \u2014 ');rows.push(['Failed',p[0],p[1]||'']);}
  });
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='migration-report.csv'; a.click();
}

// INIT
document.addEventListener('DOMContentLoaded',()=>{
  ['src','dst'].forEach(side=>{
    document.getElementById(side+'-region').addEventListener('change',()=>identifyAccount(side));
    document.getElementById(side+'-key').addEventListener('blur',()=>{
      if(document.getElementById(side+'-region').value) identifyAccount(side);
    });
  });
  document.getElementById('connect-btn').addEventListener('click',doConnect);
  document.getElementById('back-btn-2').addEventListener('click',()=>goTo(1));
  document.getElementById('back-btn-3').addEventListener('click',()=>goTo(2));
  document.getElementById('back-btn-4').addEventListener('click',()=>goTo(3));
  document.getElementById('mod-next-btn').addEventListener('click',()=>goTo(3));
  document.getElementById('to-review-btn').addEventListener('click',()=>goTo(4));
  document.getElementById('migrate-btn').addEventListener('click',startMigration);
  document.getElementById('download-btn').addEventListener('click',downloadReport);
});
