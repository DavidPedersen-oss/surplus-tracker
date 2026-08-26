/* ---------------------------------------------------------------
   Surplus Tracker — standalone static app
   Data lives in a Google Sheet the user owns; auth is client-side
   OAuth via Google Identity Services (no backend, no secrets).
--------------------------------------------------------------- */

const SETTINGS_KEY = 'surplusTracker.settings';
const CACHE_KEY    = 'surplusTracker.itemsCache';
const QUEUE_KEY     = 'surplusTracker.queue';
const WISH_CACHE_KEY = 'surplusTracker.wishCache';
const WISH_QUEUE_KEY = 'surplusTracker.wishQueue';
const TOKEN_KEY      = 'surplusTracker.token';

const SHEET_NAME    = 'Inventory';
const SHEET_RANGE   = 'Inventory!A:L';
const COLUMNS       = ['ItemCode','Category','Description','Dimensions','DateAdded','Status','ReservedBy','ReservedContact','ReservedDate','Notes','Qty','Condition'];
// Wishlist lives in its own tab of the same spreadsheet; the app adds the tab
// (with these headers) the first time it syncs, so there's nothing to set up.
const WISH_SHEET    = 'Wishlist';
const WISH_RANGE    = 'Wishlist!A:L';
const WISH_COLUMNS  = ['RequestCode','Department','RequestedBy','Contact','Category','Item','Qty','Notes','DateRequested','Status','FilledWith','FilledDate'];
const CATEGORY_LABELS = { B:'Bookshelf / Cabinet', T:'Table / Desk', C:'Chair', M:'Miscellaneous' };
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'Surplus Tracker Photos';

// Baked-in config (config.js) wins for shared fields, but localStorage can
// still override locally for testing without editing/redeploying config.js.
let settings = Object.assign({}, window.APP_CONFIG || {}, loadSettings());
let items = loadCache();          // array of item objects, newest-appended-last as stored, we sort for display
let queue = loadQueue();          // { [itemCode]: itemObject }
let wishes = loadWishCache();     // array of wishlist request objects
let wishQueue = loadWishQueue();  // { [requestCode]: wishObject }
let tokenClient = null;
let accessToken = null;
let pendingPhotos = [];           // File[]/Blob[] attached in the current intake form (camera or Drive)
let currentResultCode = null;
let driveResults = [];            // cached list of recent Drive photos
let driveSelected = new Set();    // ids selected in the Drive picker
let driveThumbs = {};             // itemCode -> {id, url}, for inventory card previews and the lightbox
let editingCode = null;           // itemCode currently open in the Edit modal
let editPendingPhotos = [];       // new photos (not yet uploaded) attached in the Edit modal
let suppressNextCardClick = false; // swallows the synthetic click a long-press leaves behind

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
function loadWishCache(){
  try { return JSON.parse(localStorage.getItem(WISH_CACHE_KEY)) || []; } catch { return []; }
}
function saveWishCache(){ localStorage.setItem(WISH_CACHE_KEY, JSON.stringify(wishes)); }
function loadWishQueue(){
  try { return JSON.parse(localStorage.getItem(WISH_QUEUE_KEY)) || {}; } catch { return {}; }
}
function saveWishQueue(){ localStorage.setItem(WISH_QUEUE_KEY, JSON.stringify(wishQueue)); }

/* ---------------- access token ----------------
   Google's browser sign-in hands back a token that's good for about an hour and
   can't be refreshed offline. Keeping it only in memory meant every page load
   started signed out — and mobile browsers reload the page when you come back
   from the camera, so a normal "photo, photo, save" round trip asked you to sign
   in again. Persisting it means one sign-in per hour of use instead of one per
   page load. It's a short-lived, narrowly-scoped token (this sheet + files this
   app created), it's cleared on sign-out, and it was already readable by any
   script on the page while in memory.
------------------------------------------------ */
function loadStoredToken(){
  try{
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    // Treat a nearly-expired token as already gone, so we don't start a
    // multi-step sync that dies partway through.
    if(t && t.token && t.expiresAt && t.expiresAt - Date.now() > 120000) return t;
  } catch {}
  return null;
}
function storeToken(token, expiresInSec){
  accessToken = token;
  try{
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      token,
      expiresAt: Date.now() + (Number(expiresInSec) || 3600) * 1000
    }));
  } catch {}
}
function clearStoredToken(){
  accessToken = null;
  try{ localStorage.removeItem(TOKEN_KEY); } catch {}
}

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
// A date-only value (YYYY-MM-DD, what DateAdded/DateRequested store) parses as
// UTC midnight, which then reads as the previous day anywhere west of Greenwich —
// so treat those as local dates. Full timestamps are already unambiguous.
function parseStoredDate(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : new Date(iso);
}
function formatDate(iso){
  if(!iso) return '—';
  const d = parseStoredDate(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
function daysSince(iso){
  if(!iso) return 0;
  const then = parseStoredDate(iso).getTime();
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
      storeToken(resp.access_token, resp.expires_in);
      setAuthUI(true);
      toast('Signed in');
      flushQueue().then(flushWishQueue).then(refreshInventory);
    },
    // Fires for non-OAuth failures — most usefully, a popup the browser blocked
    // because there was no user gesture behind it. Without this, a silent
    // refresh that can't stay silent just hangs until the timeout below.
    error_callback: (err) => {
      if(typeof pendingSilentFail === 'function'){ pendingSilentFail(err); return; }
      console.error('sign-in error', err);
    }
  });
}
let pendingSilentFail = null;

// Ask Google for a fresh token without showing anything. Works when consent is
// already granted and the Google session is still live; fails fast otherwise
// (blocked third-party cookies will do it), so every caller needs a fallback.
// The timeout is the safety net for the case where GIS simply goes quiet.
function requestTokenSilently(){
  return new Promise((resolve) => {
    if(!tokenClient){ resolve(false); return; }
    const orig = tokenClient.callback;
    let settled = false;
    const finish = (ok) => {
      if(settled) return;
      settled = true;
      tokenClient.callback = orig;
      pendingSilentFail = null;
      resolve(ok);
    };
    tokenClient.callback = (resp) => {
      if(resp.error || !resp.access_token){ finish(false); return; }
      storeToken(resp.access_token, resp.expires_in);
      setAuthUI(true);
      finish(true);
    };
    // A blocked popup means it couldn't stay silent — give up now, don't stall.
    pendingSilentFail = () => finish(false);
    setTimeout(() => finish(false), 8000);
    try { tokenClient.requestAccessToken({ prompt: '' }); }
    catch(e){ console.error('silent token refresh failed', e); finish(false); }
  });
}

