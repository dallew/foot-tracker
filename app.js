import { createStore } from './store.js';
import { EVENT_LABEL, REMEDIES, remedyLabel, PAIN, THEMES, nightStart, groupNights, metrics, fmtDuration,
  clipboardLine, nextType, wakeCountTonight, eventsCSV, summaryCSV } from './model.js';

const $ = id => document.getElementById(id);
const fmtNight = d => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const ICON_EYE = '<svg class="ic" viewBox="0 0 24 24"><path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11a4 4 0 110-8 4 4 0 010 8z"/></svg>';
const ICON_BED = '<svg class="ic" viewBox="0 0 24 24"><path d="M3 18v-6.5A2.5 2.5 0 015.5 9H11v4h11v5h-2v-2H5v2H3zm4-6a2 2 0 110-4 2 2 0 010 4zm6-3h6a3 3 0 013 3v0h-9V9z"/></svg>';
const html = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------- state
const LOCAL = 'fuf-local-settings';
let local = {};
try { local = JSON.parse(localStorage.getItem(LOCAL) || '{}'); } catch {}
const state = {
  events: [],
  status: {},
  settings: { nightStartHour: local.nightStartHour ?? 18, theme: local.theme ?? 'darkRed' },
  tab: 'night',
  detailNight: null,     // ms of the night start being viewed
  pending: null,         // { id, kind: 'pain' | 'remedy' } awaiting an optional follow-up
  editing: null,         // event id in the edit sheet (or null)
  user: null,
};
let store;

