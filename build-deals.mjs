#!/usr/bin/env node
// GWI Golf Deals checker — runs daily in GitHub Actions (.github/workflows/deals.yml).
// Reads the hand-picked list in data/deals-curated.json, re-checks every deal page for the current
// price and stock, and writes data/deals.json (what golfweatheriq.com shows).
//  - sold out / page gone            -> hidden
//  - price went up and discount < 25% -> hidden
//  - page couldn't be read (blocked)  -> kept at the last verified price for up to 10 days, then hidden
// No packages needed — plain Node 20.
import fs from 'node:fs/promises';

const DATA = process.env.DATA_DIR || 'data';
const TODAY = process.env.TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const MIN_PCT = 25, STALE_DAYS = 10;
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
    return { price, inStock: avail.length > 0 || !!j.available };
  } catch { return null; }
}

async function check(d) {
  const r = await get(d.url);
  if (r.status === 404 || r.status === 410) return { status: 'gone' };
  let found = null;
  if (/\/products\//.test(d.url)) found = await shopify(d.url);
  if (!found && r.ok) found = extract(r.text);
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
    prev.items[d.id] = { price, listed: d.price, verified, inStock, why };
    if (why) { report.hidden.push({ id: d.id, title: d.title, store: d.store, why }); return; }
    report.live++;
    out.push({ ...d, price, pct, checked: verified });
  });
  const published = { updated: TODAY, researched: cur.researched || '', deals: out, promos: (cur.promos || []).filter((p) => !p.ends || p.ends >= TODAY), stores: cur.stores || [], thresholds: cur.thresholds || [] };
  await fs.writeFile(`${DATA}/deals.json`, JSON.stringify(published));
  await fs.writeFile(`${DATA}/deals-state.json`, JSON.stringify(prev, null, 1));
  await fs.writeFile(`${DATA}/deals-report.json`, JSON.stringify(report, null, 1));
  console.log(`Live ${report.live}/${report.total} · prices changed ${report.updated} · unreadable ${report.unreadable} · hidden ${report.hidden.length}`);
  for (const h of report.hidden) console.log(`  hidden: ${h.title} (${h.store}) — ${h.why}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