// Every authenticated request goes through here, so a token that quietly expired
// mid-session refreshes and retries once instead of surfacing as an unexplained
// "sync failed". Pass contentType:null for plain GETs that shouldn't declare one.
async function authedFetch(url, options={}, contentType='application/json'){
  const send = () => fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
      ...(options.headers || {})
    }
  });
  let res = await send();
  if(res.status === 401){
    clearStoredToken();
    if(await requestTokenSilently()) res = await send();
    else setAuthUI(false); // be honest about it rather than failing silently
  }
  return res;
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
      storeToken(resp.access_token, resp.expires_in);
      setAuthUI(true);
      resolve(true);
    };
    tokenClient.requestAccessToken();
  });
}

/* ---------------- Sheets API ---------------- */
async function sheetsFetch(path, options={}){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${settings.sheetId}${path}`;
  const res = await authedFetch(url, options);
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

function colLetter(n){ return String.fromCharCode('A'.charCodeAt(0) + n - 1); } // 12 -> 'L'

async function findSheetRowByCode(code, sheetName = SHEET_NAME){
  const data = await sheetsFetch(`/values/${encodeURIComponent(sheetName + '!A:A')}`);
  const rows = data.values || [];
  for(let i=1;i<rows.length;i++){
    if(rows[i][0] === code) return i+1; // 1-based row number
  }
  return null;
}

// Write one object to its row in a tab, matching on the code in column A, or
// append it if that code isn't there yet. Shared by Inventory and Wishlist.
async function upsertRowToSheet(sheetName, columns, obj, keyField){
  const row = columns.map(c => obj[camel(c)] || '');
  const lastCol = colLetter(columns.length);
  const existingRow = await findSheetRowByCode(obj[keyField], sheetName);
  if(existingRow){
    const range = `${sheetName}!A${existingRow}:${lastCol}${existingRow}`;
    await sheetsFetch(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method:'PUT',
      body: JSON.stringify({ range, values:[row] })
    });
  } else {
    const range = `${sheetName}!A:${lastCol}`;
    await sheetsFetch(`/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method:'POST',
      body: JSON.stringify({ values:[row] })
    });
  }
}

function upsertItemToSheet(item){
  return upsertRowToSheet(SHEET_NAME, COLUMNS, item, 'itemCode');
}

/* ---------------- Google Drive ---------------- */
async function driveFetch(path, options={}){
  const res = await authedFetch(`https://www.googleapis.com/drive/v3${path}`, options);
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
  const res = await authedFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method:'POST', body },
    `multipart/related; boundary=${boundary}`
  );
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

async function listAllDriveFiles(folderId){
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('nextPageToken, files(id,name,thumbnailLink)');
  let files = [];
  let pageToken = '';
  do{
    const data = await driveFetch(`/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`);
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken || '';
  } while(pageToken);
  return files;
}

// Drive's thumbnailLink defaults to a small ~220px preview (fine for the old
// 52px thumb, blurry stretched across a large brick tile) — it supports a
// size parameter in the URL itself, so ask for a much bigger render instead.
function upsizeThumbnail(url, size){
  return url ? url.replace(/=s\d+.*$/, `=s${size}`) : url;
}

