import { firebaseConfig } from './config.js';

const $ = (s) => document.querySelector(s);
const LS = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} }
};
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const keyOf = (s) => norm(s).replace(/[^a-z0-9]+/g, '_').slice(0, 60) || 'x';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

/* ---------- Interpretare text / voce ---------- */
const NUMS = { un: 1, o: 1, una: 1, unu: 1, doi: 2, doua: 2, trei: 3, patru: 4, cinci: 5, sase: 6, sapte: 7, opt: 8, noua: 9, zece: 10 };
const QTY_RE = /^(\d+(?:[.,]\d+)?|un|o|una|unu|doi|două|doua|trei|patru|cinci|șase|sase|șapte|sapte|opt|nouă|noua|zece)\s+(kg|kilograme|kilogram|g|gr|grame|gram|l|litri|litru|ml|buc|bucăți|bucati|bucată|bucata|pachete|pachet|sticle|sticlă|sticla|cutii|cutie|borcane|borcan|legături|legaturi|legătură|legatura|baxuri|bax|doze|doză|doza)?\s*(?:de\s+)?(.+)$/i;

function parseOne(raw) {
  const s = raw.trim().replace(/[.!?]+$/, '');
  if (!s) return null;
  const m = s.match(QTY_RE);
  if (m && m[3]) {
    const numRaw = norm(m[1]);
    const num = NUMS[numRaw] ?? m[1].replace(',', '.');
    const unit = m[2] ? m[2].toLowerCase() : '';
    const qty = unit ? `${num} ${unit}` : (num == 1 ? '' : `${num} buc`);
    return { name: cap(m[3].trim()), qty };
  }
  return { name: cap(s), qty: '' };
}
function parseItems(text) {
  return text
    .split(/[,;\n]|\s+(?:și|si|plus|apoi)\s+|\.\s+/i)
    .map(parseOne)
    .filter((x) => x && x.name.length > 0);
}

/* ---------- Stocare: Firebase (sincron) sau local ---------- */
const configured = firebaseConfig && firebaseConfig.apiKey && !firebaseConfig.apiKey.includes('PUNE_AICI');

function localStore(code) {
  const ki = `lista:${code}:items`, kh = `lista:${code}:history`;
  let items = LS.get(ki, {}), hist = LS.get(kh, {});
  let onItems = () => {}, onHist = () => {};
  const save = () => { LS.set(ki, items); onItems({ ...items }); };
  return {
    mode: 'local',
    subscribe(cb) { onItems = cb; cb({ ...items }); },
    onHistory(cb) { onHist = cb; cb({ ...hist }); },
    onConn(cb) { cb(true); },
    add(it) { const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); items[id] = it; save(); return id; },
    put(id, it) { items[id] = it; save(); },
    patch(id, p) { if (items[id]) { items[id] = { ...items[id], ...p }; save(); } },
    del(id) { delete items[id]; save(); },
    bump(k, name) { const v = hist[k] || { c: 0 }; hist[k] = { n: name, c: v.c + 1, t: Date.now() }; LS.set(kh, hist); onHist({ ...hist }); }
  };
}

async function cloudStore(code) {
  const { initializeApp, getDatabase, ref, onValue, set, update, remove, push, runTransaction,
    getAuth, signInAnonymously, onAuthStateChanged } = await import('./firebase.js');
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const user = await new Promise((res) => { const un = onAuthStateChanged(auth, (u) => { un(); res(u); }); });
  if (!user) await signInAnonymously(auth);
  const db = getDatabase(app);
  const base = `lists/${code}`;
  return {
    mode: 'cloud',
    subscribe(cb) { onValue(ref(db, base + '/items'), (s) => cb(s.val() || {}), (e) => toast('Eroare de acces: ' + e.code)); },
    onHistory(cb) { onValue(ref(db, base + '/history'), (s) => cb(s.val() || {})); },
    onConn(cb) { onValue(ref(db, '.info/connected'), (s) => cb(!!s.val())); },
    add(it) { const r = push(ref(db, base + '/items')); set(r, it); return r.key; },
    put(id, it) { set(ref(db, `${base}/items/${id}`), it); },
    patch(id, p) { update(ref(db, `${base}/items/${id}`), p); },
    del(id) { remove(ref(db, `${base}/items/${id}`)); },
    bump(k, name) { runTransaction(ref(db, `${base}/history/${k}`), (v) => ({ n: name, c: ((v && v.c) || 0) + 1, t: Date.now() })); }
  };
}

