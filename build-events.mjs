#!/usr/bin/env node
// GWI DFW Events updater — runs once a day in GitHub Actions (see .github/workflows/events.yml).
//
//  1. Reads your ticks in the "DFW Events — review list" GitHub issue (ticked = show on the site).
//  2. Checks every site in data/sources.json for upcoming events, using whatever the site offers:
//     The Events Calendar (WordPress) feed, structured event data (JSON-LD / embedded JSON),
//     iCal / Google Calendar feeds, or individual event pages.
//  3. Writes data/events.json (what golfweatheriq.com shows) = data/curated.json + approved finds.
//  4. Rewrites the review issue and comments when something new needs your OK.
//
// MODE=reconcile (used when you edit the issue) skips step 2 and just applies your ticks.
// No packages needed — plain Node 20.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const MODE = process.env.MODE || 'full';
const DATA = process.env.DATA_DIR || 'data';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || '';
const API = process.env.GITHUB_API || 'https://api.github.com';
const ISSUE_TITLE = 'DFW Events — review list';
const UA = 'Mozilla/5.0 (compatible; GolfWeatherIQ-EventsBot/1.0; +https://golfweatheriq.com)';
const TODAY = process.env.TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const HORIZON = addDays(TODAY, 400);
const MAX_DETAIL_PAGES = 25;
const MAX_IMG_LOOKUPS = 40;

// ---------- areas / DFW cities ----------
const AREA_CITIES = {
  dallas: ['Dallas', 'Farmers Branch', 'Addison', 'Lancaster', 'DeSoto', 'Cedar Hill', 'Duncanville', 'University Park', 'Highland Park', 'Balch Springs', 'Hutchins', 'Glenn Heights'],
  fortworth: ['Fort Worth', 'Benbrook', 'Weatherford', 'Aledo', 'Granbury', 'Willow Park', 'Azle', 'Burleson', 'Westworth', 'Westworth Village', 'Cleburne', 'Crowley', 'White Settlement', 'Saginaw', 'Lake Worth', 'River Oaks', 'Hudson Oaks'],
  mid: ['Arlington', 'Grand Prairie', 'Grapevine', 'Irving', 'Las Colinas', 'Coppell', 'Euless', 'Bedford', 'Hurst', 'Colleyville', 'Southlake', 'Keller', 'North Richland Hills', 'Richland Hills', 'Haltom City', 'Mansfield', 'Trophy Club', 'Roanoke', 'Westlake', 'Watauga', 'Kennedale'],
  north: ['Frisco', 'Plano', 'McKinney', 'Allen', 'Carrollton', 'The Colony', 'Lantana', 'Flower Mound', 'Denton', 'Richardson', 'Lewisville', 'Little Elm', 'Prosper', 'Celina', 'Gunter', 'Sherman', 'Aubrey', 'Argyle', 'Corinth', 'Highland Village', 'Murphy', 'Wylie', 'Fairview', 'Lucas', 'Anna', 'Melissa', 'Parker', 'Double Oak', 'Hickory Creek', 'Sanger', 'Pilot Point'],
  east: ['Rockwall', 'Royse City', 'Mesquite', 'Garland', 'Rowlett', 'Sachse', 'Forney', 'Crandall', 'Heath', 'Terrell', 'Sunnyvale', 'Ferris', 'Waxahachie', 'Midlothian', 'Red Oak', 'Seagoville', 'Fate', 'Kaufman', 'Ennis'],
};
const CITY_AREA = new Map();
for (const [area, list] of Object.entries(AREA_CITIES)) for (const c of list) CITY_AREA.set(c.toLowerCase(), area);
function findCity(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z ]+/g, ' ') + ' ';
  let best = '';
  for (const c of CITY_AREA.keys()) if (t.includes(' ' + c + ' ') && c.length > best.length) best = c;
  return best ? best.replace(/\b\w/g, (m) => m.toUpperCase()).replace('Mckinney', 'McKinney').replace('Desoto', 'DeSoto') : '';
}
const areaOf = (city) => CITY_AREA.get(String(city || '').toLowerCase()) || 'multi';