// Picks the lowest-numbered photo (CODE_1, CODE_2, ...) per item code as its
// inventory-card thumbnail.
function ingestDriveThumbs(files){
  const bestIdx = {};
  files.forEach(f => {
    const m = /^([A-Za-z]\d+)_(\d+)\./.exec(f.name);
    if(!m || !f.thumbnailLink) return;
    const code = m[1], idx = parseInt(m[2],10);
    if(bestIdx[code] === undefined || idx < bestIdx[code]){
      bestIdx[code] = idx;
      driveThumbs[code] = { id: f.id, url: upsizeThumbnail(f.thumbnailLink, 1200) };
    }
  });
}
async function countDrivePhotosForCode(code){
  if(!accessToken) return null;
  try{
    const folderId = await ensureDriveFolder();
    const q = encodeURIComponent(`'${folderId}' in parents and name contains '${code}_' and trashed = false`);
    const data = await driveFetch(`/files?q=${q}&fields=files(id)&pageSize=100`);
    return (data.files || []).length;
  } catch(e){
    console.error('photo count failed for', code, e);
    return null;
  }
}
async function refreshDriveThumbs(){
  if(!accessToken) return;
  try{
    const folderId = await ensureDriveFolder();
    ingestDriveThumbs(await listAllDriveFiles(folderId));
  } catch(e){
    console.error('drive thumbnail refresh failed', e);
  }
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
  const res = await authedFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {}, null);
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
    let l, h, d;
    if(result && (result.length || result.height || result.depth)){
      l = result.length; h = result.height; d = result.depth;
    } else if(result && result.dimensions){
      // Older Cloud Function still deployed and returning a pre-formatted string —
      // parse it back into the 3 fields as a best effort.
      const parsed = parseDimensionString(result.dimensions);
      l = parsed.l; h = parsed.h; d = parsed.d;
    }
    if(l || h || d){
      if(l) document.getElementById('fDimL').value = l;
      if(h) document.getElementById('fDimH').value = h;
      if(d) document.getElementById('fDimD').value = d;
      updateDimsPreview();
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
  await refreshWishlist({ silent:true });
  try{
    const remote = await sheetsGetAllRows();
    // merge: queued local edits win over remote until they sync
    const queued = Object.values(queue);
    const map = new Map(remote.map(i => [i.itemCode, i]));
    queued.forEach(i => map.set(i.itemCode, i));
    items = Array.from(map.values());
    saveCache();
    await refreshDriveThumbs();
    renderInventoryList();
    renderReservedList();
    renderWishlist(); // matches depend on what's available
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

/* ---------------- dimensions (3 fields -> one formatted string) ---------------- */
// Storage/captions still use a single formatted string (e.g. 42"L x 28"H x 23.5"D)
// so the Sheet's existing Dimensions column and old rows don't need to change.
function formatDimensions(l,h,d){
  const parts = [];
  if(l !== '' && l != null && !isNaN(l)) parts.push(`${trimNum(l)}"L`);
  if(h !== '' && h != null && !isNaN(h)) parts.push(`${trimNum(h)}"H`);
  if(d !== '' && d != null && !isNaN(d)) parts.push(`${trimNum(d)}"D`);
  return parts.join(' x ');
}
function trimNum(n){ return String(parseFloat(n)); }
function currentDimensionsString(){
  return formatDimensions(
    document.getElementById('fDimL').value,
    document.getElementById('fDimH').value,
    document.getElementById('fDimD').value
  );
}
function updateDimsPreview(){
  document.getElementById('dimsPreview').textContent = currentDimensionsString() || 'No dimensions yet';
}
// Best-effort fallback for parsing a pre-formatted dimensions string (older Cloud
// Function deployments, or hand-typed values) back into L/H/D numbers.
function parseDimensionString(str){
  const out = {};
  const re = /(\d+(?:\.\d+)?)\s*"?\s*([LWHD])/gi;
  let m;
  while((m = re.exec(str || ''))){
    const letter = m[2].toUpperCase();
    if(letter === 'L') out.l = m[1];
    else if(letter === 'H') out.h = m[1];
    else if(letter === 'D') out.d = m[1];
    else if(letter === 'W' && !out.h) out.h = m[1]; // legacy "W" reads as H when no H is present
  }
  return out;
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
function buildSharePointBlock(item){
  return [
    `| Qty: ${item.qty || 1} |`,
    `| Condition: ${item.condition || ''} |`,
    `| Dimensions: ${item.dimensions || ''} |`,
    `| Item Code: ${item.itemCode} |`
  ].join('\n');
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

/* ---------------- full inventory export (data + photos, all in one zip) ---------------- */
function sanitizeFolderName(name){
  return (name || 'item').replace(/[\\/:*?"<>|]/g,'-').trim().slice(0,80) || 'item';
}
function toCSV(columns, rows){
  const esc = v => {
    const s = String(v==null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  return [columns, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
}
function itemsToCSV(list){ return toCSV(COLUMNS, list.map(itemToRow)); }
function wishesToCSV(list){ return toCSV(WISH_COLUMNS, list.map(wishToRow)); }
function buildExportDetails(item){
  const lines = [buildStackedCaption(item), '', buildSharePointBlock(item)];
  if(item.notes) lines.push('', `Notes: ${item.notes}`);
  return lines.join('\n');
}
async function exportInventoryZip(){
  if(!items.length){ toast('Nothing to export yet'); return; }
  if(typeof JSZip === 'undefined'){ toast('Zip library failed to load — check connection'); return; }
  const btn = document.getElementById('exportZipBtn');
  btn.disabled = true;
  toast('Building export…');
  try{
    const zip = new JSZip();
    zip.file('inventory.csv', itemsToCSV(items));
    if(wishes.length) zip.file('wishlist.csv', wishesToCSV(wishes));

    let driveFiles = [];
    if(await ensureAuth()){
      try{
        const folderId = await ensureDriveFolder();
        driveFiles = await listAllDriveFiles(folderId);
      } catch(e){
        console.error(e);
        toast('Could not reach Drive for photos — exporting data only');
      }
    }

    let photoCount = 0;
    for(const item of items){
      const folder = zip.folder(sanitizeFolderName(`${item.itemCode} - ${item.description || ''}`));
      folder.file('details.txt', buildExportDetails(item));
      const matches = driveFiles.filter(f => f.name.startsWith(`${item.itemCode}_`));
      for(const f of matches){
        try{
          // A big export can outlive the token — authedFetch renews it mid-run
          // rather than quietly dropping the rest of the photos.
          const res = await authedFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, {}, null);
          if(res.ok){ folder.file(f.name, await res.blob()); photoCount++; }
        } catch(e){ console.error('export photo failed', f.name, e); }
      }
    }

    const blob = await zip.generateAsync({type:'blob'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `surplus-inventory-${todayISO()}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${items.length} item${items.length===1?'':'s'}, ${photoCount} photo${photoCount===1?'':'s'}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- rendering ---------------- */
function tagCardHTML(item){
  const statusClass = 'status-' + item.status.toLowerCase();
  let ageBadge = '';
  if(item.status === 'Reserved' && item.reservedDate){
    const d = daysSince(item.reservedDate);
    ageBadge = `<span class="age-badge ${ageClass(d)}">${d}d reserved</span>`;
  }
  const wanted = item.status === 'Available' ? wishesWantingItem(item) : [];
  const actions = [];
  if(item.status === 'Available'){
    actions.push(`<button data-action="reserve" data-code="${item.itemCode}" class="primary-action">Reserve</button>`);
  }
  if(wanted.length){
    actions.push(`<button data-action="fillwish" data-code="${item.itemCode}">Fill a request</button>`);
  }
  if(item.status === 'Reserved'){
    actions.push(`<button data-action="email" data-code="${item.itemCode}">Confirmation text</button>`);
    actions.push(`<button data-action="claim" data-code="${item.itemCode}" class="primary-action">Mark claimed</button>`);
    actions.push(`<button data-action="release" data-code="${item.itemCode}">Release</button>`);
  }
  if(item.status === 'Claimed' || item.status === 'Available'){
    actions.push(`<button data-action="remove" data-code="${item.itemCode}">Mark removed</button>`);
  }
  actions.push(`<button data-action="sharepoint" data-code="${item.itemCode}">SharePoint text</button>`);
  actions.push(`<button data-action="edit" data-code="${item.itemCode}">Edit</button>`);
  const meta = item.status === 'Reserved'
    ? `${item.reservedBy || 'Unknown'} · reserved ${formatDate(item.reservedDate)}`
    : `Added ${formatDate(item.dateAdded)}`;
  const wantedBadge = wanted.length
    ? `<span class="wanted-badge" title="${escapeHTML(wanted.map(w => w.department).join(', '))}">★ wanted by ${escapeHTML(wanted[0].department)}${wanted.length > 1 ? ` +${wanted.length - 1}` : ''}</span>`
    : '';
  const thumbUrl = driveThumbs[item.itemCode] && driveThumbs[item.itemCode].url;
  const thumbHTML = thumbUrl
    ? `<img class="tag-card-photo" src="${thumbUrl}" alt="" loading="lazy">`
    : `<div class="tag-card-photo tag-card-photo-empty">${escapeHTML(item.category || '')}</div>`;
  const miniThumbHTML = thumbUrl
    ? `<img class="tag-card-mini-thumb" src="${thumbUrl}" alt="" loading="lazy">`
    : `<div class="tag-card-mini-thumb tag-card-mini-thumb-empty">${escapeHTML(item.category || '')}</div>`;

  return `
  <div class="tag-card" data-code="${item.itemCode}">
    <div class="tag-card-inner">
      <div class="tag-card-front tag-card-face">
        <div class="tag-card-code-label">${item.itemCode}</div>
        <div class="tag-card-photo-trigger">${thumbHTML}</div>
      </div>
      <div class="tag-card-back tag-card-face">
        <div class="tag-card-headline">
          <div>
            <div class="tag-card-code">${item.itemCode}</div>
            <div class="tag-card-desc">${escapeHTML(item.description)}</div>
          </div>
          <span class="status-stamp ${statusClass}">${item.status}</span>
        </div>
        <div class="tag-card-back-body">
          ${miniThumbHTML}
          <pre class="tag-card-sp-block">${escapeHTML(buildSharePointBlock(item))}</pre>
        </div>
        <div class="tag-card-meta">${meta} ${ageBadge} ${wantedBadge}</div>
        <div class="tag-card-actions">${actions.join('')}</div>
      </div>
    </div>
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
  wireWishlist();

  // nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.target));
  });

  // sign in
  document.getElementById('authBtn').addEventListener('click', async () => {
    const ok = await ensureAuth();
    if(ok){ await flushQueue(); await flushWishQueue(); await refreshInventory(); }
  });

  // sign out (separate, confirmed — so a stray tap can't sign you out)
  document.getElementById('signOutBtn').addEventListener('click', () => {
    if(!accessToken) return;
    if(!confirm('Sign out of Google? Anything not yet synced stays saved on this device.')) return;
    google.accounts.oauth2.revoke(accessToken, () => {});
    clearStoredToken();
    setAuthUI(false);
    toast('Signed out');
  });

  // settings form
  document.getElementById('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    settings.clientId = document.getElementById('sClientId').value.trim();
    settings.sheetId  = document.getElementById('sSheetId').value.trim();
    saveSettings();
    clearStoredToken(); // a token issued for the old client ID is no use here
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
    const input = e.target;
    const files = Array.from(input.files || []);
    if(files.length){
      pendingPhotos = pendingPhotos.concat(files);
      renderPhotoThumbs();
    }
    input.value = '';
    // Reopen the camera right away so the next shot doesn't need a fresh tap —
    // cancelling out of the camera (instead of shooting again) just stops the loop.
    if(input.id === 'fCamera' && files.length){
      input.click();
    }
  }
  document.getElementById('fCamera').addEventListener('change', addPickedPhotos);
  document.getElementById('fPhotos').addEventListener('change', addPickedPhotos);
  document.getElementById('takePhotoBtn').addEventListener('click', () => document.getElementById('fCamera').click());
  document.getElementById('choosePhotoBtn').addEventListener('click', () => document.getElementById('fPhotos').click());

  // edit modal photo inputs — same continuous-camera behavior as intake
  function addEditPickedPhotos(e){
    const input = e.target;
    const files = Array.from(input.files || []);
    if(files.length){
      editPendingPhotos = editPendingPhotos.concat(files);
      renderEditPhotoThumbs();
    }
    input.value = '';
    if(input.id === 'eCamera' && files.length){
      input.click();
    }
  }
  document.getElementById('eCamera').addEventListener('change', addEditPickedPhotos);
  document.getElementById('ePhotos').addEventListener('change', addEditPickedPhotos);
  document.getElementById('eTakePhotoBtn').addEventListener('click', () => document.getElementById('eCamera').click());
  document.getElementById('eChoosePhotoBtn').addEventListener('click', () => document.getElementById('ePhotos').click());
  ['eDimL','eDimH','eDimD'].forEach(id => document.getElementById(id).addEventListener('input', updateEditDimsPreview));

  document.getElementById('editModalCancel').addEventListener('click', closeEditModal);
  document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = items.find(i => i.itemCode === editingCode);
    if(!item) return;

    item.description = document.getElementById('eDescription').value.trim();
    item.dimensions = formatDimensions(
      document.getElementById('eDimL').value,
      document.getElementById('eDimH').value,
      document.getElementById('eDimD').value
    );
    item.qty = document.getElementById('eQty').value.trim() || '1';
    item.condition = document.getElementById('eCondition').value;
    item.notes = document.getElementById('eNotes').value.trim();
    persistItem(item);

    const code = item.itemCode;
    const newPhotos = editPendingPhotos;
    closeEditModal();
    toast('Item updated');

    if(newPhotos.length){
      if(!accessToken){
        toast('Sign in to upload the new photos to Drive');
      } else {
        toast('Uploading new photos…');
        const startIdx = (await countDrivePhotosForCode(code)) || 0;
        const folderId = await ensureDriveFolder();
        let ok = 0, fail = 0;
        for(let i=0;i<newPhotos.length;i++){
          const name = `${code}_${startIdx+i+1}.${extOf(newPhotos[i].name)}`;
          try{ await uploadPhotoToDrive(newPhotos[i], name, folderId); ok++; }
          catch(err){ console.error('edit photo upload failed', name, err); fail++; }
        }
        toast(ok ? `${ok} photo${ok===1?'':'s'} added${fail?`, ${fail} failed`:''}` : `Failed to upload ${fail} photo${fail===1?'':'s'}`);
        if(ok){
          delete driveThumbs[code];
          await refreshDriveThumbs();
          renderInventoryList();
          renderReservedList();
        }
      }
    }
  });

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
      dimensions: currentDimensionsString(),
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
    renderWishlist();

    const photosForUpload = pendingPhotos;

    currentResultCode = code;
    document.getElementById('resultCode').textContent = code;
    document.getElementById('captionStacked').textContent = buildStackedCaption(item);
    document.getElementById('captionLine').textContent = buildLineCaption(item);
    document.getElementById('captionSharePoint').textContent = buildSharePointBlock(item);
    document.getElementById('intakeResult').hidden = false;
    showIntakeWishAlert(item);
    document.getElementById('downloadPhotosBtn').dataset.code = code;
    document.getElementById('downloadPhotosBtn')._photos = photosForUpload;

    const photoStatus = document.getElementById('photoSaveStatus');
    photoStatus.textContent = '';

    e.target.reset();
    document.getElementById('fQty').value = '1';
    updateDimsPreview();
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
        if(ok) refreshDriveThumbs().then(() => { renderInventoryList(); renderReservedList(); });
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
    if(suppressNextCardClick){ suppressNextCardClick = false; return; }

    const wbtn = e.target.closest('button[data-waction]');
    if(wbtn){
      handleWishAction(wbtn.dataset.waction, wbtn.dataset.wcode, wbtn.dataset.code);
      return;
    }

    const btn = e.target.closest('button[data-action]');
    if(btn){
      const code = btn.dataset.code;
      const action = btn.dataset.action;
      const item = items.find(i => i.itemCode === code);
      if(!item) return;

      if(action === 'reserve') openReserveModal(item);
      if(action === 'claim')   setStatus(item, 'Claimed');
      if(action === 'remove')  setStatus(item, 'Removed');
      if(action === 'release') { item.status='Available'; item.reservedBy=''; item.reservedContact=''; item.reservedDate=''; persistItem(item); }
      if(action === 'email')   openEmailModal(item);
      if(action === 'sharepoint') openSharePointModal(item);
      if(action === 'edit')    openEditModal(item);
      if(action === 'fillwish'){
        // Straight from the item to the request it can close out.
        const want = wishesWantingItem(item);
        if(!want.length){ toast('No open request matches this any more'); return; }
        activateTab('wishlist');
        openWishFillModal(want[0]);
        document.getElementById('wishFillCodeInput').value = item.itemCode;
      }
      return;
    }

    // a tap/click anywhere else on a tag card flips it between photo and details
    const card = e.target.closest('.tag-card');
    if(card) card.classList.toggle('is-flipped');
  });

  function openLightboxForCard(card){
    const item = items.find(i => i.itemCode === card.dataset.code);
    if(!item) return;
    if(driveThumbs[item.itemCode]) openLightbox(item);
    else toast('No photo saved for this item yet');
  }

  // Hovering already flips a card to its back before a click can land, so a
  // plain click can't reliably hit the photo to open the lightbox — use a
  // double-click (desktop/mouse) and a press-and-hold (touch) instead.
  document.getElementById('app').addEventListener('dblclick', (e) => {
    if(e.target.closest('button[data-action]')) return;
    const card = e.target.closest('.tag-card');
    if(card) openLightboxForCard(card);
  });

  let longPressTimer = null;
  document.getElementById('app').addEventListener('touchstart', (e) => {
    const card = e.target.closest('.tag-card');
    if(!card || e.target.closest('button[data-action]')) return;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      suppressNextCardClick = true; // the browser fires a synthetic click after touchend
      openLightboxForCard(card);
    }, 550);
  }, { passive: true });
  ['touchend','touchmove','touchcancel'].forEach(evt => {
    document.getElementById('app').addEventListener(evt, () => {
      if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer = null; }
    }, { passive: true });
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

  // SharePoint block modal
  document.getElementById('sharePointModalClose').addEventListener('click', closeSharePointModal);
  document.getElementById('sharePointModalCopy').addEventListener('click', () => {
    copyText(document.getElementById('sharePointModalText').textContent);
  });

  // photo lightbox
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxBackdrop').addEventListener('click', (e) => {
    if(e.target.id === 'lightboxBackdrop') closeLightbox();
  });

  // dimensions preview
  ['fDimL','fDimH','fDimD'].forEach(id => document.getElementById(id).addEventListener('input', updateDimsPreview));

  // export everything to zip
  document.getElementById('exportZipBtn').addEventListener('click', exportInventoryZip);

  // sign-in prompt (shown on load if not already signed in — saving/uploading
  // needs it, and the OAuth popup only opens reliably from a real click)
  document.getElementById('signInModalDismiss').addEventListener('click', closeSignInModal);
  document.getElementById('signInModalConfirm').addEventListener('click', async () => {
    closeSignInModal();
    const ok = await ensureAuth();
    if(ok){ await flushQueue(); await flushWishQueue(); await refreshInventory(); }
  });

  // kick off
  window.addEventListener('load', () => {
    setTimeout(() => { initGoogleAuth(); resumeSession(); }, 300); // give the GIS script a moment to attach
  });
});

// Pick up where the last load left off. A still-valid stored token means no
// sign-in at all — which is the whole point, since coming back from the camera
// counts as a fresh load on most phones.
function resumeSession(){
  const stored = loadStoredToken();
  if(stored){
    accessToken = stored.token;
    setAuthUI(true);
    flushQueue().then(flushWishQueue).then(refreshInventory);
    return;
  }
  maybePromptSignIn();
}

function maybePromptSignIn(){
  if(accessToken || !settings.clientId) return;
  document.getElementById('signInModalBackdrop').hidden = false;
}
function closeSignInModal(){ document.getElementById('signInModalBackdrop').hidden = true; }

function updateCodePreview(){
  const category = document.getElementById('fCategory').value;
  document.getElementById('codePreview').textContent = nextCode(category);
}

function persistItem(item){
  saveCache();
  queueUpsert(item);
  renderInventoryList();
  renderReservedList();
  renderWishlist(); // an item changing status changes which requests it can fill
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

function openEditModal(item){
  editingCode = item.itemCode;
  editPendingPhotos = [];
  document.getElementById('editModalCode').textContent = `${item.itemCode} — ${CATEGORY_LABELS[item.category] || item.category}`;
  document.getElementById('eDescription').value = item.description || '';
  const parsed = parseDimensionString(item.dimensions);
  document.getElementById('eDimL').value = parsed.l || '';
  document.getElementById('eDimH').value = parsed.h || '';
  document.getElementById('eDimD').value = parsed.d || '';
  updateEditDimsPreview();
  document.getElementById('eQty').value = item.qty || '1';
  document.getElementById('eCondition').value = item.condition || 'Good';
  document.getElementById('eNotes').value = item.notes || '';
  renderEditPhotoThumbs();

  const statusEl = document.getElementById('ePhotoStatus');
  statusEl.textContent = accessToken ? 'Checking existing photos…' : 'Sign in to see or add Drive photos for this item.';
  document.getElementById('editModalBackdrop').hidden = false;
  if(accessToken){
    countDrivePhotosForCode(item.itemCode).then(n => {
      if(editingCode !== item.itemCode) return; // modal moved on to another item
      statusEl.textContent = n === null
        ? 'Could not check Drive — you can still add photos below.'
        : n > 0 ? `${n} photo${n===1?'':'s'} already saved to Drive — anything added below is appended.`
                : 'No photos saved yet — add some below.';
    });
  }
}
function closeEditModal(){
  document.getElementById('editModalBackdrop').hidden = true;
  editingCode = null;
  editPendingPhotos = [];
}
function updateEditDimsPreview(){
  document.getElementById('eDimsPreview').textContent = formatDimensions(
    document.getElementById('eDimL').value,
    document.getElementById('eDimH').value,
    document.getElementById('eDimD').value
  ) || 'No dimensions yet';
}
function renderEditPhotoThumbs(){
  const thumbs = document.getElementById('ePhotoThumbs');
  thumbs.innerHTML = editPendingPhotos.map((f,i) => `
    <span class="photo-thumb" data-i="${i}">
      <img src="${URL.createObjectURL(f)}" alt="">
      <button type="button" class="photo-thumb-remove" data-i="${i}" aria-label="Remove photo">×</button>
    </span>`).join('');
  thumbs.querySelectorAll('.photo-thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      editPendingPhotos.splice(Number(btn.dataset.i), 1);
      renderEditPhotoThumbs();
    });
  });
}