/* ---------- Stare ---------- */
let store = null;
let items = {};
let histData = {};
let me = LS.get('lista:me', '');
let code = LS.get('lista:code', '');
let lastSeen = LS.get('lista:lastSeen', 0);
const seenAtOpen = lastSeen;
let doneCollapsed = LS.get('lista:doneCollapsed', false);
let editingId = null;

const PALETTE = ['#FF2EB8', '#12D8FF', '#FF7A1A', '#B44CFF', '#2EC27E', '#FF3E6C'];
const PEOPLE = [
  { name: 'Ruxandra', emoji: '🌴', color: '#2EE07A' },
  { name: 'Răzvan', emoji: '🚙', color: '#2F86FF' }
];
const personOf = (name) => PEOPLE.find((p) => norm(p.name) === norm(name || '')) ||
  { name: name || '?', emoji: (name || '?')[0].toUpperCase(), color: '#B44CFF' };
const whoButtons = (sel) => PEOPLE.map((p) =>
  `<button type="button" class="who${norm(p.name) === norm(sel || '') ? ' sel' : ''}" style="--pc:${p.color}" data-name="${esc(p.name)}"><span class="em">${p.emoji}</span>${esc(p.name)}</button>`).join('');
const colorFor = (name) => { let h = 0; for (const ch of name || '?') h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };

/* ---------- Pornire ---------- */
function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(r, (b) => A[b % A.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}
$('#setupWho').addEventListener('click', (e) => {
  const b = e.target.closest('.who'); if (b) { vibrate(10); $('#setupWho').innerHTML = whoButtons(b.dataset.name); }
});
const cleanCode = (c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4}).*$/, '$1-$2');

function showSetup() {
  $('#app').hidden = true; $('#setup').hidden = false;
  $('#setupWho').innerHTML = whoButtons(me);
  const j = new URLSearchParams(location.hash.slice(1)).get('j');
  if (j) { $('#setupCode').value = cleanCode(j); $('#setupCode').focus(); }
}
function needName() {
  const n = $('#setupWho .who.sel')?.dataset.name;
  if (!n) { toast('Alege întâi cine ești 🌴 / 🚙'); return null; }
  return n;
}
$('#btnNew').onclick = () => { const n = needName(); if (!n) return; me = n; code = genCode(); start(); };
$('#btnJoin').onclick = () => {
  const n = needName(); if (!n) return;
  const c = cleanCode($('#setupCode').value);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) { toast('Codul are forma ABCD-1234'); return; }
  me = n; code = c; start();
};

async function start() {
  const wantVoice = location.hash === '#voce';
  LS.set('lista:me', me); LS.set('lista:code', code);
  window.history.replaceState(null, '', location.pathname);
  $('#setup').hidden = true; $('#app').hidden = false;
  $('#localBanner').hidden = configured;
  showMe();

  // afișăm imediat ultima versiune salvată (funcționează și offline)
  items = LS.get(`lista:${code}:cache`, {});
  render();

  try {
    store = configured ? await cloudStore(code) : localStore(code);
  } catch (e) {
    console.error(e);
    store = localStore(code);
    $('#localBanner').hidden = false;
    $('#localBanner').innerHTML = '⚠️ Nu mă pot conecta la Firebase, deci lista e doar pe acest telefon.<br><small>Eroare: <b>' +
      esc((e && (e.code || e.message)) || String(e)) + '</b></small><br><button class="btn ghost" style="margin-top:8px" onclick="location.reload()">🔄 Încearcă din nou</button>';
  }
  store.onConn((on) => {
    $('#dot').className = 'dot ' + (on ? 'on' : 'off');
    $('#statusTxt').textContent = store.mode === 'local' ? 'doar pe acest telefon'
      : on ? 'sincronizat · ' + code : 'offline · se sincronizează când revine netul';
  });
  store.subscribe((v) => {
    items = v || {};
    if (store.mode === 'cloud') LS.set(`lista:${code}:cache`, items);
    render();
  });
  setTimeout(() => LS.set('lista:lastSeen', Date.now()), 1500);
  if (wantVoice) startVoice();
}

