// Runs on every Vercel build: pulls Perth playgrounds from OpenStreetMap once
// and saves a small JSON file the app loads instantly.
// Local test: MOCK=path/to/overpass.json node scripts/build-data.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BBOX = [-32.62, 115.6, -31.45, 116.2]; // Two Rocks to Mandurah, coast to the hills
const NEW_DAYS = 365, DAY = 864e5;
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const QUERY = `[out:json][timeout:180];
nwr["leisure"="playground"](${BBOX});out center meta;
nwr["leisure"~"^(park|nature_reserve|recreation_ground|garden)$"]["name"](${BBOX});out bb tags;
nwr["name"]["shop"="mall"](${BBOX});out bb tags;
node["playground"](${BBOX});out;
nwr["amenity"~"^(toilets|parking|drinking_water|cafe|bbq)$"](${BBOX});out center tags;`;

const EQUIP = {swing:"Swings",basketswing:"Basket swing",slide:"Slide",climbingframe:"Climbing frame",structure:"Play structure",sandpit:"Sandpit",seesaw:"Seesaw",springy:"Spring rider",roundabout:"Roundabout",zipwire:"Flying fox",trampoline:"Trampoline",balancebeam:"Balance beam",playhouse:"Cubby house",splash_pad:"Water play",water:"Water play",rope_traverse:"Rope course",climbing_wall:"Climbing wall",spinner:"Spinner",musical_instrument:"Musical play",sand_digger:"Sand digger",horizontal_bar:"Monkey bars",funnel_ball:"Ball game",hopscotch:"Hopscotch",tunnel_tube:"Tunnel",aerial_rotator:"Spinner",teenshelter:"Teen hangout"};
const SURF = {sand:"Sand",woodchips:"Woodchips",rubber:"Soft-fall rubber",tartan:"Soft-fall rubber",grass:"Grass",artificial_turf:"Fake grass"};

async function fetchOSM() {
  if (process.env.MOCK) return JSON.parse(readFileSync(process.env.MOCK, "utf8"));
  let last;
  for (let round = 0; round < 2; round++) {
    for (const url of MIRRORS) {
      try {
        const t0 = Date.now();
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "perth-playgrounds/1.0 (vercel build)" },
          body: "data=" + encodeURIComponent(QUERY),
          signal: AbortSignal.timeout(200_000),
        });
        if (!r.ok) throw new Error(url + " HTTP " + r.status);
        const j = await r.json();
        if (!j.elements?.length) throw new Error(url + " returned no elements" + (j.remark ? ": " + j.remark : ""));
        console.log(`Overpass OK from ${url} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${j.elements.length} elements`);
        return j;
      } catch (e) { last = e; console.warn("Overpass failed:", e.message); }
    }
  }
  throw last;
}

// Which playgrounds existed at past dates? (Overpass history snapshots, ids only)
const SNAP_MONTHS = [6, 12, 24, 36, 60];
async function snapshotIds(monthsAgo) {
  const d = new Date(); d.setMonth(d.getMonth() - monthsAgo);
  if (process.env.MOCK) { // test: way ids 1000+k exist from (k%6)*12 months ago
    const ids = new Set(); for (let k = 0; k < 400; k++) if ((k % 6) * 12 >= monthsAgo) ids.add("w" + (1000 + k));
    return { at: d.getTime(), ids };
  }
  const q = `[out:json][timeout:180][date:"${d.toISOString().slice(0, 10)}T00:00:00Z"];nwr["leisure"="playground"](${BBOX});out ids;`;
  for (const url of MIRRORS.slice(0, 2)) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "perth-playgrounds/1.0 (vercel build)" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(200_000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j.elements?.length) throw new Error("empty");
      console.log(`Snapshot ${monthsAgo}m ago: ${j.elements.length} playgrounds`);
      return { at: d.getTime(), ids: new Set(j.elements.map(e => e.type[0] + e.id)) };
    } catch (e) { console.warn(`Snapshot ${monthsAgo}m failed (${url}):`, e.message); }
  }
  return null;
}

const dist = (a, b, c, d) => { const t = Math.PI / 180, x = (d - b) * t * Math.cos(((a + c) / 2) * t), y = (c - a) * t; return Math.sqrt(x * x + y * y) * 6371e3; };
function grid(pts) { const g = new Map(); for (const p of pts) { const k = Math.floor(p.lat * 100) + "," + Math.floor(p.lon * 100); (g.get(k) || g.set(k, []).get(k)).push(p); } return g; }
function near(g, lat, lon, maxM) {
  const out = [], a = Math.floor(lat * 100), b = Math.floor(lon * 100);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of g.get(a + i + "," + (b + j)) || []) { const d = dist(lat, lon, p.lat, p.lon); if (d <= maxM) out.push([d, p]); }
  return out.sort((x, y) => x[0] - y[0]);
}