function openEmailModal(item){
  document.getElementById('emailText').textContent = buildEmailText(item);
  document.getElementById('emailModalBackdrop').hidden = false;
}
function closeEmailModal(){ document.getElementById('emailModalBackdrop').hidden = true; }

function openSharePointModal(item){
  document.getElementById('sharePointModalText').textContent = buildSharePointBlock(item);
  document.getElementById('sharePointModalBackdrop').hidden = false;
}
function closeSharePointModal(){ document.getElementById('sharePointModalBackdrop').hidden = true; }

// Opens with whatever's already cached (fast), then swaps in the actual
// full-resolution file once it downloads — thumbnailLink is capped well
// below a real camera photo's resolution even at its largest size param.
function openLightbox(item){
  const entry = driveThumbs[item.itemCode];
  const img = document.getElementById('lightboxImg');
  img.src = entry ? entry.url : '';
  document.getElementById('lightboxCaption').textContent = buildLineCaption(item);
  document.getElementById('lightboxBackdrop').hidden = false;

  if(accessToken && entry && entry.id){
    authedFetch(`https://www.googleapis.com/drive/v3/files/${entry.id}?alt=media`, {}, null)
      .then(res => res.ok ? res.blob() : null)
      .then(blob => {
        if(blob && !document.getElementById('lightboxBackdrop').hidden){
          img.src = URL.createObjectURL(blob);
        }
      })
      .catch(e => console.error('full-res photo fetch failed', e));
  }
}
function closeLightbox(){
  document.getElementById('lightboxBackdrop').hidden = true;
  document.getElementById('lightboxImg').src = '';
}