/* ---------- Acțiuni pe produse ---------- */
function findOpenByName(name) {
  const n = norm(name);
  return Object.entries(items).find(([, v]) => norm(v.name) === n);
}
function addItems(list) {
  const added = [], skipped = [];
  for (const { name, qty } of list) {
    const ex = findOpenByName(name);
    if (ex) {
      const [id, v] = ex;
      if (v.done) { store.patch(id, { done: false, doneBy: null, doneAt: null, qty: qty || v.qty || '' }); added.push(name); }
      else if (qty && qty !== v.qty) { store.patch(id, { qty }); added.push(name + ' (' + qty + ')'); }
      else skipped.push(name);
      continue;
    }
    store.add({ name, qty: qty || '', note: '', done: false, urgent: false, by: me, ts: Date.now() });
    added.push(name);
  }
  if (added.length) { vibrate(15); toast('✅ Adăugat: ' + added.join(', ')); }
  else if (skipped.length) toast('Deja pe listă: ' + skipped.join(', '));
}
function toggle(id) {
  const v = items[id]; if (!v) return;
  const done = !v.done;
  vibrate(done ? [10, 30, 10] : 10);
  store.patch(id, { done, doneBy: done ? me : null, doneAt: done ? Date.now() : null });
}
function del(id) {
  const v = items[id]; if (!v) return;
  store.del(id);
  toast(`🗑️ Șters: ${v.name}`, 'Anulează', () => store.put(id, v));
}

/* ---------- Afișare ---------- */
const ZILE = ['Duminică', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'];
const LUNI = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return `${ZILE[d.getDay()]}, ${d.getDate()} ${LUNI[d.getMonth()]}${y}`;
}
function itemHTML(id, v) {
  const c = { color: personOf(v.by).color };
  const isNew = !v.done && v.by && v.by !== me && (v.ts || 0) > seenAtOpen && seenAtOpen > 0;
  const meta = [];
  if (v.qty) meta.push(`<span class="qty">${esc(v.qty)}</span>`);
  if (v.note) meta.push(`<span class="note">${esc(v.note)}</span>`);
  const who = v.done ? v.doneBy : v.by;
  let badge = '';
  if (who) { const p = personOf(who); badge = `<span class="by" style="--pc:${p.color}" title="${v.done ? 'Cumpărat de ' : 'Adăugat de '}${esc(p.name)}">${p.emoji}</span>`; }
  return `<li class="item${v.urgent && !v.done ? ' urgent' : ''}" data-id="${esc(id)}" style="--c:${c.color}">
    <button class="chk" data-act="toggle" aria-label="${v.done ? 'Debifează' : 'Bifează'} ${esc(v.name)}"></button>
    <div class="txt" data-act="edit">
      <div class="nm-row"><span class="nm">${v.urgent && !v.done ? '🔥 ' : ''}${esc(v.name)}</span>${badge}</div>
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      <div class="day">${fmtDay(v.ts)}</div>
    </div>
    ${isNew ? '<span class="new">NOU</span>' : ''}
    <button class="del" data-act="del" aria-label="Șterge ${esc(v.name)}">✕</button>
  </li>`;
}

function render() {
  const all = Object.entries(items);
  const todo = all.filter(([, v]) => !v.done);
  const done = all.filter(([, v]) => v.done).sort((a, b) => (b[1].doneAt || 0) - (a[1].doneAt || 0));

  const total = all.length;
  $('#bar').style.width = total ? (done.length / total * 100) + '%' : '0';
  $('#progTxt').textContent = total ? `${done.length} din ${total} în coș` : 'listă goală';

  if (!todo.length) {
    $('#list').innerHTML = total
      ? `<div class="empty"><div class="big">🎉</div><p><b>Gata, ați luat tot!</b><br>Puteți goli produsele cumpărate mai jos.</p></div>`
      : `<div class="empty"><div class="big">🛍️</div><p><b>Lista e goală.</b><br>Scrie un produs sau apasă microfonul și spune ce trebuie luat.</p></div>`;
  } else {
    todo.sort((a, b) => (b[1].urgent ? 1 : 0) - (a[1].urgent ? 1 : 0) || (a[1].ts || 0) - (b[1].ts || 0));
    $('#list').innerHTML = `<ul class="items">${todo.map(([id, v]) => itemHTML(id, v)).join('')}</ul>`;
  }

  $('#doneWrap').hidden = !done.length;
  $('#doneWrap').classList.toggle('collapsed', doneCollapsed);
  $('#doneArrow').textContent = doneCollapsed ? '▸' : '▾';
  $('#doneCount').textContent = done.length;
  $('#doneList').innerHTML = done.map(([id, v]) => itemHTML(id, v)).join('');
}

