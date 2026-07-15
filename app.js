/* ---------------------------------------------------------------
   Surplus Tracker — standalone static app
   Data lives in a Google Sheet the user owns; auth is client-side
   OAuth via Google Identity Services (no backend, no secrets).
--------------------------------------------------------------- */

const SETTINGS_KEY = 'surplusTracker.settings';
const CACHE_KEY    = 'surplusTracker.itemsCache';
const QUEUE_KEY     = 'surplusTracker.queue';

const SHEET_RANGE   = 'Inventory!A:L';
const COLUMNS       = ['ItemCode','Category','Description','Dimensions','DateAdded','Status','ReservedBy','ReservedContact','ReservedDate','Notes','Qty','Condition'];
const CATEGORY_LABELS = { B:'Bookshelf / Cabinet', T:'Table / Desk', C:'Chair', M:'Miscellaneous' };
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'Surplus Tracker Photos';

// Baked-in config (config.js) wins for shared fields, but localStorage can
// still override locally for testing without editing/redeploying config.js.
let settings = Object.assign({}, window.APP_CONFIG || {}, loadSettings());
let items = loadCache();          // array of item objects, newest-appended-last as stored, we sort for display
let queue = loadQueue();          // { [itemCode]: itemObject }
let tokenClient = null;
let accessToken = null;
let pendingPhotos = [];           // File[]/Blob[] attached in the current intake form (camera or Drive)
let currentResultCode = null;
let driveResults = [];            // cached list of recent Drive photos
let driveSelected = new Set();    // ids selected in the Drive picker

/* ---------------- storage helpers ---------------- */
function loadSettings(){
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function loadCache(){
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch { return []; }
}
function saveCache(){ localStorage.setItem(CACHE_KEY, JSON.stringify(items)); }
function loadQueue(){
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || {}; } catch { return {}; }
}
function saveQueue(){ localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ el.hidden = true; }, 2600);
}

/* ---------------- date helpers ---------------- */
function todayISO(){ return new Date().toISOString().slice(0,10); }
function nowISO(){ return new Date().toISOString(); }
function formatDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
function daysSince(iso){
  if(!iso) return 0;
  const then = new Date(iso).getTime();
  if(isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now()-then)/86400000));
}
function ageClass(days){
  if(days < 14) return 'age-fresh';
  if(days <= 30) return 'age-watch';
  return 'age-stale';
}

/* ---------------- Google auth ---------------- */
function initGoogleAuth(){
  if(!settings.clientId || typeof google === 'undefined') return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPE,
    callback: (resp) => {
      if(resp.error){ toast('Sign-in failed: ' + resp.error); return; }
      accessToken = resp.access_token;
      setAuthUI(true);
      toast('Signed in');
      flushQueue().then(refreshInventory);
    }
  });
}
function setAuthUI(signedIn){
  document.getElementById('authBtn').hidden = signedIn;
  document.getElementById('signOutBtn').hidden = !signedIn;
  document.getElementById('authStatus').hidden = !signedIn;
}
function ensureAuth(){
  return new Promise((resolve) => {
    if(accessToken){ resolve(true); return; }
    if(!tokenClient){ toast('Add your Google Client ID in Settings first'); resolve(false); return; }
    const orig = tokenClient.callback;
    tokenClient.callback = (resp) => {
      tokenClient.callback = orig;
      if(resp.error){ toast('Sign-in failed'); resolve(false); return; }
      accessToken = resp.access_token;
      setAuthUI(true);
      resolve(true);
    };
    tokenClient.requestAccessToken();
  });
}

/* ---------------- Sheets API ---------------- */
async function sheetsFetch(path, options={}){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${settings.sheetId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(options.headers||{}) }
  });
  if(!res.ok){
    const body = await res.text();
    throw new Error(`Sheets API ${res.status}: ${body.slice(0,200)}`);
  }
  return res.json();
}

async function sheetsGetAllRows(){
  const data = await sheetsFetch(`/values/${encodeURIComponent(SHEET_RANGE)}`);
  const rows = data.values || [];
  return rows.slice(1) // drop header
    .filter(r => r[0])
    .map(rowToItem);
}