function copyText(text){
  navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    () => toast('Could not copy — select and copy manually')
  );
}

/* ================= WISHLIST =================
   Department requests: what people have asked us to look out for, who asked,
   and how long they've been waiting. Lives in its own tab of the same Sheet
   (created on demand), with the same offline queue + local cache as Inventory.
--------------------------------------------- */

/* ---------------- wishlist sheet plumbing ---------------- */
let wishSheetReady = false;
async function ensureWishlistSheet(){
  if(wishSheetReady) return;
  const meta = await sheetsFetch('?fields=sheets.properties.title');
  const exists = (meta.sheets || []).some(s => s.properties && s.properties.title === WISH_SHEET);
  if(!exists){
    try{
      await sheetsFetch(':batchUpdate', {
        method:'POST',
        body: JSON.stringify({ requests:[{ addSheet:{ properties:{ title: WISH_SHEET } } }] })
      });
    } catch(e){
      // Another device may have created the tab between our check and this call.
      const again = await sheetsFetch('?fields=sheets.properties.title');
      if(!(again.sheets || []).some(s => s.properties && s.properties.title === WISH_SHEET)) throw e;
      wishSheetReady = true;
      return;
    }
    const headerRange = `${WISH_SHEET}!A1:${colLetter(WISH_COLUMNS.length)}1`;
    await sheetsFetch(`/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`, {
      method:'PUT',
      body: JSON.stringify({ range: headerRange, values:[WISH_COLUMNS] })
    });
  }
  wishSheetReady = true;
}