/* ---------- Evenimente ---------- */
function onListClick(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const id = btn.closest('.item')?.dataset.id; if (!id) return;
  const act = btn.dataset.act;
  if (act === 'toggle') toggle(id);
  else if (act === 'del') del(id);
  else if (act === 'edit') openEdit(id);
}
$('#list').addEventListener('click', onListClick);
$('#doneList').addEventListener('click', onListClick);

$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#addInput').value.trim(); if (!t || !store) return;
  addItems(parseItems(t));
  $('#addInput').value = '';
});
$('#doneToggle').onclick = () => { doneCollapsed = !doneCollapsed; LS.set('lista:doneCollapsed', doneCollapsed); render(); };
$('#btnClear').onclick = () => {
  const done = Object.entries(items).filter(([, v]) => v.done);
  if (!done.length) return;
  if (!confirm(`Ștergi ${done.length} produse cumpărate?`)) return;
  done.forEach(([id]) => store.del(id));
  toast('🧹 Gata, lista e curată', 'Anulează', () => done.forEach(([id, v]) => store.put(id, v)));
};

/* ---------- Editare ---------- */
function openEdit(id) {
  const v = items[id]; if (!v) return;
  editingId = id;
  $('#edName').value = v.name; $('#edQty').value = v.qty || ''; $('#edNote').value = v.note || '';
  $('#edUrgent').checked = !!v.urgent;
  $('#editSheet').hidden = false;
}
$('#editForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!editingId) return;
  store.patch(editingId, {
    name: cap($('#edName').value.trim()), qty: $('#edQty').value.trim(),
    note: $('#edNote').value.trim(), urgent: $('#edUrgent').checked
  });
  closeOverlays();
});
function closeOverlays() { document.querySelectorAll('.overlay').forEach((o) => { if (o.id !== 'voice') o.hidden = true; }); editingId = null; }
document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => {
  if (e.target === o || e.target.closest('[data-close]')) { if (o.id === 'voice') stopVoice(); else closeOverlays(); }
}));

/* ---------- Teme ---------- */
const THEMES = [
  { id: 'roz', name: 'Roz', grad: 'linear-gradient(135deg,#FF4FC3,#FF8A3D,#FFD43B)', bar: '#FF4FC3' },
  { id: 'ocean', name: 'Ocean', grad: 'linear-gradient(135deg,#12D8FF,#2F6BFF,#8A4DFF)', bar: '#2F8BFF' },
  { id: 'verde', name: 'Verde', grad: 'linear-gradient(135deg,#2EE07A,#0FBF8F,#00A9D6)', bar: '#14C26A' },
  { id: 'mov', name: 'Mov', grad: 'linear-gradient(135deg,#8A4DFF,#C04CFF,#FF4FC3)', bar: '#9B4DFF' },
  { id: 'apus', name: 'Apus', grad: 'linear-gradient(135deg,#FF3E6C,#FF7A1A,#FFC21A)', bar: '#FF6A2A' },
  { id: 'lamaie', name: 'Lămâie', grad: 'linear-gradient(135deg,#FFE14D,#FFB800,#FF7A1A)', bar: '#FFC21A' }
];
let theme = LS.get('lista:theme', 'roz');
function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  theme = t.id; LS.set('lista:theme', theme);
  if (theme === 'roz') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').setAttribute('content', t.bar);
  $('#themes').innerHTML = THEMES.map((x) =>
    `<button type="button" class="theme${x.id === theme ? ' sel' : ''}" data-theme="${x.id}"><i style="background:${x.grad}"></i>${x.name}</button>`).join('');
}
$('#themes').addEventListener('click', (e) => { const b = e.target.closest('.theme'); if (b) { vibrate(10); applyTheme(b.dataset.theme); } });
applyTheme(theme);

