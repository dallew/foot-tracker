// Pure logic ported from the iOS app: event types, remedies, pain scale,
// night grouping and the nightly metrics. No DOM, no storage.

export const EVENT_LABEL = { awake: 'Awake', backToBed: 'Back to Bed' };

// Ordered by escalation (index = severity), matching the Swift enum order.
export const REMEDIES = [
  ['justWalking', 'Just walking'],
  ['shortColdWalk', 'Short walk on cold floor'],
  ['longColdWalk', 'Long walk finding very cold floor'],
  ['longTimeOnColdFloors', 'Long time on cold floors or walking'],
  ['icePack', 'Ice pack'],
  ['settleWithIce', 'Significant time to settle with ice etc.'],
];
export const remedyLabel = k => (REMEDIES.find(r => r[0] === k) || [, ''])[1];
const remedyRank = k => REMEDIES.findIndex(r => r[0] === k);

// Dalle's personal anchors for the 0–10 scale.
export const PAIN = ['No Pain', 'Slightly Numb', 'Significantly Numb', 'Slight Tingle', 'Medium Tingle',
  'Severe Tingling', 'Minor Jolts', 'Severe Jolts', 'Minor Cutting Pain', 'Severe Cutting Pain', 'Fuck Me Pain'];

export const THEMES = [
  ['darkRed', 'Dark Red', [204, 41, 31]],
  ['amber', 'Amber', [242, 158, 64]],
  ['gold', 'Gold', [217, 184, 64]],
  ['green', 'Green', [115, 179, 89]],
  ['teal', 'Teal', [77, 179, 166]],
  ['blue', 'Blue', [102, 153, 230]],
  ['purple', 'Purple', [166, 115, 230]],
  ['rose', 'Rose', [230, 115, 153]],
];

/** Start of the night `date` belongs to: nights run from startHour to startHour next day (local time). */
export function nightStart(date, startHour) {
  const d = new Date(date);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startHour, 0, 0, 0);
  if (d.getHours() < startHour) s.setDate(s.getDate() - 1);
  return s;
}

/** Groups events (sorted ascending) into nights, most recent first. */
export function groupNights(events, startHour) {
  const map = new Map();
  for (const e of events) {
    const k = nightStart(e.timestamp, startHour).getTime();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([k, evs]) => ({ start: new Date(k), events: evs }));
}

/** Pairs awake → back-to-bed intervals; a final unclosed AWAKE is counted but excluded from durations. */
export function metrics(events) {
  const r = { wakeCount: 0, totalAwake: 0, longestAwake: 0, endsWithOpenAwake: false,
    painMin: null, painMax: null, painAverage: null, highestRemedy: null };
  let open = null;
  const close = end => {
    if (open == null) return;
    const dur = Math.max(0, end - open);
    r.totalAwake += dur; r.longestAwake = Math.max(r.longestAwake, dur); open = null;
  };
  for (const e of events) {
    const t = e.timestamp.getTime();
    if (e.type === 'awake') { close(t); r.wakeCount++; open = t; }
    else close(t);
  }
  r.endsWithOpenAwake = open != null;
  const pains = events.map(e => e.painScore).filter(p => p != null);
  if (pains.length) {
    r.painMin = Math.min(...pains); r.painMax = Math.max(...pains);
    r.painAverage = pains.reduce((a, b) => a + b, 0) / pains.length;
  }
  const rems = events.map(e => e.remedy).filter(Boolean);
  if (rems.length) r.highestRemedy = rems.reduce((a, b) => remedyRank(b) > remedyRank(a) ? b : a);
  return r;
}

/** "XhYm", e.g. 1h25m. */
export function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export const clipboardLine = m =>
  `Wakes: ${m.wakeCount} | Awake: ${fmtDuration(m.totalAwake)} | Longest: ${fmtDuration(m.longestAwake)}`;

/** The only event type that can be logged next, from tonight's last event. */
export function nextType(events, startHour, now = new Date()) {
  const n = nightStart(now, startHour).getTime();
  const tonight = events.filter(e => nightStart(e.timestamp, startHour).getTime() === n);
  const last = tonight[tonight.length - 1];
  return !last || last.type === 'backToBed' ? 'awake' : 'backToBed';
}

export function wakeCountTonight(events, startHour, now = new Date()) {
  const n = nightStart(now, startHour).getTime();
  return events.filter(e => e.type === 'awake' && nightStart(e.timestamp, startHour).getTime() === n).length;
}

// ---- CSV (same columns as the iOS exports) ----
const esc = f => /[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f;
const isoLocal = d => {
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(a / 60 | 0)}:${p(a % 60)}`;
};
const ymd = d => isoLocal(d).slice(0, 10);

export function eventsCSV(events) {
  const lines = ['timestamp,type,painScore,remedy,note'];
  for (const e of events) lines.push([isoLocal(e.timestamp), e.type, e.painScore ?? '', esc(remedyLabel(e.remedy) || ''), esc(e.note || '')].join(','));
  return lines.join('\n');
}

export function summaryCSV(nights) {
  const lines = ['date,wakes,awakeTime,longest,painMin,painMax,painAvg,highestRemedy'];
  for (const n of [...nights].reverse()) {
    const m = metrics(n.events);
    lines.push([ymd(n.start), m.wakeCount, fmtDuration(m.totalAwake), fmtDuration(m.longestAwake),
      m.painMin ?? '', m.painMax ?? '', m.painAverage == null ? '' : m.painAverage.toFixed(1), esc(remedyLabel(m.highestRemedy) || '')].join(','));
  }
  return lines.join('\n');
}