// ---------- filters / categories ----------
const EXCLUDE = /\b(member[- ]?guest|members?[- ]only|member event|mga|wga|lga|sga|board meeting|course (is )?closed|closure|closed\b|aerif\w*|overseed\w*|maintenance|frost delay|cart path|staff (meeting|party)|private (event|party|outing)|tee sheet|league results|results posted|(men'?s|women'?s|ladies|senior|seniors'?) (golf )?(association|club|league)( (play|meeting|event))?|mens? day|ladies day|happy hour|trivia night|karaoke|bingo)\b/i;
// Public-facing event words: calendar finds with one of these show automatically; others wait for your OK.
const PUBLIC_EVENT = /scramble|tournament|classic|invitational|championship|\bopen\b|shootout|shoot-out|clinic|lesson|camp\b|fitting|demo\b|expo\b|glow|night golf|junior|kids?\b|family|trivia|concert|festival|market\b|fundrais|charity|benefit|\bcup\b|challenge|qualif|pro[- ]am|couples|par[- ]?tee|halloween|spook|turkey|christmas|santa|toys for tots|veterans|watch party|grand opening|best ball|captain'?s choice|two[- ]man|2[- ]person|4[- ]person|member[- ]for[- ]a[- ]day/i;
// Booking-sheet noise: private outings, school teams, placeholders, leagues (leagues live in the weekly list).
const PRIVATE = /tentative|outside event|\bouting\b|\bblock(ed)?\b|\(tee times\)|private|\bhs\b|high school|\bisd\b|middle school|varsity|\bjv\b|practice|\blodge\b|church|graduation|wedding|reception|banquet|meeting|holiday party|staff|\bleague\b|lessons? (by|with) appointment|booked|reserved|hold\b/i;
const GENERIC_TITLE = /^(events?( calendar)?|calendar|home|untitled|tbd|tba|event details?|upcoming events|news)$/i;
const GOLFY = /golf|scramble|tee\b|tee[- ]off|links|fore\b|putt|shootout|pga|lpga|driving range|topgolf|simulator/i;
function categorize(text) {
  const t = String(text || '');
  if (/junior|kids?\b|youth|first tee|family|camp\b|children/i.test(t)) return 'junior';
  if (/fitting|demo day|demo event|expo\b|trade show|trunk show|swap meet|market\b/i.test(t)) return 'expo';
  if (/clinic|lesson|golf school|academy|instruction|workshop/i.test(t)) return 'clinic';
  if (/championship|amateur|qualif|collegiate|invitational|match play|stroke play|club champ|\btour\b|pro[- ]am/i.test(t)) return 'competition';
  if (/scramble|tournament|classic|charity|benefit|fundrais|shootout|shoot-out|best ball|\bcup\b|two[- ]man|2[- ]person|4[- ]person|captain'?s choice|\bopen\b/i.test(t)) return 'scramble';
  if (/special|discount|\bdeal\b|\bsale\b|half[- ]price|promo/i.test(t)) return 'deal';
  return 'fun';
}

// ---------- small helpers ----------
function addDays(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', trade: '™', reg: '®', copy: '©' };
function decode(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function strip(html) {
  return decode(String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
const oneLine = (s) => strip(s).replace(/\s+/g, ' ').trim();
function clip(s, n = 260) { s = oneLine(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
function titleTokens(t) {
  const STOP = new Set('the a of and at for in on annual golf tournament event 2026 2027 2028 st nd rd th'.split(' '));
  return new Set(String(t).toLowerCase().replace(/\(.*?\)/g, ' ').match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w)) || []);
}
function similar(a, b) {
  const A = titleTokens(a), B = titleTokens(b); if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.6;
}
function absUrl(u, base) { if (!u) return ''; try { return new URL(decode(u), base).href; } catch { return ''; } }
function fmtTime(h, m) { const ap = h >= 12 ? 'PM' : 'AM'; const hh = h % 12 || 12; return `${hh}:${String(m).padStart(2, '0')} ${ap}`; }

// Parse many date shapes → { date:'YYYY-MM-DD', time:'8:00 AM'|'' } in Central time.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseWhen(v, { allDay = false } = {}) {
  if (!v) return null;
  let s = String(v).trim();
  let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(s))) { // iCal basic format
    if (m[7]) s = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
    else return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] && !allDay ? fmtTime(+m[4], +m[5]) : '' };
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s))) {
    if (!m[6]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] && !allDay && !(m[4] === '00' && m[5] === '00') ? fmtTime(+m[4], +m[5]) : '' };
    const d = new Date(s.replace(' ', 'T'));
    if (isNaN(d)) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
    const h = +parts.hour, mi = +parts.minute;
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: allDay || (h === 0 && mi === 0) ? '' : fmtTime(h, mi) };
  }
  return parseTextDate(s);
}
const TEXT_DATE = /(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)(?:,?\s*(?:at|@|-|–)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?)?/i;
function parseTextDate(s) {
  const m = TEXT_DATE.exec(s); if (!m) return null;
  const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; const d = +m[2];
  if (!mo || d < 1 || d > 31) return null;
  let time = '';
  if (m[4]) { let h = +m[4] % 12; if (m[6].toLowerCase() === 'p') h += 12; time = fmtTime(h, +(m[5] || 0)); }
  return { date: `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, time, index: m.index };
}

// ---------- fetching ----------
async function get(url, { accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', timeout = 20000 } = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buf.byteLength > 4e6 ? buf.slice(0, 4e6) : buf);
    return { ok: res.ok, status: res.status, text, url: res.url || url, type: res.headers.get('content-type') || '' };
  } catch (err) {
    return { ok: false, status: 0, text: '', url, error: String(err?.cause?.code || err?.name || err) };
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ---------- extractors ----------
// 1) The Events Calendar (WordPress) REST feed
async function tribeFeed(origin) {
  const out = [];
  let url = `${origin}/wp-json/tribe/events/v1/events?per_page=50&start_date=${TODAY}&end_date=${HORIZON}`;
  for (let page = 0; page < 4 && url; page++) {
    const r = await get(url, { accept: 'application/json' });
    if (!r.ok || !/^\s*\{/.test(r.text)) break;
    let j; try { j = JSON.parse(r.text); } catch { break; }
    if (!Array.isArray(j.events)) break;
    for (const e of j.events) {
      const allDay = !!e.all_day;
      const s = parseWhen(e.start_date, { allDay }), en = parseWhen(e.end_date, { allDay });
      out.push({ title: oneLine(e.title), start: s?.date, end: en?.date !== s?.date ? en?.date : '', time: s?.time || '', url: e.url, img: e.image?.url || '', desc: clip(e.excerpt || e.description), venue: oneLine(e.venue?.venue || ''), city: oneLine(e.venue?.city || ''), how: 'events-calendar' });
    }
    url = j.next_rest_url || '';
  }
  return out;
}

// 2) Structured data: JSON-LD blocks and embedded JSON (Eventbrite, Wix, Next.js…)
function braceSlice(text, start) {
  let depth = 0, inStr = false, q = '', esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; q = c; } else if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return '';
}
function jsonBlobs(html) {
  const blobs = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) blobs.push(m[1]);
  for (const m of html.matchAll(/(?:__SERVER_DATA__|__NEXT_DATA__|__INITIAL_STATE__|__PRELOADED_STATE__)\s*=\s*/g)) { const s = braceSlice(html, m.index + m[0].length); if (s) blobs.push(s); }
  const out = [];
  for (const b of blobs) { try { out.push(JSON.parse(b.trim().replace(/^<!--|-->$/g, ''))); } catch { /* not JSON */ } }
  return out;
}
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return undefined; };
function imgOf(v) { if (!v) return ''; if (typeof v === 'string') return v; if (Array.isArray(v)) return imgOf(v[0]); return v.url || v.contentUrl || v.src || v.original?.url || ''; }
function structuredEvents(html, base) {
  const out = []; const seen = new Set(); let visited = 0;
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 14 || visited++ > 60000) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    const type = [].concat(o['@type'] || []).join(' ');
    const name = pick(o, 'name', 'title');
    const start = pick(o, 'startDate', 'start_date', 'scheduling.config.startDate', 'dateAndTimeSettings.startDate', 'start.local', 'startDateTime', 'start_datetime');
    if (typeof name === 'string' && start && (/Event/.test(type) || pick(o, 'url', 'event_url', 'slug', 'eventPageUrl'))) {
      const startStr = typeof start === 'string' ? start : '';
      const timeExtra = pick(o, 'start_time');
      const s = parseWhen(startStr && timeExtra && /^\d{4}-\d{2}-\d{2}$/.test(startStr) ? `${startStr} ${timeExtra}` : startStr);
      const en = parseWhen(pick(o, 'endDate', 'end_date', 'scheduling.config.endDate', 'end.local') || '');
      let url = pick(o, 'url', 'event_url', 'eventPageUrl') || '';
      if (!url && o.slug) { try { url = new URL(base).origin + '/event-details/' + o.slug; } catch { /* ignore */ } }
      const loc = o.location || o.primary_venue || o.venue || {};
      const addr = loc.address || {};
      const key = name + '|' + s?.date;
      if (s?.date && !seen.has(key)) {
        seen.add(key);
        out.push({
          title: oneLine(name), start: s.date, end: en?.date && en.date !== s.date ? en.date : '', time: s.time || '',
          url: absUrl(url, base), img: imgOf(o.image || o.mainImage || o.logo), desc: clip(o.description || o.summary || o.about || ''),
          venue: oneLine(typeof loc === 'string' ? loc : loc.name || ''), city: oneLine(typeof addr === 'string' ? findCity(addr) : addr.addressLocality || addr.city || loc.city || ''),
          how: 'structured-data',
        });
      }
    }
    for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
  };
  for (const j of jsonBlobs(html)) walk(j, 0);
  return out;
}

// 3) iCal feeds (incl. Google Calendar embeds)
function icalLinks(html, base) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const h = decode(m[1]);
    if (/\.ics(\?|$)|[?&]ical=1|^webcal:|icals\.export|\/ical\/|outlook-ical=1/i.test(h)) links.add(absUrl(h.replace(/^webcal:/i, 'https:'), base));
  }
  for (const m of html.matchAll(/calendar\.google\.com\/calendar\/(?:u\/\d+\/)?embed\?[^"'\s>]*/gi)) {
    for (const s of decode(m[0]).matchAll(/[?&]src=([^&]+)/g)) links.add(`https://calendar.google.com/calendar/ical/${encodeURIComponent(decodeURIComponent(s[1]))}/public/basic.ics`);
  }
  return [...links].filter(Boolean).slice(0, 4);
}
function parseIcal(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = []; let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {}; else if (line === 'END:VEVENT') { if (ev) out.push(ev); ev = null; }
    else if (ev) { const i = line.indexOf(':'); if (i > 0) { const [k, ...params] = line.slice(0, i).split(';'); ev[k.toUpperCase()] = { v: line.slice(i + 1), p: params.join(';') }; } }
  }
  const unesc = (s) => String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
  return out.filter((e) => e.DTSTART && !e.RRULE && e.STATUS?.v !== 'CANCELLED').map((e) => {
    const allDay = /VALUE=DATE(?!-)/.test(e.DTSTART.p);
    const s = parseWhen(e.DTSTART.v, { allDay });
    let en = e.DTEND ? parseWhen(e.DTEND.v, { allDay }) : null;
    if (allDay && en?.date) en.date = addDays(en.date, -1); // iCal all-day end is exclusive
    const loc = unesc(e.LOCATION?.v);
    return { title: unesc(e.SUMMARY?.v), start: s?.date, end: en?.date && en.date !== s?.date ? en.date : '', time: s?.time || '', url: e.URL?.v || '', img: '', desc: clip(unesc(e.DESCRIPTION?.v)), venue: loc.split(',')[0], city: findCity(loc), how: 'ical' };
  });
}

