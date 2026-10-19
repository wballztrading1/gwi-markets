#!/usr/bin/env node
// GWI Golf Deals checker — runs daily in GitHub Actions (.github/workflows/deals.yml).
// Reads the hand-picked list in data/deals-curated.json, re-checks every deal page for the current
// price and stock, and writes data/deals.json (what golfweatheriq.com shows).
//  - sold out / page gone            -> hidden
//  - price went up and discount < 25% -> hidden
//  - page couldn't be read (blocked)  -> kept at the last verified price for up to 10 days, then hidden
//  - deal listed without a photo      -> the product image is taken from the store page when found
//  - New Gear (curated "releases")    -> shown for 10 days from the first day the checker sees it, then dropped;
//                                        hidden early if the page is gone or sold out (no discount needed)
// No packages needed — plain Node 20.
import fs from 'node:fs/promises';

const DATA = process.env.DATA_DIR || 'data';
const TODAY = process.env.TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const MIN_PCT = 25, STALE_DAYS = 10, NEW_GEAR_DAYS = 10;
const PLAY = new Set(['tee-times', 'range', 'lesson', 'trip']);

const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

async function get(url, accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8') {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const text = (await res.text()).slice(0, 3e6);
    return { ok: res.ok, status: res.status, text, url: res.url || url };
  } catch (e) { return { ok: false, status: 0, text: '', url, error: String(e?.cause?.code || e?.name || e) }; }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// ---- price / stock extraction ----