function rowToItem(row){
  const o = {};
  COLUMNS.forEach((c,i) => { o[camel(c)] = row[i] || ''; });
  return o;
}
function itemToRow(item){
  return COLUMNS.map(c => item[camel(c)] || '');
}
function camel(c){ return c.charAt(0).toLowerCase() + c.slice(1); }

async function findSheetRowByCode(code){
  const data = await sheetsFetch(`/values/${encodeURIComponent('Inventory!A:A')}`);
  const rows = data.values || [];
  for(let i=1;i<rows.length;i++){
    if(rows[i][0] === code) return i+1; // 1-based row number
  }
  return null;
}

async function upsertItemToSheet(item){
  const row = itemToRow(item);
  const existingRow = await findSheetRowByCode(item.itemCode);
  if(existingRow){
    const lastCol = String.fromCharCode('A'.charCodeAt(0) + COLUMNS.length - 1); // 'L' for 12 columns
    await sheetsFetch(`/values/${encodeURIComponent(`Inventory!A${existingRow}:${lastCol}${existingRow}`)}?valueInputOption=USER_ENTERED`, {
      method:'PUT',
      body: JSON.stringify({ range:`Inventory!A${existingRow}:${lastCol}${existingRow}`, values:[row] })
    });
  } else {
    await sheetsFetch(`/values/${encodeURIComponent(SHEET_RANGE)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method:'POST',
      body: JSON.stringify({ values:[row] })
    });
  }
}

/* ---------------- Google Drive ---------------- */
async function driveFetch(path, options={}){
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...options,
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(options.headers||{}) }
  });
  if(!res.ok){
    const body = await res.text();
    throw new Error(`Drive API ${res.status}: ${body.slice(0,200)}`);
  }
  return res.json();
}

// The app manages its own folder under the drive.file scope, so it can only ever
// see/write files it created — never the rest of your Drive. First upload creates
// (or re-finds) the "Surplus Tracker Photos" folder in whatever account you sign in with.
async function ensureDriveFolder(){
  if(settings.driveFolderId) return settings.driveFolderId;
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await driveFetch(`/files?q=${q}&fields=files(id,name)`);
  if(found.files && found.files.length){
    settings.driveFolderId = found.files[0].id;
  } else {
    const created = await driveFetch('/files', {
      method:'POST',
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType:'application/vnd.google-apps.folder' })
    });
    settings.driveFolderId = created.id;
  }
  saveSettings();
  return settings.driveFolderId;
}

async function uploadPhotoToDrive(file, name, folderId){
  const boundary = 'surplustracker_' + Math.random().toString(36).slice(2);
  const metadata = { name, parents:[folderId] };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
    file,
    `\r\n--${boundary}--`
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method:'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if(!res.ok){
    const body2 = await res.text();
    throw new Error(`Drive upload ${res.status}: ${body2.slice(0,200)}`);
  }
  return res.json();
}

async function uploadPhotosToDrive(code, files){
  if(!files.length) return { ok:0, fail:0 };
  const folderId = await ensureDriveFolder();
  let ok = 0, fail = 0;
  for(let i=0;i<files.length;i++){
    const name = `${code}_${i+1}.${extOf(files[i].name)}`;
    try{ await uploadPhotoToDrive(files[i], name, folderId); ok++; }
    catch(e){ console.error('Drive upload failed for', name, e); fail++; }
  }
  return { ok, fail };
}

async function listRecentDrivePhotos(){
  const folderId = await ensureDriveFolder();
  if(!folderId){ return []; }
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
  const fields = encodeURIComponent('files(id,name,thumbnailLink,createdTime)');
  const data = await driveFetch(`/files?q=${q}&orderBy=createdTime desc&pageSize=30&fields=${fields}`);
  return data.files || [];
}
async function downloadDriveFile(id, name){
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if(!res.ok) throw new Error(`Drive download ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || 'image/jpeg' });
}