const j = await fetchOSM();
const pg = [], parks = [], eq = [], loos = [];
const AM = { toilets: [], parking: [], drinking_water: [], cafe: [], bbq: [] };
for (const e of j.elements) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat ?? (e.bounds && (e.bounds.minlat + e.bounds.maxlat) / 2), lon = e.lon ?? e.center?.lon ?? (e.bounds && (e.bounds.minlon + e.bounds.maxlon) / 2);
  if (lat == null) continue;
  if (t.leisure === "playground") pg.push({ e, t, lat, lon });
  else if (t.name && (t.leisure || t.shop === "mall")) {
    const b = e.bounds; const plat = b ? (b.minlat + b.maxlat) / 2 : lat, plon = b ? (b.minlon + b.maxlon) / 2 : lon;
    parks.push({ lat: plat, lon: plon, name: t.name, b });
  }
  else if (AM[t.amenity]) {
    if (t.access === "private" || t.access === "no") continue;
    AM[t.amenity].push({ lat, lon, name: t.name || t.brand || "" });
    if (t.amenity === "toilets") loos.push({ lat, lon });
  }
  else if (t.playground) eq.push({ lat, lon, k: t.playground });
}
const gP = grid(parks), gE = grid(eq), gL = grid(loos), now = Date.now();
const gA = Object.fromEntries(Object.entries(AM).map(([k, v]) => [k, grid(v)]));
const NB = { toilets: ["t", 800], parking: ["p", 600], drinking_water: ["w", 800], cafe: ["c", 1000], bbq: ["b", 600] };
const items = pg.map(({ e, t, lat, lon }) => {
  const items = new Set();
  for (const [, x] of near(gE, lat, lon, 70)) if (EQUIP[x.k]) items.add(EQUIP[x.k]);
  for (const k in t) if (k.startsWith("playground:") && t[k] !== "no" && EQUIP[k.slice(11)]) items.add(EQUIP[k.slice(11)]);
  const f = [];
  if (t.covered === "yes" || t.shade === "yes" || t.shade === "full") f.push("Shade sail");
  if (t.fenced === "yes" || t.barrier === "fence") f.push("Fenced");
  if (t.wheelchair === "yes") f.push("Accessible");
  if (near(gL, lat, lon, 250).length) f.push("Toilets nearby");
  const nb = {};
  for (const [k, [key, max]] of Object.entries(NB)) {
    const hit = near(gA[k], lat, lon, max)[0];
    if (hit) nb[key] = hit[1].name && (key === "c") ? [Math.round(hit[0]), hit[1].name] : [Math.round(hit[0])];
  }
  if (SURF[t.surface]) f.push(SURF[t.surface]);
  if (t.min_age || t.max_age) f.push("Ages " + (t.min_age || "0") + "–" + (t.max_age || "12"));
  const ts = Date.parse(e.timestamp || 0) || 0;
  const isNew = e.version === 1 && now - ts < NEW_DAYS * DAY;
  const o = { id: e.type[0] + e.id, lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
  if (t.name) o.name = t.name;
  const park = near(gP, lat, lon, 350)[0]?.[1]?.name; if (park) o.park = park;
  if (t["addr:suburb"]) o.sub = t["addr:suburb"];
  if (items.size) o.items = [...items];
  if (f.length) o.feats = f;
  if (Object.keys(nb).length) o.nb = nb;
  if (isNew) o.added = ts;
  if (e.version === 1) o.since = ts;            // exact: never edited since it was added
  return o;
});

// ---- Rough "added to the map" window for everything else ----
const snaps = [];
for (const m of SNAP_MONTHS) { const sn = await snapshotIds(m); if (sn) snaps.push(sn); }
snaps.sort((a, b) => b.at - a.at); // newest first
for (const o of items) {
  if (o.since || !snaps.length) continue;
  // find the most recent snapshot where it was absent; it appeared after that date
  let after = null, before = now;
  for (const sn of snaps) { if (sn.ids.has(o.id)) before = sn.at; else { after = sn.at; break; } }
  if (after) { o.sinceFrom = after; o.sinceTo = before; if (!o.added && now - after <= (NEW_DAYS + 1) * DAY) o.added = after; }
  else o.sinceBefore = snaps[snaps.length - 1].at;   // already there at the oldest snapshot
}
console.log(`Dates: ${items.filter(o => o.since).length} exact, ${items.filter(o => o.sinceFrom).length} windowed, ${items.filter(o => o.sinceBefore).length} older than ${SNAP_MONTHS.at(-1) / 12} years`);

// ---- Curated new playgrounds (data/new-playgrounds.json) ----
// Only ever placed on an exact OpenStreetMap playground or park. Never a suburb or street guess.
const curated = JSON.parse(readFileSync("data/new-playgrounds.json", "utf8")).items;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function nominatim(q) {
  if (process.env.MOCK) return process.env.MOCK_GEO ? JSON.parse(process.env.MOCK_GEO)[q] || [] : [];
  const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=au&viewbox=115.6,-31.45,116.2,-32.62&bounded=1&q=" + encodeURIComponent(q + ", Western Australia");
  try {
    const r = await fetch(u, { headers: { "User-Agent": "perth-playgrounds/1.0 (build-time lookup)" }, signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.json() : [];
  } catch { return []; } finally { await sleep(1100); }
}
const norm = s => (s || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const inB = (b, p, padM = 30) => { const pd = padM / 111000; return p.lat >= b.minlat - pd && p.lat <= b.maxlat + pd && p.lon >= b.minlon - pd && p.lon <= b.maxlon + pd; };
const diag = b => dist(b.minlat, b.minlon, b.maxlat, b.maxlon);
const suburbCache = new Map();
async function suburbPoint(sub) {
  if (!sub) return null;
  if (!suburbCache.has(sub)) { const r = (await nominatim(sub)).find(x => ["suburb", "town", "village", "neighbourhood", "quarter", "hamlet", "city"].includes(x.addresstype || x.type)); suburbCache.set(sub, r ? { lat: +r.lat, lon: +r.lon } : null); }
  return suburbCache.get(sub);
}
function playgroundsIn(b, centre) {
  return items.filter(p => inB(b, p)).sort((x, y) => dist(centre.lat, centre.lon, x.lat, x.lon) - dist(centre.lat, centre.lon, y.lat, y.lon));
}
const report = { placed: [], notPlaced: [] };
for (const [i, c] of curated.entries()) {
  let target = null, how = "";
  // 1) A named park/playground/mall in our OSM data
  const want = (c.names || []).map(norm);
  let cands = parks.filter(p => want.some(w => norm(p.name) === w || norm(p.name).startsWith(w)));
  const pgNamed = items.filter(p => want.some(w => norm(p.name) === w));
  if (c.in) { const outer = parks.filter(p => c.in.map(norm).includes(norm(p.name)) && p.b); cands = cands.filter(p => outer.some(o => inB(o.b, p))); }
  if (pgNamed.length === 1 && !cands.length) { target = pgNamed[0]; how = "named playground"; }
  if (!target && cands.length) {
    const sp = await suburbPoint(c.suburb);
    if (cands.length > 1 && sp) cands = cands.filter(p => dist(sp.lat, sp.lon, p.lat, p.lon) < 6000).sort((x, y) => dist(sp.lat, sp.lon, x.lat, x.lon) - dist(sp.lat, sp.lon, y.lat, y.lon));
    if (cands.length > 1 && !sp) cands = [];
    const park = cands[0];
    if (park) {
      const pgs = park.b ? playgroundsIn(park.b, park) : near(grid(items), park.lat, park.lon, 120).map(([, p]) => p);
      if (pgs.length) { target = pgs[0]; how = `playground inside ${park.name}`; }
      else if (park.b && diag(park.b) <= 350) { target = { lat: park.lat, lon: park.lon, fresh: 1 }; how = `small park ${park.name} (no playground mapped)`; }
    }
  }
  // 2) Street-only listing: exactly one mapped playground on/next to that street
  if (!target && c.street) {
    const st = (await nominatim(`${c.street}, ${c.suburb}`)).find(x => x.category === "highway" || x.class === "highway");
    if (st) {
      const [s1, s2, w1, w2] = st.boundingbox.map(Number);
      const pgs = items.filter(p => inB({ minlat: s1, maxlat: s2, minlon: w1, maxlon: w2 }, p, 80));
      if (pgs.length === 1) { target = pgs[0]; how = `only playground on ${c.street}`; }
    }
  }
  if (!target) { report.notPlaced.push(c.name + (c.suburb ? `, ${c.suburb}` : "")); console.warn("Not placed (no exact match):", c.name); continue; }
  const opened = (c.where.match(/\((?:re)?opened ([A-Za-z]+ \d{4})\)/) || [])[1];
  if (opened) target.opened = opened;
  if (target.fresh) {
    items.push({ id: "c" + i, lat: +target.lat.toFixed(6), lon: +target.lon.toFixed(6), name: c.name, sub: c.suburb, where: c.where.replace(/\s*\(.*\)/, ""), added: now, curated: 1, ...(opened ? { opened } : {}) });
  } else {
    target.name = c.name; target.added = target.added || now; target.curated = 1;
    if (!target.sub && c.suburb) target.sub = c.suburb;
    target.where = c.where.replace(/\s*\(.*\)/, "");
  }
  report.placed.push(`${c.name}: ${how}`);
}
console.log(`Curated: ${report.placed.length} placed exactly, ${report.notPlaced.length} left off`);
mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/playgrounds.json", JSON.stringify({ built: now, count: items.length, items }));
writeFileSync("public/data/report.json", JSON.stringify({ built: new Date(now).toISOString(), ...report }, null, 1));
console.log(`Wrote ${items.length} playgrounds (${items.filter(i => i.added).length} new) to public/data/playgrounds.json`);
if (items.length < 50 && !process.env.MOCK) { console.error("Too few playgrounds; failing the build so the last good version stays live."); process.exit(1); }