// ------------------------------------------------------------- views
const VIEWS = ['signin', 'setup', 'night', 'summary', 'history', 'detail', 'settings'];
function show(name) {
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  $('tabbar').hidden = name === 'signin' || name === 'setup';
  if (['night', 'summary', 'history', 'settings'].includes(name)) state.tab = name;
  const tabName = name === 'detail' ? 'history' : name;
  document.querySelectorAll('.tabbar button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tabName ? 'page' : 'false'));
  $('export-menu').hidden = true;
  renderAll();
}
function renderAll() {
  renderNight(); renderSummary(); renderHistory(); renderDetail(); renderSettings(); renderStatus();
}

function applyTheme() {
  const t = THEMES.find(x => x[0] === state.settings.theme) || THEMES[0];
  const [r, g, b] = t[2];
  document.documentElement.style.setProperty('--accent', `rgb(${r},${g},${b})`);
  document.documentElement.style.setProperty('--accent-rgb', `${r},${g},${b}`);
}
function saveLocal() { try { localStorage.setItem(LOCAL, JSON.stringify(state.settings)); } catch {} }

// ------------------------------------------------------------- static UI
function buildStatic() {
  $('pain-options').innerHTML = PAIN.map((d, i) => `<button class="option" type="button" data-pain="${i}">${i} - ${html(d)}</button>`).join('');
  $('remedy-options').innerHTML = REMEDIES.map(([k, l]) => `<button class="option" type="button" data-remedy="${k}">${html(l)}</button>`).join('');
  $('ed-pain').innerHTML = '<option value="">None</option>' + PAIN.map((d, i) => `<option value="${i}">${i} — ${html(d)}</option>`).join('');
  $('ed-remedy').innerHTML = '<option value="">None</option>' + REMEDIES.map(([k, l]) => `<option value="${k}">${html(l)}</option>`).join('');
  $('night-start').innerHTML = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}">${new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}</option>`).join('');

  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

  $('btn-awake').addEventListener('click', () => log('awake'));
  $('btn-bed').addEventListener('click', () => log('backToBed'));
  $('pain-options').addEventListener('click', e => {
    const b = e.target.closest('[data-pain]'); if (!b || !state.pending) return;
    const score = +b.dataset.pain;
    store.update(state.pending.id, { painScore: score });
    state.pending = null; renderNight(); toast(`Pain ${score} — ${PAIN[score]} saved`);
  });
  $('remedy-options').addEventListener('click', e => {
    const b = e.target.closest('[data-remedy]'); if (!b || !state.pending) return;
    store.update(state.pending.id, { remedy: b.dataset.remedy });
    state.pending = null; renderNight(); toast(`${remedyLabel(b.dataset.remedy)} saved`);
  });
  document.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => {
    if (!state.pending) return;
    store.remove(state.pending.id); state.pending = null; renderNight(); toast('Entry removed');
  }));

  $('signin-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('email').value.trim(), pw = $('password').value;
    $('signin-error').textContent = '';
    if (!email || !pw) { $('signin-error').textContent = 'Enter your email and password.'; return; }
    $('signin-btn').disabled = true; $('signin-btn').textContent = 'Signing in…';
    try { await store.signIn(email, pw); $('password').value = ''; }
    catch (err) { $('signin-error').textContent = authMessage(err); }
    finally { $('signin-btn').disabled = false; $('signin-btn').textContent = 'Sign in'; }
  });
  $('reset-btn').addEventListener('click', async () => {
    const email = $('email').value.trim();
    if (!email) { $('signin-error').textContent = 'Enter your email above first, then tap Forgot password.'; return; }
    try { await store.resetPassword(email); $('signin-error').textContent = 'If that email has an account, a reset link is on its way.'; }
    catch (err) { $('signin-error').textContent = authMessage(err); }
  });

  $('export-btn').addEventListener('click', () => { $('export-menu').hidden = !$('export-menu').hidden; });
  $('export-events').addEventListener('click', () => { $('export-menu').hidden = true; share(eventsCSV(state.events), 'NightLog.csv'); });
  $('export-summary').addEventListener('click', () => {
    $('export-menu').hidden = true; share(summaryCSV(groupNights(state.events, state.settings.nightStartHour)), 'NightLog-Summary.csv');
  });

  $('history-list').addEventListener('click', e => {
    const b = e.target.closest('[data-night]'); if (!b) return;
    state.detailNight = +b.dataset.night; show('detail');
  });
  $('detail-back').addEventListener('click', () => show('history'));
  $('detail-list').addEventListener('click', e => {
    const b = e.target.closest('[data-event]'); if (b) openEditor(b.dataset.event);
  });
  $('add-event-btn').addEventListener('click', () => {
    const evs = nightEvents();
    const ts = evs.length ? evs[evs.length - 1].timestamp : new Date(state.detailNight);
    const ev = { id: uuid(), timestamp: new Date(ts), type: 'awake' };
    store.add(ev);
    openEditor(ev.id, ev);
  });
  $('delete-night-btn').addEventListener('click', async () => {
    const evs = nightEvents(); if (!evs.length) return;
    const when = fmtNight(new Date(state.detailNight));
    if (!await confirmBox('Delete this whole night?', `This deletes all ${evs.length} events from the night of ${when}.`, 'Delete')) return;
    if (!await confirmBox('Are you really, REALLY sure?', `There is no undo. The night of ${when} will be gone for good.`, 'Yes, delete it all')) return;
    store.removeMany(evs.map(e => e.id)); show('history'); toast('Night deleted');
  });

  // Edit sheet
  document.querySelectorAll('#sheet [data-close]').forEach(b => b.addEventListener('click', closeEditor));
  $('edit-form').addEventListener('submit', e => {
    e.preventDefault();
    const t = new Date($('ed-time').value);
    store.update(state.editing, {
      type: $('ed-type').value,
      timestamp: isNaN(t) ? undefined : t,
      painScore: $('ed-pain').value === '' ? null : +$('ed-pain').value,
      remedy: $('ed-remedy').value || null,
      note: $('ed-note').value.trim() || null,
    });
    closeEditor(); toast('Saved');
  });
  $('ed-delete').addEventListener('click', () => { store.remove(state.editing); closeEditor(); toast('Event deleted'); });

  // Settings
  $('night-start').addEventListener('change', e => {
    state.settings.nightStartHour = +e.target.value; saveLocal(); store.saveSettings({ nightStartHour: state.settings.nightStartHour }); renderAll();
  });
  $('theme-list').addEventListener('click', e => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    state.settings.theme = b.dataset.theme; saveLocal(); applyTheme(); store.saveSettings({ theme: state.settings.theme }); renderSettings();
  });
  $('signout-btn').addEventListener('click', async () => {
    if (!await confirmBox('Sign out?', 'Your entries stay safe in your account. You’ll need your password to sign back in.', 'Sign out')) return;
    await store.signOut();
  });

  document.addEventListener('click', e => {
    if (!$('export-menu').hidden && !e.target.closest('#export-menu,#export-btn')) $('export-menu').hidden = true;
  });
}