function rowToWish(row){
  const o = {};
  WISH_COLUMNS.forEach((c,i) => { o[camel(c)] = row[i] || ''; });
  return o;
}
function wishToRow(wish){ return WISH_COLUMNS.map(c => wish[camel(c)] || ''); }

/* ---------------- wishlist sync ---------------- */
function queueWishUpsert(wish){
  wishQueue[wish.requestCode] = wish;
  saveWishQueue();
  if(accessToken) flushWishQueue();
}
async function flushWishQueue(){
  const codes = Object.keys(wishQueue);
  if(codes.length === 0 || !accessToken) return;
  try{
    await ensureWishlistSheet();
  } catch(e){
    console.error('could not prepare the Wishlist tab', e);
    toast('Could not reach the Wishlist tab — requests stay on this device for now');
    return;
  }
  let ok = 0, fail = 0;
  for(const code of codes){
    try{
      await upsertRowToSheet(WISH_SHEET, WISH_COLUMNS, wishQueue[code], 'requestCode');
      delete wishQueue[code];
      ok++;
    } catch(e){
      fail++;
      console.error('wishlist sync failed for', code, e);
    }
  }
  saveWishQueue();
  if(ok) toast(`Synced ${ok} request${ok===1?'':'s'}${fail? `, ${fail} failed`:''}`);
  else if(fail) toast(`Wishlist sync failed for ${fail} request${fail===1?'':'s'}`);
}

async function refreshWishlist(opts={}){
  const silent = !!opts.silent;
  if(!accessToken){
    if(silent) return;
    const got = await ensureAuth();
    if(!got) return;
  }
  try{
    await ensureWishlistSheet();
    const data = await sheetsFetch(`/values/${encodeURIComponent(WISH_RANGE)}`);
    const remote = (data.values || []).slice(1).filter(r => r[0]).map(rowToWish);
    const map = new Map(remote.map(w => [w.requestCode, w]));
    Object.values(wishQueue).forEach(w => map.set(w.requestCode, w)); // local edits win until synced
    wishes = Array.from(map.values());
    saveWishCache();
    renderWishlist();
    updateWishCodePreview();
    if(!silent) toast('Wishlist synced');
  } catch(e){
    console.error(e);
    if(!silent) toast('Could not reach the Wishlist tab — check Settings');
  }
}

/* ---------------- request codes ---------------- */
function nextWishCode(){
  const nums = wishes
    .map(w => parseInt((w.requestCode||'').slice(1),10))
    .filter(n => !isNaN(n));
  return 'W' + String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3,'0');
}
function updateWishCodePreview(){
  const el = document.getElementById('wishCodePreview');
  if(el) el.textContent = nextWishCode();
}

/* ---------------- matching requests to stock ----------------
   Deliberately simple and explainable: a shared keyword is worth 2, the right
   category another 2, the wrong category -2. One shared keyword (or the right
   category on a vague "any chair" request) is enough to surface. It's a prompt
   to go look, never an automatic decision.
------------------------------------------------------------- */
const MATCH_STOPWORDS = new Set([
  'the','and','for','with','any','some','need','needs','needed','want','wants','wanted',
  'looking','look','please','item','items','piece','pieces','unit','units','something',
  'anything','preferably','ideally','ask','asked','asking','their','they','one','two',
  'about','around','from','that','this','have','has','would','like','are','our','can'
]);
function matchTokens(text){
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g,' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !MATCH_STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map(w => (w.length > 4 && w.endsWith('s')) ? w.slice(0,-1) : w);
}
function wishItemScore(wish, item){
  const want = new Set(matchTokens(`${wish.item||''} ${wish.notes||''}`));
  const have = new Set(matchTokens(`${item.description||''} ${item.notes||''} ${CATEGORY_LABELS[item.category]||''}`));
  let score = 0;
  want.forEach(w => { if(have.has(w)) score += 2; });
  if(wish.category && wish.category !== 'Any'){
    score += (item.category === wish.category) ? 2 : -2;
  }
  return score;
}
const MATCH_THRESHOLD = 2;
const MATCH_LIMIT = 6;

// Available stock that looks like what this open request asked for.
function matchesForWish(wish){
  if((wish.status || 'Open') !== 'Open') return [];
  return items
    .filter(i => i.status === 'Available')
    .map(i => ({ item:i, score: wishItemScore(wish, i) }))
    .filter(x => x.score >= MATCH_THRESHOLD)
    .sort((a,b) => b.score - a.score || (b.item.dateAdded||'').localeCompare(a.item.dateAdded||''))
    .slice(0, MATCH_LIMIT)
    .map(x => x.item);
}
// The other direction: open requests that this one item could satisfy.
function wishesWantingItem(item){
  return wishes
    .filter(w => (w.status || 'Open') === 'Open')
    .map(w => ({ wish:w, score: wishItemScore(w, item) }))
    .filter(x => x.score >= MATCH_THRESHOLD)
    .sort((a,b) => b.score - a.score)
    .map(x => x.wish);
}