async function openDriveModal(){
  const ok = await ensureAuth();
  if(!ok) return;
  document.getElementById('driveModalBackdrop').hidden = false;
  document.getElementById('driveGrid').innerHTML = '<div class="empty-state">Loading…</div>';
  driveSelected = new Set();
  try{
    driveResults = await listRecentDrivePhotos();
    renderDriveGrid();
  } catch(e){
    console.error(e);
    document.getElementById('driveGrid').innerHTML = '<div class="empty-state">Could not load Drive photos. Make sure the Drive API is enabled and you approved Drive access at sign-in.</div>';
  }
}
function renderDriveGrid(){
  const el = document.getElementById('driveGrid');
  if(!driveResults.length){ el.innerHTML = '<div class="empty-state">No photos found in that folder.</div>'; return; }
  el.innerHTML = driveResults.map(f => `
    <div class="drive-grid-item ${driveSelected.has(f.id)?'is-selected':''}" data-id="${f.id}">
      <img src="${f.thumbnailLink || ''}" alt="${escapeHTML(f.name)}" loading="lazy">
    </div>`).join('');
  el.querySelectorAll('.drive-grid-item').forEach(node => {
    node.addEventListener('click', () => {
      const id = node.dataset.id;
      if(driveSelected.has(id)) driveSelected.delete(id); else driveSelected.add(id);
      node.classList.toggle('is-selected');
    });
  });
}
async function addSelectedDrivePhotos(){
  if(!driveSelected.size){ closeDriveModal(); return; }
  toast('Adding photos…');
  const chosen = driveResults.filter(f => driveSelected.has(f.id));
  for(const f of chosen){
    try{
      const file = await downloadDriveFile(f.id, f.name);
      pendingPhotos.push(file);
    } catch(e){ console.error('drive download failed', f.name, e); }
  }
  renderPhotoThumbs();
  closeDriveModal();
  toast(`Added ${chosen.length} photo${chosen.length===1?'':'s'}`);
}
function closeDriveModal(){ document.getElementById('driveModalBackdrop').hidden = true; }

function renderPhotoThumbs(){
  const thumbs = document.getElementById('photoThumbs');
  thumbs.innerHTML = pendingPhotos.map((f,i) => `
    <span class="photo-thumb" data-i="${i}">
      <img src="${URL.createObjectURL(f)}" alt="">
      <button type="button" class="photo-thumb-remove" data-i="${i}" aria-label="Remove photo">×</button>
    </span>`).join('');
  thumbs.querySelectorAll('.photo-thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingPhotos.splice(Number(btn.dataset.i), 1);
      renderPhotoThumbs();
    });
  });
  document.getElementById('photoCount').textContent = pendingPhotos.length
    ? `${pendingPhotos.length} photo${pendingPhotos.length===1?'':'s'} attached`
    : 'No photos yet';
}

/* ---------------- AI assist (Gemini via Cloud Function proxy) ---------------- */
function fileToBase64(file){
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function callVisionProxy(file, mode){
  if(!settings.visionProxyUrl){ toast('Add your Cloud Function URL in config.js'); return null; }
  const b64 = await fileToBase64(file);
  const res = await fetch(settings.visionProxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: b64, mimeType: file.type || 'image/jpeg', mode })
  });
  if(!res.ok) throw new Error(`Vision proxy ${res.status}`);
  return res.json();
}
async function runCategoryGuess(){
  if(!pendingPhotos.length){ toast('Attach at least one photo first'); return; }
  const statusEl = document.getElementById('aiStatus');
  statusEl.textContent = 'Looking at the photo…';
  try{
    const result = await callVisionProxy(pendingPhotos[0], 'category');
    if(result && result.category && CATEGORY_LABELS[result.category]){
      document.getElementById('fCategory').value = result.category;
      updateCodePreview();
    }
    if(result && result.description && !document.getElementById('fDescription').value){
      document.getElementById('fDescription').value = result.description;
    }
    statusEl.textContent = 'Filled in — double-check before saving.';
  } catch(e){
    console.error(e);
    statusEl.textContent = 'Could not reach the AI assist — check config.js / Cloud Function.';
  }
}
async function runDimensionRead(){
  if(!pendingPhotos.length){ toast('Attach a photo of the written dimensions first'); return; }
  const statusEl = document.getElementById('aiStatus');
  statusEl.textContent = 'Reading dimensions…';
  try{
    const result = await callVisionProxy(pendingPhotos[pendingPhotos.length-1], 'dimensions');
    if(result && result.dimensions){
      document.getElementById('fDimensions').value = result.dimensions;
      statusEl.textContent = 'Filled in — double-check before saving.';
    } else {
      statusEl.textContent = "Couldn't make out dimensions in that photo — try a clearer shot.";
    }
  } catch(e){
    console.error(e);
    statusEl.textContent = 'Could not reach the AI assist — check config.js / Cloud Function.';
  }
}