// 4) Individual event pages (GolfNow/Joomla "eventdetail" sites, Wix "event-details", etc.)
function detailLinks(html, base) {
  const links = new Map();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const h = decode(m[1]);
    if (/\/eventdetail\/\d+|\/event-details\/[\w-]+|[?&]task=icalrepeat\.detail|\/events?\/[\w-]+\/\d{4}-\d{2}-\d{2}\/?$/i.test(h)) {
      const u = absUrl(h, base); if (!u) continue;
      const key = u.replace(/[?#].*$/, '').replace(/\/-\/.*$/, '');
      if (!links.has(key)) links.set(key, u);
    }
  }
  return [...links.values()].slice(0, MAX_DETAIL_PAGES);
}
function metaContent(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0]; return tag ? decode(/content=["']([^"']*)["']/i.exec(tag)?.[1] || '') : '';
}
async function eventFromPage(url, src) {
  const r = await get(url); if (!r.ok) return null;
  const sd = structuredEvents(r.text, r.url); if (sd.length) return { ...sd[0], url: sd[0].url || r.url, how: 'event-page' };
  const cands = [...r.text.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => oneLine(m[1])).concat(oneLine(metaContent(r.text, 'og:title')), oneLine(/<title>([\s\S]*?)<\/title>/i.exec(r.text)?.[1] || ''));
  const title = (cands.map((t) => t.replace(/\s+\|\s+[^|]+$/, '').trim()).find((t) => t && t.length > 3 && t.length < 120 && !GENERIC_TITLE.test(t) && !/calendar|\|/i.test(t) && !(src && t.toLowerCase() === src.name.toLowerCase())) || '');
  const body = strip(r.text.replace(/<head[\s\S]*?<\/head>|<(header|nav|footer|aside)[\s\S]*?<\/\2>/gi, ' '));
  const at = title ? Math.max(0, body.toLowerCase().indexOf(title.toLowerCase().slice(0, 30))) : 0;
  const when = parseTextDate(body.slice(at)) || parseTextDate(body);
  if (!title || !when) return null;
  const desc = metaContent(r.text, 'og:description') || metaContent(r.text, 'description') || body.slice(at + title.length, at + title.length + 600).replace(TEXT_DATE, ' ');
  return { title, start: when.date, end: '', time: when.time, url: r.url, img: absUrl(metaContent(r.text, 'og:image'), r.url), desc: clip(desc), venue: '', city: '', how: 'event-page' };
}