/* ---------- Setări ---------- */
$('#btnSettings').onclick = $('#logoBtn').onclick = () => {
  $('#codeShow').textContent = code; $('#setWho').innerHTML = whoButtons(me);
  $('#modeTxt').textContent = store?.mode === 'cloud'
    ? 'Lista se sincronizează prin Firebase. Oricine are codul poate vedea lista, așa că nu-l publicați.'
    : 'Mod local: datele stau doar pe acest telefon.';
  $('#settings').hidden = false;
};
$('#setWho').addEventListener('click', (e) => {
  const b = e.target.closest('.who'); if (!b) return;
  me = b.dataset.name; LS.set('lista:me', me); $('#setWho').innerHTML = whoButtons(me); showMe(); render();
});
function showMe() { const p = personOf(me); const el = $('#meBadge'); el.textContent = p.emoji; el.style.setProperty('--pc', p.color); el.title = 'Tu: ' + p.name; }
$('#btnShare').onclick = async () => {
  const url = `${location.origin}${location.pathname}#j=${code}`;
  const text = `Hai pe lista noastră de cumpărături 🛒\nDeschide linkul, alege 🚙 și apasă „Intră”. Codul: ${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Lista Noastră', text, url });
    else { await navigator.clipboard.writeText(text + '\n' + url); toast('📋 Invitația a fost copiată'); }
  } catch {}
};
$('#btnLeave').onclick = () => {
  if (!confirm('Ieși din această listă? (lista rămâne salvată pentru partener)')) return;
  LS.del('lista:code'); location.reload();
};

/* ---------- Voce ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, finalText = '', finals = [], listening = false;
// Elimină repetițiile: dacă o bucată e începutul alteia (ex. „sos”, „sos pesto”, „sos pesto de la Lidl”), o păstrăm doar pe cea completă.
function collapse(parts) {
  const out = [];
  for (const p of parts.filter(Boolean)) {
    const n = norm(p), last = out.length ? norm(out[out.length - 1]) : null;
    if (last !== null && n.startsWith(last)) out[out.length - 1] = p;
    else if (last !== null && last.startsWith(n)) continue;
    else out.push(p);
  }
  return out.join(', ');
}
function startVoice() {
  if (!SR) {
    toast('Browserul nu suportă recunoașterea vocală aici. Folosește microfonul de pe tastatură 🎤');
    $('#addInput').focus(); return;
  }
  finalText = ''; finals = [];
  rec = new SR();
  // Pe Android, modul „continuu” retrimite tot textul de la început la fiecare cuvânt → dubluri.
  // Ascultăm o singură frază și păstrăm doar ultima variantă a fiecărui rezultat (după index).
  rec.lang = 'ro-RO'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i], t = r[0].transcript.trim();
      if (r.isFinal) finals[i] = t; else interim = t;
    }
    finalText = collapse(finals);
    $('#voiceTxt').textContent = (interim && !finalText.endsWith(interim) ? (finalText + ' ' + interim) : finalText).trim() || interim || 'Te ascult…';
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Permite accesul la microfon din setările browserului.');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Eroare microfon: ' + e.error);
  };
  rec.onend = () => {
    if (!listening) return;
    listening = false;
    $('#voice').hidden = true;
    const shown = $('#voiceTxt').textContent;
    const t = finalText.trim() || (shown !== 'Te ascult…' ? shown : '');
    if (t) addItems(parseItems(t));
  };
  $('#voiceTxt').textContent = 'Te ascult…';
  $('#voice').hidden = false;
  listening = true; vibrate(20);
  try { rec.start(); } catch { listening = false; $('#voice').hidden = true; }
}
function stopVoice() { if (rec) try { rec.stop(); } catch {} }
$('#btnMic').onclick = () => { if (store) startVoice(); };
$('#voiceStop').onclick = stopVoice;

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, actLabel = '', act = null) {
  const t = $('#toast');
  $('#toastTxt').textContent = msg;
  $('#toastAct').textContent = actLabel;
  $('#toastAct').onclick = () => { act && act(); t.hidden = true; };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), actLabel ? 5000 : 2600);
}

/* ---------- Service worker + start ---------- */
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
if (me && code) start(); else showSetup();