/* ---------------- sync queue (works offline / signed out) ---------------- */
function queueUpsert(item){
  queue[item.itemCode] = item;
  saveQueue();
  if(accessToken) flushQueue();
}
async function flushQueue(){
  const codes = Object.keys(queue);
  if(codes.length === 0) return;
  if(!accessToken) return;
  let ok = 0, fail = 0;
  for(const code of codes){
    try{
      await upsertItemToSheet(queue[code]);
      delete queue[code];
      ok++;
    } catch(e){
      fail++;
      console.error('sync failed for', code, e);
    }
  }
  saveQueue();
  if(ok) toast(`Synced ${ok} item${ok===1?'':'s'}${fail? `, ${fail} failed`:''}`);
  else if(fail) toast(`Sync failed for ${fail} item${fail===1?'':'s'}`);
}

async function refreshInventory(){
  if(!accessToken){
    const got = await ensureAuth();
    if(!got) return;
  }
  try{
    const remote = await sheetsGetAllRows();
    // merge: queued local edits win over remote until they sync
    const queued = Object.values(queue);
    const map = new Map(remote.map(i => [i.itemCode, i]));
    queued.forEach(i => map.set(i.itemCode, i));
    items = Array.from(map.values());
    saveCache();
    renderInventoryList();
    renderReservedList();
    toast('Inventory synced');
  } catch(e){
    console.error(e);
    toast('Could not reach the sheet — check Settings');
  }
}

/* ---------------- item codes ---------------- */
function nextCode(category){
  const nums = items
    .filter(i => i.category === category)
    .map(i => parseInt((i.itemCode||'').slice(1),10))
    .filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return category + String(next).padStart(3,'0');
}

/* ---------------- captions ---------------- */
function buildStackedCaption(item){
  const lines = [item.itemCode, CATEGORY_LABELS[item.category] || item.category, item.description];
  if(item.dimensions) lines.push(item.dimensions);
  lines.push(`Qty: ${item.qty || 1}`);
  if(item.condition) lines.push(item.condition);
  return lines.join('\n');
}
function buildLineCaption(item){
  const parts = [item.itemCode, CATEGORY_LABELS[item.category] || item.category, item.description];
  if(item.dimensions) parts.push(item.dimensions);
  parts.push(`Qty: ${item.qty || 1}`);
  if(item.condition) parts.push(item.condition);
  return parts.join(' – ');
}

/* ---------------- email text ---------------- */
function buildEmailText(item){
  return `Subject: Surplus item ${item.itemCode} — reservation confirmed

Hi ${item.reservedBy},

This confirms your reservation of the following surplus item:

Item: ${item.itemCode} — ${item.description}
Reserved on: ${formatDate(item.reservedDate)}

Please plan to arrange pickup within 30 days of the reservation date above. If we haven't heard from you by then, the item may be released back into general availability.

Questions or need to coordinate pickup? Just reply to this email.

Thanks,
CSULB Parking & Operations — Surplus Program`;
}