function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { out.push(JSON.parse(m[1].trim())); } catch { /* skip */ } }
  return out;
}
function findOffers(o, acc = [], depth = 0) {
  if (!o || typeof o !== 'object' || depth > 10) return acc;
  if (Array.isArray(o)) { o.forEach((x) => findOffers(x, acc, depth + 1)); return acc; }
  const t = [].concat(o['@type'] || []).join(' ');
  if (/Offer/.test(t) || (o.price != null && (o.priceCurrency || o.availability))) acc.push(o);
  for (const k in o) if (o[k] && typeof o[k] === 'object') findOffers(o[k], acc, depth + 1);
  return acc;
}
function meta(html, prop) {
  const tag = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${prop}["'][^>]*>`, 'i').exec(html)?.[0];
  return tag ? (/content=["']([^"']*)["']/i.exec(tag)?.[1] || '') : '';
}
// ---- product image (only from real product pages; never logos or category banners) ----
const BAD_IMG = /\.svg(\?|$)|logo|placeholder|no[-_]?image|spacer|sprite|icon|banner/i;
function absUrl(u, base) { try { return u ? new URL(String(u).replace(/&amp;/g, '&'), base).href.replace(/^http:/, 'https:') : ''; } catch { return ''; } }
function findProduct(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 8) return null;
  if (Array.isArray(o)) { for (const x of o) { const p = findProduct(x, depth + 1); if (p) return p; } return null; }
  if (/Product/.test([].concat(o['@type'] || []).join(' '))) return o;
  for (const k of ['@graph', 'mainEntity', 'itemListElement']) if (o[k]) { const p = findProduct(o[k], depth + 1); if (p) return p; }
  return null;
}
function extractImage(html, base) {
  let img = '';
  for (const j of jsonLd(html)) { const p = findProduct(j); if (p && p.image) { const i = [].concat(p.image)[0]; img = typeof i === 'string' ? i : (i?.url || i?.contentUrl || ''); if (img) break; } }
  if (!img && /product/i.test(meta(html, 'og:type'))) img = meta(html, 'og:image');
  img = absUrl(img, base);
  return img && !BAD_IMG.test(img) ? img : '';
}
function extract(html) {
  // returns { price, inStock } — price may be null when not found
  const offers = jsonLd(html).flatMap((j) => findOffers(j));
  let prices = offers.map((o) => num(o.price ?? o.lowPrice)).filter(Boolean);
  let avail = offers.map((o) => String(o.availability || '')).filter(Boolean);
  if (!prices.length) { const p = num(meta(html, 'product:price:amount') || meta(html, 'og:price:amount') || meta(html, 'price')); if (p) prices = [p]; }
  if (!avail.length) { const a = meta(html, 'product:availability') || meta(html, 'og:availability'); if (a) avail = [a]; }
  const inStock = avail.length ? avail.some((a) => /InStock|in stock|instock|LimitedAvailability|PreOrder/i.test(a)) : null;
  return { price: prices.length ? Math.min(...prices) : null, inStock };
}
async function shopify(url) {
  // Shopify stores expose /products/<handle>.js with price (cents) + availability
  const m = /^(https?:\/\/[^/]+)(?:\/collections\/[^/]+)?(\/products\/[^/?#]+)/.exec(url); if (!m) return null;
  const r = await get(m[1] + m[2] + '.js', 'application/json');
  if (!r.ok || !/^\s*\{/.test(r.text)) return null;
  try {
    const j = JSON.parse(r.text);
    const avail = (j.variants || []).filter((v) => v.available);
    const pool_ = avail.length ? avail : j.variants || [];
    const price = pool_.length ? Math.min(...pool_.map((v) => v.price / 100)) : (j.price ? j.price / 100 : null);
    const image = absUrl(j.featured_image || (j.images || [])[0] || '', m[1]);
    return { price, inStock: avail.length > 0 || !!j.available, image: image && !BAD_IMG.test(image) ? image : '' };
  } catch { return null; }
}

// ---- same-product key (strict): brand + category + model words before the category word ----
// Used to borrow a photo from another listing of the SAME product, to compare stores, and by price alerts.
const STOP = new Set(['mens', 'men', 'golf', 'the', 'new', 'used', 'preowned', 'pre', 'owned', 'demo', 'open', 'box', 'closeout', 'certified', 'refurbished', 'sale']);
const CATWORD = /\b(drivers?|fairway\s+woods?|fairways?|woods?|hybrids?|rescue|irons?|iron\s+set|wedges?|putters?|golf\s+balls?|balls?|(?:stand|cart|carry)\s+bag|bag|rangefinder|laser|launch\s+monitor|gps|watch|shoes?|polo|pullover|pants|shorts|hoodie|jacket|vest)\b/;
export function pkey(d) {
  if (!d || PLAY.has(d.cat)) return '';
  const brand = String(d.brand || '').toLowerCase();
  let t = String(d.title || '').toLowerCase().replace(/scotty cameron/g, 'scottycameron');
  const lh = /left[\s-]*hand|\blh\b/.test(t);
  t = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').split(/\s+-\s+/)[0].replace(/[’']/g, '');
  const m = CATWORD.exec(t); if (!m) return '';
  const bw = new Set(brand.split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, '')));
  const words = t.slice(0, m.index).replace(/[-/]/g, '').split(/[^a-z0-9.]+/).filter((w) => w && !bw.has(w) && !STOP.has(w));
  if (!words.length) return '';
  return [brand, d.cat, words.join(' ') + (lh ? ' lh' : '')].join('|');
}