/* ---------------- wishlist email text ---------------- */
function buildWishEmailText(wish, item){
  const greeting = wish.requestedBy ? `Hi ${wish.requestedBy},` : 'Hello,';
  const lines = [
    `Subject: Surplus request ${wish.requestCode} — we found something`,
    '',
    greeting,
    '',
    `You asked us to keep an eye out for: ${wish.item}`,
    `Requested on: ${formatDate(wish.dateRequested)}`,
    ''
  ];
  if(item){
    lines.push('We now have something that fits:');
    lines.push('');
    lines.push(buildStackedCaption(item));
    lines.push('');
    lines.push("It's being held for you for 30 days from today. Let us know when you'd like to arrange pickup, or if it isn't what you had in mind and we should keep looking.");
  } else {
    lines.push("Something has come in that may fit what you asked for — let us know if you'd like to come take a look.");
  }
  lines.push('');
  lines.push('Thanks,');
  lines.push('CSULB Parking & Operations — Surplus Program');
  return lines.join('\n');
}

/* ---------------- wishlist rendering ---------------- */
function wishCardHTML(wish){
  const status = wish.status || 'Open';
  const statusClass = 'status-' + status.toLowerCase();
  const matches = matchesForWish(wish);

  let ageBadge = '';
  if(status === 'Open' && wish.dateRequested){
    const d = daysSince(wish.dateRequested);
    ageBadge = `<span class="age-badge ${ageClass(d)}">${d}d waiting</span>`;
  }

  const metaBits = [wish.requestCode, `asked ${formatDate(wish.dateRequested)}`];
  if(wish.requestedBy) metaBits.push(escapeHTML(wish.requestedBy));
  if(wish.contact) metaBits.push(escapeHTML(wish.contact));
  if(wish.qty && wish.qty !== '1') metaBits.push(`qty ${escapeHTML(wish.qty)}`);
  metaBits.push(wish.category && wish.category !== 'Any'
    ? escapeHTML(CATEGORY_LABELS[wish.category] || wish.category)
    : 'any category');

  const notesHTML = wish.notes ? `<p class="wish-card-notes">${escapeHTML(wish.notes)}</p>` : '';

  let matchHTML = '';
  if(status === 'Open'){
    matchHTML = matches.length
      ? `<div class="wish-matches">
           <span class="wish-match-head">${matches.length} possible match${matches.length===1?'':'es'} available now</span>
           ${matches.map(i => `<button type="button" class="wish-match" data-waction="showmatch" data-wcode="${wish.requestCode}" data-code="${i.itemCode}">${i.itemCode} · ${escapeHTML(i.description)}</button>`).join('')}
         </div>`
      : '<div class="wish-matches wish-matches-empty">Nothing in stock looks like this yet.</div>';
  } else if(status === 'Filled'){
    matchHTML = `<div class="wish-matches wish-matches-empty">Filled ${formatDate(wish.filledDate)}${wish.filledWith ? ` with ${escapeHTML(wish.filledWith)}` : ''}.</div>`;
  }

  const actions = [];
  if(status === 'Open'){
    actions.push(`<button data-waction="fill" data-wcode="${wish.requestCode}" class="primary-action">Found a match</button>`);
    actions.push(`<button data-waction="notify" data-wcode="${wish.requestCode}">Heads-up text</button>`);
    actions.push(`<button data-waction="edit" data-wcode="${wish.requestCode}">Edit</button>`);
    actions.push(`<button data-waction="cancel" data-wcode="${wish.requestCode}">Cancel request</button>`);
  } else {
    actions.push(`<button data-waction="reopen" data-wcode="${wish.requestCode}" class="primary-action">Reopen</button>`);
    if(status === 'Filled') actions.push(`<button data-waction="notify" data-wcode="${wish.requestCode}">Heads-up text</button>`);
    actions.push(`<button data-waction="edit" data-wcode="${wish.requestCode}">Edit</button>`);
  }

  return `
  <div class="wish-card" data-wcode="${wish.requestCode}">
    <div class="wish-card-head">
      <div class="wish-card-headline">
        <div class="wish-card-dept">${escapeHTML(wish.department)}</div>
        <div class="wish-card-item">${escapeHTML(wish.item)}</div>
      </div>
      <span class="status-stamp ${statusClass}">${status}</span>
    </div>
    <div class="wish-card-meta">${metaBits.join(' · ')} ${ageBadge}</div>
    ${notesHTML}
    ${matchHTML}
    <div class="tag-card-actions">${actions.join('')}</div>
  </div>`;
}

function renderWishlist(){
  const el = document.getElementById('wishlistList');
  if(!el) return;
  const searchEl = document.getElementById('wishSearch');
  const filterEl = document.getElementById('wishStatusFilter');
  const search = (searchEl ? searchEl.value : '').trim().toLowerCase();
  const statusFilter = filterEl ? filterEl.value : '';

  let list = [...wishes].sort((a,b) => (b.dateRequested||'').localeCompare(a.dateRequested||''));
  if(search){
    list = list.filter(w =>
      (w.department||'').toLowerCase().includes(search) ||
      (w.item||'').toLowerCase().includes(search) ||
      (w.requestedBy||'').toLowerCase().includes(search) ||
      (w.notes||'').toLowerCase().includes(search) ||
      (w.requestCode||'').toLowerCase().includes(search));
  }
  if(statusFilter) list = list.filter(w => (w.status||'Open') === statusFilter);

  el.innerHTML = list.length
    ? list.map(wishCardHTML).join('')
    : `<div class="empty-state">${wishes.length
        ? 'No requests match that filter.'
        : "Nothing requested yet. Add what a department asked for and it'll show up here whenever matching stock comes in."}</div>`;
}

function persistWish(wish){
  saveWishCache();
  queueWishUpsert(wish);
  renderWishlist();
}

/* ---------------- wishlist actions ---------------- */
function handleWishAction(action, code, itemCode){
  const wish = wishes.find(w => w.requestCode === code);
  if(!wish) return;

  if(action === 'showmatch'){
    // Jump to the item on the Inventory tab so you can reserve it there.
    activateTab('inventory');
    document.getElementById('invSearch').value = itemCode;
    document.getElementById('invStatusFilter').value = '';
    renderInventoryList();
    window.scrollTo({ top:0, behavior:'smooth' });
    return;
  }
  if(action === 'fill')   { openWishFillModal(wish); return; }
  if(action === 'notify') { openWishNotifyModal(wish); return; }
  if(action === 'edit')   { openWishEditModal(wish); return; }
  if(action === 'cancel'){
    if(!confirm(`Cancel ${wish.requestCode} — ${wish.department}'s request? It stays on the list marked Cancelled.`)) return;
    wish.status = 'Cancelled';
    persistWish(wish);
    toast(`${wish.requestCode} cancelled`);
    return;
  }
  if(action === 'reopen'){
    wish.status = 'Open';
    wish.filledWith = '';
    wish.filledDate = '';
    persistWish(wish);
    toast(`${wish.requestCode} reopened`);
  }
}