/* ---------------- photo renaming / zip ---------------- */
function extOf(filename){
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename||'');
  return m ? m[1] : 'jpg';
}
async function downloadRenamedPhotos(code, files){
  if(!files.length){ toast('No photos to download'); return; }
  if(typeof JSZip === 'undefined'){ toast('Zip library failed to load — check connection'); return; }
  const zip = new JSZip();
  files.forEach((file,i) => {
    zip.file(`${code}_${i+1}.${extOf(file.name)}`, file);
  });
  const blob = await zip.generateAsync({type:'blob'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${code}_photos.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- rendering ---------------- */
function tagCardHTML(item){
  const statusClass = 'status-' + item.status.toLowerCase();
  let ageBadge = '';
  if(item.status === 'Reserved' && item.reservedDate){
    const d = daysSince(item.reservedDate);
    ageBadge = `<span class="age-badge ${ageClass(d)}">${d}d reserved</span>`;
  }
  const actions = [];
  if(item.status === 'Available'){
    actions.push(`<button data-action="reserve" data-code="${item.itemCode}" class="primary-action">Reserve</button>`);
  }
  if(item.status === 'Reserved'){
    actions.push(`<button data-action="email" data-code="${item.itemCode}">Confirmation text</button>`);
    actions.push(`<button data-action="claim" data-code="${item.itemCode}" class="primary-action">Mark claimed</button>`);
    actions.push(`<button data-action="release" data-code="${item.itemCode}">Release</button>`);
  }
  if(item.status === 'Claimed' || item.status === 'Available'){
    actions.push(`<button data-action="remove" data-code="${item.itemCode}">Mark removed</button>`);
  }
  const meta = item.status === 'Reserved'
    ? `${item.reservedBy || 'Unknown'} · reserved ${formatDate(item.reservedDate)}`
    : `Added ${formatDate(item.dateAdded)}`;
  const details = [];
  if(item.qty && item.qty !== '1') details.push(`Qty ${item.qty}`);
  if(item.condition) details.push(item.condition);
  const detailsLine = details.length ? `<div class="tag-card-meta">${details.join(' · ')}</div>` : '';

  return `
  <div class="tag-card">
    <div class="tag-card-top">
      <div>
        <div class="tag-card-code">${item.itemCode}</div>
        <div class="tag-card-desc">${escapeHTML(item.description)}</div>
      </div>
      <span class="status-stamp ${statusClass}">${item.status}</span>
    </div>
    ${detailsLine}
    <div class="tag-card-meta">${meta} ${ageBadge}</div>
    <div class="tag-card-actions">${actions.join('')}</div>
  </div>`;
}
function escapeHTML(s){
  const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML;
}

function renderInventoryList(){
  const search = document.getElementById('invSearch').value.trim().toLowerCase();
  const statusFilter = document.getElementById('invStatusFilter').value;
  let list = [...items].sort((a,b)=> (b.dateAdded||'').localeCompare(a.dateAdded||''));
  if(search) list = list.filter(i => i.itemCode.toLowerCase().includes(search) || (i.description||'').toLowerCase().includes(search));
  if(statusFilter) list = list.filter(i => i.status === statusFilter);
  const el = document.getElementById('inventoryList');
  el.innerHTML = list.length ? list.map(tagCardHTML).join('') : `<div class="empty-state">Nothing here yet. Log an item from the Intake tab.</div>`;
}

function renderReservedList(){
  const list = items.filter(i => i.status === 'Reserved').sort((a,b)=> daysSince(b.reservedDate)-daysSince(a.reservedDate));
  const el = document.getElementById('reservedList');
  el.innerHTML = list.length ? list.map(tagCardHTML).join('') : `<div class="empty-state">Nothing currently reserved.</div>`;
}

/* ---------------- tab navigation ---------------- */
function activateTab(name){
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('is-active', p.dataset.panel === name));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('is-active', b.dataset.target === name));
}

/* ---------------- event wiring ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  // settings form prefill
  document.getElementById('sClientId').value = settings.clientId || '';
  document.getElementById('sSheetId').value = settings.sheetId || '';
  if(settings.clientId && settings.sheetId){
    document.getElementById('settingsStatus').textContent = 'Settings saved.';
  }

  renderInventoryList();
  renderReservedList();
  updateCodePreview();

  // nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.target));
  });

  // sign in
  document.getElementById('authBtn').addEventListener('click', async () => {
    const ok = await ensureAuth();
    if(ok){ await flushQueue(); await refreshInventory(); }
  });

  // sign out (separate, confirmed — so a stray tap can't sign you out)
  document.getElementById('signOutBtn').addEventListener('click', () => {
    if(!accessToken) return;
    if(!confirm('Sign out of Google? Anything not yet synced stays saved on this device.')) return;
    google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null;
    setAuthUI(false);
    toast('Signed out');
  });

  // settings form
  document.getElementById('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    settings.clientId = document.getElementById('sClientId').value.trim();
    settings.sheetId  = document.getElementById('sSheetId').value.trim();
    saveSettings();
    accessToken = null;
    setAuthUI(false);
    initGoogleAuth();
    document.getElementById('settingsStatus').textContent = 'Saved. Sign in to sync.';
    toast('Settings saved');
  });

  // category change -> code preview
  document.getElementById('fCategory').addEventListener('change', updateCodePreview);

  // photo inputs — each append to whatever's already attached, so you can take
  // several shots in a row (and mix in library/Drive photos) before saving.
  function addPickedPhotos(e){
    pendingPhotos = pendingPhotos.concat(Array.from(e.target.files || []));
    renderPhotoThumbs();
    e.target.value = '';
  }
  document.getElementById('fCamera').addEventListener('change', addPickedPhotos);
  document.getElementById('fPhotos').addEventListener('change', addPickedPhotos);
  document.getElementById('takePhotoBtn').addEventListener('click', () => document.getElementById('fCamera').click());
  document.getElementById('choosePhotoBtn').addEventListener('click', () => document.getElementById('fPhotos').click());

  // Drive picker
  document.getElementById('loadFromDriveBtn').addEventListener('click', openDriveModal);
  document.getElementById('driveModalCancel').addEventListener('click', closeDriveModal);
  document.getElementById('driveModalAdd').addEventListener('click', addSelectedDrivePhotos);

  // AI assist
  document.getElementById('aiCategoryBtn').addEventListener('click', runCategoryGuess);
  document.getElementById('aiDimensionsBtn').addEventListener('click', runDimensionRead);

  // intake submit
  document.getElementById('intakeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const category = document.getElementById('fCategory').value;
    const code = nextCode(category);
    const item = {
      itemCode: code,
      category,
      description: document.getElementById('fDescription').value.trim(),
      dimensions: document.getElementById('fDimensions').value.trim(),
      dateAdded: todayISO(),
      status: 'Available',
      reservedBy: '', reservedContact: '', reservedDate: '',
      notes: document.getElementById('fNotes').value.trim(),
      qty: document.getElementById('fQty').value.trim() || '1',
      condition: document.getElementById('fCondition').value
    };
    items.unshift(item);
    saveCache();
    queueUpsert(item);
    renderInventoryList();
    renderReservedList();

    const photosForUpload = pendingPhotos;

    currentResultCode = code;
    document.getElementById('resultCode').textContent = code;
    document.getElementById('captionStacked').textContent = buildStackedCaption(item);
    document.getElementById('captionLine').textContent = buildLineCaption(item);
    document.getElementById('intakeResult').hidden = false;
    document.getElementById('downloadPhotosBtn').dataset.code = code;
    document.getElementById('downloadPhotosBtn')._photos = photosForUpload;

    const photoStatus = document.getElementById('photoSaveStatus');
    photoStatus.textContent = '';

    e.target.reset();
    document.getElementById('fQty').value = '1';
    document.getElementById('photoThumbs').innerHTML = '';
    document.getElementById('photoCount').textContent = 'No photos yet';
    document.getElementById('aiStatus').textContent = '';
    pendingPhotos = [];
    updateCodePreview();

    if(accessToken && photosForUpload.length){
      toast('Saved — uploading photos to Drive…');
      uploadPhotosToDrive(code, photosForUpload).then(({ok, fail}) => {
        if(ok) photoStatus.textContent = `${ok} photo${ok===1?'':'s'} saved to Google Drive${fail?`, ${fail} failed`:''}.`;
        else if(fail) photoStatus.textContent = `Could not save photos to Drive (${fail} failed) — use "Download renamed photos" instead.`;
        toast(ok ? `${ok} photo${ok===1?'':'s'} saved to Drive${fail?`, ${fail} failed`:''}` : `Drive upload failed for ${fail} photo${fail===1?'':'s'}`);
      });
    } else {
      if(photosForUpload.length) photoStatus.textContent = 'Sign in to auto-save photos to Google Drive, or download them below.';
      toast(accessToken ? 'Saved and syncing…' : 'Saved locally — sign in to sync');
    }
  });

  // copy buttons (captions)
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.copy);
      copyText(target.textContent);
    });
  });

  // download photos
  document.getElementById('downloadPhotosBtn').addEventListener('click', (e) => {
    const code = e.target.dataset.code;
    const files = e.target._photos || [];
    downloadRenamedPhotos(code, files);
  });

  // inventory filters
  document.getElementById('invSearch').addEventListener('input', renderInventoryList);
  document.getElementById('invStatusFilter').addEventListener('change', renderInventoryList);
  document.getElementById('refreshInventory').addEventListener('click', refreshInventory);

  // delegated actions on tag cards
  document.getElementById('app').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if(!btn) return;
    const code = btn.dataset.code;
    const action = btn.dataset.action;
    const item = items.find(i => i.itemCode === code);
    if(!item) return;

    if(action === 'reserve') openReserveModal(item);
    if(action === 'claim')   setStatus(item, 'Claimed');
    if(action === 'remove')  setStatus(item, 'Removed');
    if(action === 'release') { item.status='Available'; item.reservedBy=''; item.reservedContact=''; item.reservedDate=''; persistItem(item); }
    if(action === 'email')   openEmailModal(item);
  });

  // reserve modal
  document.getElementById('reserveModalCancel').addEventListener('click', closeReserveModal);
  document.getElementById('reserveForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = document.getElementById('reserveModalCode').dataset.code;
    const item = items.find(i => i.itemCode === code);
    item.status = 'Reserved';
    item.reservedBy = document.getElementById('rName').value.trim();
    item.reservedContact = document.getElementById('rContact').value.trim();
    item.reservedDate = nowISO();
    persistItem(item);
    closeReserveModal();
    openEmailModal(item);
  });

  // email modal
  document.getElementById('emailModalClose').addEventListener('click', closeEmailModal);
  document.getElementById('emailModalCopy').addEventListener('click', () => {
    copyText(document.getElementById('emailText').textContent);
  });

  // kick off
  window.addEventListener('load', () => {
    setTimeout(initGoogleAuth, 300); // give the GIS script a moment to attach
  });
});

function updateCodePreview(){
  const category = document.getElementById('fCategory').value;
  document.getElementById('codePreview').textContent = nextCode(category);
}

function persistItem(item){
  saveCache();
  queueUpsert(item);
  renderInventoryList();
  renderReservedList();
}
function setStatus(item, status){
  item.status = status;
  persistItem(item);
  toast(`${item.itemCode} marked ${status}`);
}

function openReserveModal(item){
  document.getElementById('reserveModalCode').textContent = `${item.itemCode} — ${item.description}`;
  document.getElementById('reserveModalCode').dataset.code = item.itemCode;
  document.getElementById('rName').value = '';
  document.getElementById('rContact').value = '';
  document.getElementById('reserveModalBackdrop').hidden = false;
}
function closeReserveModal(){ document.getElementById('reserveModalBackdrop').hidden = true; }

function openEmailModal(item){
  document.getElementById('emailText').textContent = buildEmailText(item);
  document.getElementById('emailModalBackdrop').hidden = false;
}
function closeEmailModal(){ document.getElementById('emailModalBackdrop').hidden = true; }

function copyText(text){
  navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    () => toast('Could not copy — select and copy manually')
  );
}