// ---------- per-source crawl ----------
async function crawlSource(src) {
  const rep = { name: src.name, url: src.url, methods: [], found: 0, kept: 0, error: '' };
  let items = [];
  let origin = ''; try { origin = new URL(src.url).origin; } catch { rep.error = 'bad url'; return { rep, items }; }
  if (src.type !== 'listing') {
    const t = await tribeFeed(origin);
    if (t.length) { items.push(...t); rep.methods.push('events-calendar'); }
  }
  const page = await get(src.url);
  if (!page.ok) rep.error = page.error || `HTTP ${page.status}`;
  else {
    const sd = structuredEvents(page.text, page.url);
    if (sd.length) { items.push(...sd); rep.methods.push('structured-data'); }
    for (const link of icalLinks(page.text, page.url)) {
      const r = await get(link, { accept: 'text/calendar,*/*' });
      if (r.ok && /BEGIN:VCALENDAR/.test(r.text)) { const ev = parseIcal(r.text); if (ev.length) { items.push(...ev); rep.methods.push('ical'); } }
    }
    if (!items.length) {
      const links = detailLinks(page.text, page.url);
      const found = (await pool(links, 4, (u) => eventFromPage(u, src))).filter(Boolean);
      if (found.length) { items.push(...found); rep.methods.push('event-pages'); }
    }
  }
  rep.found = items.length;
  rep.methods = [...new Set(rep.methods)];
  const official = src.type !== 'listing';
  items = items.filter((e) => e.title && e.start).map((e) => {
    const city = e.city && CITY_AREA.has(e.city.toLowerCase()) ? e.city : (official ? src.city : findCity(`${e.city} ${e.venue} ${e.desc}`));
    return { ...e, review: !!src.review, title: e.title.replace(/\s+/g, ' ').trim(), venue: official ? (e.venue && !/^(tbd|online)$/i.test(e.venue) ? e.venue : src.name) : e.venue, city, source: src.name, official };
  });
  // the same title 3+ times from one site = a recurring program (covered by the weekly list)
  const counts = new Map(); for (const e of items) { const k = [...titleTokens(e.title)].sort().join(' '); counts.set(k, (counts.get(k) || 0) + 1); }
  items = items.map((e) => ({ ...e, recurring: counts.get([...titleTokens(e.title)].sort().join(' ')) >= 3 }));
  return { rep, items };
}