/* ---------------- wishlist modals ---------------- */
let fillingWishCode = null;
function openWishFillModal(wish){
  fillingWishCode = wish.requestCode;
  document.getElementById('wishFillModalCode').textContent = `${wish.requestCode} — ${wish.department}: ${wish.item}`;
  const matches = matchesForWish(wish);
  const grid = document.getElementById('wishFillMatches');
  grid.innerHTML = matches.length
    ? matches.map(i => `<button type="button" class="wish-match" data-fillcode="${i.itemCode}">${i.itemCode} · ${escapeHTML(i.description)}</button>`).join('')
    : '<span class="field-hint">No available item looks like a match — type a code below if you have one in mind.</span>';
  grid.querySelectorAll('[data-fillcode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('wishFillCodeInput').value = btn.dataset.fillcode;
      grid.querySelectorAll('[data-fillcode]').forEach(b => b.classList.toggle('is-selected', b === btn));
    });
  });
  document.getElementById('wishFillCodeInput').value = '';
  document.getElementById('wishFillReserve').checked = true;
  document.getElementById('wishFillModalBackdrop').hidden = false;
}
function closeWishFillModal(){
  document.getElementById('wishFillModalBackdrop').hidden = true;
  fillingWishCode = null;
}
function confirmWishFill(){
  const wish = wishes.find(w => w.requestCode === fillingWishCode);
  if(!wish) return;
  const itemCode = document.getElementById('wishFillCodeInput').value.trim().toUpperCase();
  const alsoReserve = document.getElementById('wishFillReserve').checked;

  let item = null;
  if(itemCode){
    item = items.find(i => i.itemCode === itemCode);
    if(!item){ toast(`No item called ${itemCode} — check the code`); return; }
  }

  wish.status = 'Filled';
  wish.filledWith = item ? item.itemCode : '';
  wish.filledDate = nowISO();
  persistWish(wish);

  if(item && alsoReserve && item.status === 'Available'){
    item.status = 'Reserved';
    item.reservedBy = wish.department;
    item.reservedContact = wish.contact || '';
    item.reservedDate = nowISO();
    persistItem(item);
    toast(`${wish.requestCode} filled — ${item.itemCode} reserved for ${wish.department}`);
  } else if(item && alsoReserve){
    toast(`${wish.requestCode} filled — ${item.itemCode} is already ${item.status.toLowerCase()}`);
  } else {
    toast(`${wish.requestCode} marked filled`);
  }

  closeWishFillModal();
  openWishNotifyModal(wish);
}

let editingWishCode = null;
function openWishEditModal(wish){
  editingWishCode = wish.requestCode;
  document.getElementById('wishEditModalCode').textContent = `${wish.requestCode} — asked ${formatDate(wish.dateRequested)}`;
  document.getElementById('weDepartment').value  = wish.department || '';
  document.getElementById('weRequestedBy').value = wish.requestedBy || '';
  document.getElementById('weContact').value     = wish.contact || '';
  document.getElementById('weItem').value        = wish.item || '';
  document.getElementById('weCategory').value    = wish.category || 'Any';
  document.getElementById('weQty').value         = wish.qty || '1';
  document.getElementById('weNotes').value       = wish.notes || '';
  document.getElementById('wishEditModalBackdrop').hidden = false;
}
function closeWishEditModal(){
  document.getElementById('wishEditModalBackdrop').hidden = true;
  editingWishCode = null;
}

function openWishNotifyModal(wish){
  const item = wish.filledWith ? items.find(i => i.itemCode === wish.filledWith) : null;
  document.getElementById('wishNotifyText').textContent = buildWishEmailText(wish, item);
  document.getElementById('wishNotifyModalBackdrop').hidden = false;
}
function closeWishNotifyModal(){ document.getElementById('wishNotifyModalBackdrop').hidden = true; }

/* ---------------- intake heads-up ---------------- */
// Called right after an item is logged: says who's been waiting for one of these.
function showIntakeWishAlert(item){
  const el = document.getElementById('intakeWishAlert');
  const hits = wishesWantingItem(item);
  if(!hits.length){ el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = `
    <span class="wish-alert-head">${hits.length} department${hits.length===1?' has':'s have'} asked for something like this</span>
    ${hits.map(w => `<button type="button" class="wish-match" data-waction="fill" data-wcode="${w.requestCode}">${escapeHTML(w.department)} · ${escapeHTML(w.item)}</button>`).join('')}`;
  el.hidden = false;
  toast(`Heads up — ${hits.length} open request${hits.length===1?'':'s'} match${hits.length===1?'es':''} this`);
}

/* ---------------- wishlist wiring ---------------- */
function wireWishlist(){
  updateWishCodePreview();
  renderWishlist();

  document.getElementById('wishForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const wish = {
      requestCode: nextWishCode(),
      department: document.getElementById('wDepartment').value.trim(),
      requestedBy: document.getElementById('wRequestedBy').value.trim(),
      contact: document.getElementById('wContact').value.trim(),
      category: document.getElementById('wCategory').value,
      item: document.getElementById('wItem').value.trim(),
      qty: document.getElementById('wQty').value.trim() || '1',
      notes: document.getElementById('wNotes').value.trim(),
      dateRequested: todayISO(),
      status: 'Open',
      filledWith: '',
      filledDate: ''
    };
    wishes.unshift(wish);
    persistWish(wish);

    e.target.reset();
    document.getElementById('wQty').value = '1';
    updateWishCodePreview();

    const n = matchesForWish(wish).length;
    toast(n
      ? `${wish.requestCode} added — ${n} possible match${n===1?'':'es'} in stock already`
      : `${wish.requestCode} added — matching intake will flag it`);
  });

  document.getElementById('wishSearch').addEventListener('input', renderWishlist);
  document.getElementById('wishStatusFilter').addEventListener('change', renderWishlist);
  document.getElementById('refreshWishlist').addEventListener('click', () => refreshWishlist());

  document.getElementById('wishFillModalCancel').addEventListener('click', closeWishFillModal);
  document.getElementById('wishFillModalConfirm').addEventListener('click', confirmWishFill);

  document.getElementById('wishEditModalCancel').addEventListener('click', closeWishEditModal);
  document.getElementById('wishEditForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const wish = wishes.find(w => w.requestCode === editingWishCode);
    if(!wish) return;
    wish.department  = document.getElementById('weDepartment').value.trim();
    wish.requestedBy = document.getElementById('weRequestedBy').value.trim();
    wish.contact     = document.getElementById('weContact').value.trim();
    wish.item        = document.getElementById('weItem').value.trim();
    wish.category    = document.getElementById('weCategory').value;
    wish.qty         = document.getElementById('weQty').value.trim() || '1';
    wish.notes       = document.getElementById('weNotes').value.trim();
    persistWish(wish);
    closeWishEditModal();
    toast('Request updated');
  });

  document.getElementById('wishNotifyModalClose').addEventListener('click', closeWishNotifyModal);
  document.getElementById('wishNotifyModalCopy').addEventListener('click', () => {
    copyText(document.getElementById('wishNotifyText').textContent);
  });
}