async function check(d) {
  const r = await get(d.url);
  if (r.status === 404 || r.status === 410) return { status: 'gone' };
  let found = null;
  if (/\/products\//.test(d.url)) found = await shopify(d.url);
  if (!found && r.ok) found = extract(r.text);
  if (found && !found.image && r.ok && !d.img) found.image = extractImage(r.text, r.url);
  if (!r.ok && !found) return { status: 'unreadable', http: r.status || r.error };
  if (/sold out|out of stock|no longer available|this product is unavailable/i.test(r.text.slice(0, 400000)) && found?.inStock == null) found = { ...(found || {}), inStock: false };
  return { status: 'ok', ...(found || {}) };
}

async function main() {
  let cur = await fs.readFile(`${DATA}/deals-curated.json`, 'utf8').then(JSON.parse).catch(() => null);
  if (!cur) {
    // first run: start from the list bundled with the website (deals-data.1.js)
    const r = await get(process.env.SITE_DATA_URL || 'https://golfweatheriq.com/deals-data.1.js', '*/*');
    const m = r.ok && /GWI_GOLF_DEALS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(r.text.trim());
    if (!m) { console.log('No deals-curated.json yet and the site copy is not reachable (upload the site first). Nothing to do.'); return; }
    cur = JSON.parse(m[1]); cur.researched = cur.researched || cur.updated || TODAY;
    await fs.writeFile(`${DATA}/deals-curated.json`, JSON.stringify(cur));
    console.log(`Bootstrapped deals-curated.json from the website (${(cur.deals || []).length} deals).`);
  }
  const prev = await fs.readFile(`${DATA}/deals-state.json`, 'utf8').then(JSON.parse).catch(() => ({ items: {} }));
  const deals = cur.deals || [];
  console.log(`Checking ${deals.length} deals…`);
  const results = await pool(deals, 5, (d) => (d.ends && d.ends < TODAY ? { status: 'expired' } : check(d)));
  const out = []; const report = { checked: TODAY, total: deals.length, live: 0, updated: 0, hidden: [], unreadable: 0 };
  deals.forEach((d, i) => {
    const r = results[i]; const st = prev.items[d.id] || {};
    if (st.price && st.price > d.price * 1.15) st.price = d.price; // undo a list-price misread saved by an earlier run
    // a fresh weekly research pass (new 'researched' date or changed listed price) re-confirms a deal
    const fresh = (cur.researched || '') > (st.verified || '') || st.listed !== d.price;
    let price = fresh ? d.price : (st.price ?? d.price), verified = fresh ? (cur.researched || TODAY) : st.verified, inStock = true, why = '';
    if (r.status === 'expired') why = 'offer ended';
    else if (r.status === 'gone') why = 'page removed';
    else if (r.status === 'unreadable') { report.unreadable++; if (verified < addDays(TODAY, -STALE_DAYS)) why = `not verifiable since ${verified}`; }
    else {
      if (r.inStock === false) why = 'sold out';
      // only trust a found price that is in a sane range of the listed one (guards against grabbing an accessory price)
      // a jump of 15%+ over the researched price usually means the page exposes the list price, not the sale price
      // (e.g. Carl's Golfland) -> keep the researched price and let the weekly research re-confirm it
      const unclear = r.price && r.price > d.price * 1.15;
      if (r.price && !unclear && r.price >= d.price * 0.4) { if (Math.abs(r.price - price) > 0.009) report.updated++; price = r.price; }
      if (unclear) report.unclear = (report.unclear || 0) + 1;
      else verified = TODAY;
      inStock = r.inStock !== false;
      if (unclear && verified < addDays(TODAY, -STALE_DAYS)) why = `price unclear since ${verified}`;
    }
    const pct = d.was ? Math.round((1 - price / d.was) * 100) : d.pct;
    if (!why && !PLAY.has(d.cat) && d.was && pct < MIN_PCT) why = `now only ${pct}% off`;
    // v2: remember a product photo found on the store page for deals listed without one
    const img = d.img || (r.status === 'ok' && r.image) || st.img || '';
    if (!d.img && img && !st.img) report.imagesFound = (report.imagesFound || 0) + 1;
    // v3: daily price history (one point per day, ~90 days) for "lowest in 30 days" / "dropped this week"
    const hist = (st.hist || []).filter((h) => h[0] !== TODAY && h[0] >= addDays(TODAY, -90));
    if (!why && r.status !== 'unreadable') hist.push([TODAY, price]);
    prev.items[d.id] = { price, listed: d.price, verified, inStock, why, hist, ...(img && !d.img ? { img } : {}) };
    if (why) { report.hidden.push({ id: d.id, title: d.title, store: d.store, why }); return; }
    report.live++;
    const h30 = hist.filter((h) => h[0] >= addDays(TODAY, -30)).map((h) => h[1]);
    const wk = hist.filter((h) => h[0] <= addDays(TODAY, -6)).pop();
    const extra = { days: hist.length };
    if (h30.length) extra.low30 = Math.min(...h30, price);
    if (wk && wk[1] - price >= 1) extra.drop7 = Math.round((wk[1] - price) * 100) / 100;
    out.push({ ...d, ...(img ? { img } : {}), price, pct, checked: verified, pkey: pkey(d), ...extra });
  });
  // borrow a photo from another listing of the exact same product (same brand + category + model)
  const photoByKey = {};
  for (const x of out) if (x.img && x.pkey && !photoByKey[x.pkey]) photoByKey[x.pkey] = x.img;
  for (const x of out) if (!x.img && x.pkey && photoByKey[x.pkey]) { x.img = photoByKey[x.pkey]; x.imgShared = true; report.imagesShared = (report.imagesShared || 0) + 1; }
  // ---- New Gear: new releases found by the weekly scan, shown for NEW_GEAR_DAYS from first sighting ----
  const releases = cur.releases || [];
  const relKey = (r) => 'rel:' + String(r.url || r.id || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  const relOut = []; report.newGear = { total: releases.length, live: 0, expired: 0, hidden: [] };
  const relSeen = new Set();
  const relResults = await pool(releases, 5, (r) => {
    const st = prev.items[relKey(r)];
    const first = st?.first || TODAY;
    return first < addDays(TODAY, -(NEW_GEAR_DAYS - 1)) ? { status: 'expired' } : check(r);
  });
  releases.forEach((r, i) => {
    const k = relKey(r); if (relSeen.has(k)) return; relSeen.add(k);
    const st = prev.items[k] || {}; const res = relResults[i];
    const first = st.first || TODAY, until = addDays(first, NEW_GEAR_DAYS - 1);
    let price = st.price ?? r.price ?? null, why = '';
    if (res.status === 'expired') why = 'shown 10 days';
    else if (res.status === 'gone') why = 'page removed';
    else if (res.status === 'ok') {
      if (res.inStock === false && !r.preorder) why = 'sold out';
      const base = r.price || price;
      if (res.price && (!base || (res.price <= base * 1.15 && res.price >= base * 0.4))) price = res.price;
    }
    const img = r.img || (res.status === 'ok' && res.image) || st.img || '';
    prev.items[k] = { first, price, why, ...(img && !r.img ? { img } : {}) };
    if (why) { if (why === 'shown 10 days') report.newGear.expired++; else report.newGear.hidden.push({ title: r.title, store: r.store, why }); return; }
    report.newGear.live++;
    relOut.push({ ...r, ...(img ? { img } : {}), price, first, until, checked: res.status === 'ok' ? TODAY : (st.checked || first) });
    prev.items[k].checked = relOut[relOut.length - 1].checked;
  });
  relOut.sort((a, b) => (b.first || '').localeCompare(a.first || '') || (b.released || '').localeCompare(a.released || ''));

  const published = { updated: TODAY, researched: cur.researched || '', deals: out, releases: relOut, promos: (cur.promos || []).filter((p) => !p.ends || p.ends >= TODAY), stores: cur.stores || [], thresholds: cur.thresholds || [] };
  await fs.writeFile(`${DATA}/deals.json`, JSON.stringify(published));
  await fs.writeFile(`${DATA}/deals-state.json`, JSON.stringify(prev, null, 1));
  await fs.writeFile(`${DATA}/deals-report.json`, JSON.stringify(report, null, 1));
  console.log(`Live ${report.live}/${report.total} · prices changed ${report.updated} · unreadable ${report.unreadable} · hidden ${report.hidden.length} · new images ${report.imagesFound || 0}`);
  for (const h of report.hidden) console.log(`  hidden: ${h.title} (${h.store}) — ${h.why}`);
  console.log(`New Gear: live ${report.newGear.live}/${report.newGear.total} · aged out ${report.newGear.expired} · hidden ${report.newGear.hidden.length}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