// ------------------------------------------------------------- night
function log(type) {
  const ev = { id: uuid(), timestamp: new Date(), type, painScore: null, remedy: null, note: null };
  store.add(ev);
  state.pending = { id: ev.id, kind: type === 'awake' ? 'pain' : 'remedy' };
  if (navigator.vibrate) navigator.vibrate(20);
  renderNight();
  toast(type === 'awake' ? 'Awake logged' : 'Back to bed logged');
}

function renderNight() {
  const p = state.pending;
  $('night-main').hidden = !!p;
  $('pain-list').hidden = !(p && p.kind === 'pain');
  $('remedy-list').hidden = !(p && p.kind === 'remedy');
  const next = nextType(state.events, state.settings.nightStartHour);
  $('btn-awake').disabled = next !== 'awake';
  $('btn-bed').disabled = next !== 'backToBed';
  renderClock();
}
function renderClock() {
  $('clock').textContent = fmtTime(new Date());
  const n = wakeCountTonight(state.events, state.settings.nightStartHour);
  $('wake-count').textContent = `${n} ${n === 1 ? 'wake' : 'wakes'} tonight`;
}

// ------------------------------------------------------------- summary
function renderSummary() {
  const night = groupNights(state.events, state.settings.nightStartHour)[0];
  if (!night) {
    $('summary-body').innerHTML = '<div class="empty"><strong>No nights logged yet</strong>Events you log on the Night screen will be summarised here in the morning.</div>';
    return;
  }
  const m = metrics(night.events);
  const block = (v, l) => `<div class="metric"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const pain = m.painMin == null ? '' : `<div class="metric"><div class="l">Pain</div><div class="pain-stats">
      <div><div class="v">${m.painMin}</div><div class="l">Min</div></div>
      <div><div class="v">${m.painAverage.toFixed(1)}</div><div class="l">Average</div></div>
      <div><div class="v">${m.painMax}</div><div class="l">Max</div></div></div></div>`;
  $('summary-body').innerHTML = `<p class="night-of">Night of ${fmtNight(night.start)}</p>
    ${block(m.wakeCount, 'Wakes')}${block(fmtDuration(m.totalAwake), 'Total time awake')}${block(fmtDuration(m.longestAwake), 'Longest episode')}${pain}
    ${m.endsWithOpenAwake ? '<p class="note">The last wake has no Back to Bed — counted as a wake, but excluded from the times (got up for the day).</p>' : ''}
    <button class="btn primary" type="button" id="copy-btn">Copy summary</button>`;
  $('copy-btn').addEventListener('click', async e => {
    const btn = e.currentTarget, line = clipboardLine(m);
    try { await navigator.clipboard.writeText(line); btn.textContent = 'Copied ✓'; }
    catch { toast(line); }
    setTimeout(() => { btn.textContent = 'Copy summary'; }, 2000);
  });
}

// ------------------------------------------------------------- history
function renderHistory() {
  const nights = groupNights(state.events, state.settings.nightStartHour);
  $('export-btn').disabled = !state.events.length;
  if (!nights.length) {
    $('history-list').innerHTML = '';
    if (!$('view-history').querySelector('.empty')) $('history-list').insertAdjacentHTML('afterend', '<div class="empty" id="history-empty"><strong>No nights logged yet</strong>Past nights will appear here.</div>');
    return;
  }
  $('history-empty')?.remove();
  $('history-list').innerHTML = nights.map(n => {
    const m = metrics(n.events);
    const pain = m.painMin == null ? '' : `<span class="s">Pain min: ${m.painMin} | avg: ${m.painAverage.toFixed(1)} | max: ${m.painMax}</span>`;
    return `<li><button class="item" type="button" data-night="${n.start.getTime()}"><span class="main">
      <span class="h">${fmtNight(n.start)}</span>
      <span class="s">${clipboardLine(m)}</span>${pain}</span><span class="chev">›</span></button></li>`;
  }).join('');
}

function nightEvents() {
  if (state.detailNight == null) return [];
  return state.events.filter(e => nightStart(e.timestamp, state.settings.nightStartHour).getTime() === state.detailNight);
}
function renderDetail() {
  if (state.detailNight == null) return;
  $('detail-title').textContent = fmtNight(new Date(state.detailNight));
  const evs = nightEvents();
  $('delete-night-btn').hidden = !evs.length;
  $('detail-list').innerHTML = evs.length ? evs.map(e => `<li><button class="item" type="button" data-event="${e.id}">
      ${e.type === 'awake' ? ICON_EYE : ICON_BED}
      <span class="main"><span>${EVENT_LABEL[e.type]}</span>
        ${e.remedy ? `<span class="s">${html(remedyLabel(e.remedy))}</span>` : ''}
        ${e.note ? `<span class="s">${html(e.note)}</span>` : ''}</span>
      ${e.painScore != null ? `<span class="pill">Pain ${e.painScore}</span>` : ''}
      <span class="time">${fmtTime(e.timestamp)}</span></button></li>`).join('')
    : '<li><div class="item"><span class="main muted">No events in this night.</span></div></li>';
}

// ------------------------------------------------------------- edit sheet
function openEditor(id, fresh) {
  const e = fresh || state.events.find(x => x.id === id); if (!e) return;
  state.editing = id;
  $('sheet-title').textContent = fresh ? 'Add Event' : 'Edit Event';
  $('ed-type').value = e.type;
  const d = e.timestamp, p = n => String(n).padStart(2, '0');
  $('ed-time').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  $('ed-pain').value = e.painScore ?? '';
  $('ed-remedy').value = e.remedy ?? '';
  $('ed-note').value = e.note ?? '';
  $('sheet').hidden = false;
}
function closeEditor() { $('sheet').hidden = true; state.editing = null; }

// ------------------------------------------------------------- settings
function renderSettings() {
  $('night-start').value = String(state.settings.nightStartHour);
  $('theme-list').innerHTML = THEMES.map(([k, l, [r, g, b]]) => `<button class="theme-row" type="button" data-theme="${k}">
    <span class="swatch" style="background:rgb(${r},${g},${b})"></span>${l}
    ${k === state.settings.theme ? `<span class="tick" style="color:rgb(${r},${g},${b})">✓</span>` : ''}</button>`).join('');
}
function renderStatus() {
  const s = state.status;
  let text;
  if (store?.mode === 'demo') text = 'Demo mode — this device only';
  else if (!navigator.onLine) text = 'Offline — saved on this phone';
  else if (s.pending) text = 'Syncing…';
  else if (s.fromCache) text = 'Connecting…';
  else text = 'All changes synced';
  $('sync-status').textContent = text;
}

// ------------------------------------------------------------- helpers
let toastTimer;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 1500);
}

function confirmBox(title, msg, yes) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title; $('confirm-msg').textContent = msg; $('confirm-yes').textContent = yes;
    $('confirm').hidden = false;
    const done = v => { $('confirm').hidden = true; $('confirm-yes').onclick = $('confirm-no').onclick = null; resolve(v); };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

async function share(text, filename) {
  const file = new File([text], filename, { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function authMessage(err) {
  switch (err?.code) {
    case 'auth/invalid-credential': case 'auth/wrong-password': case 'auth/user-not-found':
      return 'That email and password don’t match. Check them and try again.';
    case 'auth/invalid-email': return 'That doesn’t look like an email address.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes, then try again.';
    case 'auth/network-request-failed': return 'No connection. Signing in needs the internet the first time.';
    default: return 'Couldn’t sign in (' + (err?.code || err?.message || 'unknown error') + ').';
  }
}

// ------------------------------------------------------------- boot (last, so every declaration above exists)
applyTheme();
buildStatic();
store = await createStore();
if (store.mode === 'setup') {
  show('setup');
} else {
  store.onError = e => toast(e?.code === 'permission-denied' ? 'Not allowed — check sign-in' : 'Couldn’t save — will retry');
  store.onAuth(user => {
    state.user = user;
    if (!user) { show('signin'); return; }
    $('signed-in-as').textContent = user.email || '—';
    store.subscribeSettings(s => {
      if (s.nightStartHour != null) state.settings.nightStartHour = s.nightStartHour;
      if (s.theme) state.settings.theme = s.theme;
      saveLocal(); applyTheme(); renderAll();
    });
    store.subscribe((events, status) => { state.events = events; state.status = status; renderAll(); });
    show(state.tab);
  });
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('online', renderStatus);
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => {
  // Fell back asleep without answering: keep the event, restore the big buttons.
  if (document.hidden && state.pending) { state.pending = null; renderNight(); }
  if (!document.hidden) renderAll();
});
setInterval(() => { if (state.tab === 'night') renderClock(); }, 15000);