function keep(e) {
  const end = e.end || e.start;
  if (!e.start || e.start > HORIZON || end < TODAY) return 'past or too far out';
  if (e.start < addDays(TODAY, -21)) return 'long-running';
  if (EXCLUDE.test(`${e.title}`) || PRIVATE.test(e.title)) return 'members / private / non-golf';
  if (GENERIC_TITLE.test(e.title.trim()) || e.title.trim().length < 4) return 'no real title';
  if (e.recurring || /\b(mon|tues|wednes|thurs|fri|satur|sun)day (night|morning|afternoon|evening|twilight)\b|\bweekly\b|every (mon|tue|wed|thu|fri|sat|sun)/i.test(e.title)) return 'recurring';
  if (!e.official) {
    if (!GOLFY.test(`${e.title} ${e.desc} ${e.venue}`)) return 'not golf';
    if (!CITY_AREA.has(String(e.city).toLowerCase())) return 'outside DFW';
  }
  return '';
}

// ---------- GitHub issue (review list) ----------
async function gh(method, path, body) {
  const r = await fetch(`${API}/repos/${REPO}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'gwi-events', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`GitHub ${method} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
async function findIssue() {
  for (let page = 1; page <= 5; page++) {
    const list = await gh('GET', `/issues?state=open&per_page=100&page=${page}`);
    const hit = list.find((i) => i.title === ISSUE_TITLE && !i.pull_request); if (hit) return hit;
    if (list.length < 100) break;
  }
  return null;
}
function readTicks(body) {
  const ticks = new Map();
  for (const m of String(body || '').matchAll(/^\s*[-*] \[( |x|X)\].*?<!--\s*id:([a-f0-9]{10})\s*-->/gm)) ticks.set(m[2], m[1] !== ' ');
  return ticks;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (ymd) => { const [y, m, d] = ymd.split('-'); return `${MON[+m - 1]} ${+d}` + (y !== TODAY.slice(0, 4) ? `, ${y}` : ''); };
function issueLine(e) {
  const md = (s) => String(s).replace(/([\[\]\\*_`<>|])/g, '\\$1');
  const where = [e.venue, e.city].filter(Boolean).map(md).join(', ');
  return `- [${e.shown ? 'x' : ' '}] **${short(e.start)}** — ${md(e.title)}${where ? ` · ${where}` : ''}${e.url ? ` — [link](${e.url})` : ''} <!-- id:${e.id} -->`;
}
function issueBody(items, report) {
  const up = items.filter((e) => !e.gone && (e.end || e.start) >= TODAY).sort((a, b) => a.start.localeCompare(b.start));
  const review = up.filter((e) => !e.official).slice(0, 120);
  const auto = up.filter((e) => e.official).slice(0, 150);
  const ok = report.filter((r) => r.kept > 0).length;
  return [
    'Tick a box to **show** that event on golfweatheriq.com · untick to **hide** it.',
    'Your changes go live within about 15 minutes. The list refreshes every morning.',
    '',
    `### Needs your OK (${review.filter((e) => !e.shown).length} waiting)`,
    '_From listing sites, booking-style calendars, or titles that don\'t look like a public event. Hidden until you tick them._',
    ...(review.length ? review.map(issueLine) : ['_Nothing right now._']),
    '',
    `### From course & venue calendars (${auto.length})`,
    '_Pulled from each course\'s own calendar, so they show automatically. Untick anything that doesn\'t belong._',
    ...(auto.length ? auto.map(issueLine) : ['_Nothing right now._']),
    '',
    `<sub>Last check: ${TODAY} · ${ok} of ${report.length} sites had readable upcoming events · details in data/crawl-report.json</sub>`,
  ].join('\n');
}

// ---------- main ----------
async function readJson(path, fallback) { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; } }

async function main() {
  const curated = await readJson(`${DATA}/curated.json`, { events: [], weekly: [], tba: [], opening: [] });
  const state = await readJson(`${DATA}/state.json`, { items: {} });
  const superseded = new Set();
  let report = (await readJson(`${DATA}/crawl-report.json`, { sources: [] })).sources || [];

  // 1. apply ticks from the review issue
  let issue = null;
  if (TOKEN && REPO) {
    try {
      issue = await findIssue();
      if (issue) { let n = 0; for (const [id, on] of readTicks(issue.body)) if (state.items[id] && state.items[id].shown !== on) { state.items[id].shown = on; state.items[id].touched = true; n++; } console.log(`Review list: applied ${n} change(s).`); }
    } catch (e) { console.warn('Could not read the review issue:', e.message); }
  }

  const fresh = { review: [], auto: [] };
  if (MODE !== 'reconcile') {
    // 2. crawl
    const { sources } = await readJson(`${DATA}/sources.json`, { sources: [] });
    console.log(`Checking ${sources.length} sites…`);
    const results = await pool(sources, 6, crawlSource);
    report = [];
    const curatedUp = (curated.events || []).filter((e) => (e.end || e.start) >= TODAY);
    const failed = new Set(results.filter((r) => r.rep.error && !r.items.length).map((r) => r.rep.name));
    const seenNow = new Set();
    for (const { rep, items } of results) {
      for (const e of items) {
        const why = keep(e); if (why) continue;
        // already hand-listed? same title on a date inside the hand-listed event's dates (±2 days for a course's own calendar)
        const near = curatedUp.find((c) => similar(c.title, e.title) && e.start >= addDays(c.start, e.official ? -2 : 0) && e.start <= addDays(c.end || c.start, e.official ? 2 : 0));
        if (near) {
          if (near.start === e.start || !e.official || e.review) { rep.kept++; continue; }
          superseded.add(near.id); // the course's own calendar has a different date → trust it over the hand-listed copy
        }
        let id = sha(`${e.start}|${[...titleTokens(e.title)].sort().join(' ')}`);
        const dup = Object.values(state.items).find((x) => x.id !== id && x.start === e.start && similar(x.title, e.title));
        if (dup) { if (dup.official || !e.official) id = dup.id; else { dup.gone = true; } }
        if (seenNow.has(id)) continue;
        seenNow.add(id); rep.kept++;
        const prev = state.items[id];
        const rec = { id, title: e.title, start: e.start, end: e.end || '', time: e.time || '', venue: e.venue || '', city: e.city || '', area: areaOf(e.city), cat: categorize(`${e.title} ${e.desc}`), desc: e.desc || '', url: e.url || '', img: e.img || prev?.img || '', source: e.source, official: e.official, how: e.how, confirmed: true, firstSeen: prev?.firstSeen || TODAY, lastSeen: TODAY };
        const autoShow = e.official && !e.review && PUBLIC_EVENT.test(e.title);
        rec.official = e.official && !e.review && autoShow; // anything not auto-shown sits in "Needs your OK"
        rec.shown = prev?.touched ? prev.shown : autoShow;
        if (prev?.touched) rec.touched = true;
        state.items[id] = rec;
        if (!prev) (rec.official ? fresh.auto : fresh.review).push(rec);
      }
      report.push(rep);
    }
    // events no longer listed anywhere for 3+ days are treated as removed/cancelled
    state.superseded = [...superseded];
    // not listed any more: gone right away if its site answered; after 3 days if the site was down
    for (const it of Object.values(state.items)) if (!seenNow.has(it.id)) it.gone = !failed.has(it.source) || it.lastSeen < addDays(TODAY, -3);
    // look up flyer images for new finds that have none
    const needImg = Object.values(state.items).filter((e) => !e.img && e.url && !e.imgTried && (e.end || e.start) >= TODAY).slice(0, MAX_IMG_LOOKUPS);
    await pool(needImg, 4, async (e) => { e.imgTried = true; const r = await get(e.url); if (r.ok) e.img = absUrl(metaContent(r.text, 'og:image'), r.url); });
    console.log(report.map((r) => `${r.kept ? '✓' : '·'} ${r.name}: ${r.kept} kept / ${r.found} found ${r.methods.join('+')}${r.error ? ' — ' + r.error : ''}`).join('\n'));
  }

  // drop finished events from the state file
  for (const [id, it] of Object.entries(state.items)) if ((it.end || it.start) < addDays(TODAY, -2)) delete state.items[id];

  // 3. publish
  const found = Object.values(state.items).filter((e) => e.shown && !e.gone).map(({ id, title, start, end, time, venue, city, area, cat, desc, url, img, confirmed, source }) => ({ id: 'f-' + id, title, start, end, time, venue, city, area, cat, desc, url, img, confirmed, source }));
  const events = [...(curated.events || []).filter((e) => (e.end || e.start) >= addDays(TODAY, -1) && !(state.superseded || []).includes(e.id)), ...found].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  const out = { updated: TODAY, region: curated.region || 'Dallas–Fort Worth', events, weekly: curated.weekly || [], tba: curated.tba || [], opening: curated.opening || [], stats: { ...(curated.stats || {}), sitesChecked: report.length, sitesWithEvents: report.filter((r) => r.kept > 0).length, fromCalendars: found.length } };
  await fs.writeFile(`${DATA}/events.json`, JSON.stringify(out));
  await fs.writeFile(`${DATA}/state.json`, JSON.stringify(state, null, 1));
  if (MODE !== 'reconcile') await fs.writeFile(`${DATA}/crawl-report.json`, JSON.stringify({ checked: TODAY, sources: report }, null, 1));
  console.log(`Published ${events.length} events (${found.length} from calendars). New: ${fresh.auto.length} auto-added, ${fresh.review.length} waiting for review.`);

  // 4. update the review issue (not in reconcile mode, so we never overwrite ticks you're making)
  if (TOKEN && REPO && MODE !== 'reconcile') {
    try {
      const body = issueBody(Object.values(state.items), report);
      if (!issue) issue = await gh('POST', '/issues', { title: ISSUE_TITLE, body });
      else await gh('PATCH', `/issues/${issue.number}`, { body });
      if (fresh.review.length || fresh.auto.length) {
        const lines = [];
        if (fresh.review.length) lines.push(`🆕 **${fresh.review.length} new event${fresh.review.length > 1 ? 's' : ''} ${fresh.review.length > 1 ? 'need' : 'needs'} your OK** (tick to show):`, ...fresh.review.slice(0, 15).map((e) => `- ${short(e.start)} — ${e.title}${e.city ? ` (${e.city})` : ''}`));
        if (fresh.auto.length) lines.push('', `✅ ${fresh.auto.length} new event${fresh.auto.length > 1 ? 's were' : ' was'} added from course calendars (untick in the list above to hide):`, ...fresh.auto.slice(0, 15).map((e) => `- ${short(e.start)} — ${e.title} (${e.venue})`));
        await gh('POST', `/issues/${issue.number}/comments`, { body: lines.join('\n') });
      }
    } catch (e) { console.warn('Could not update the review issue:', e.message); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
