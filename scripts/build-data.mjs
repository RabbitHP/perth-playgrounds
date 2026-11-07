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
nwr["leisure"="park"]["name"](${BBOX});out center tags;
node["playground"](${BBOX});out;
node["amenity"="toilets"](${BBOX});out;`;

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

const dist = (a, b, c, d) => { const t = Math.PI / 180, x = (d - b) * t * Math.cos(((a + c) / 2) * t), y = (c - a) * t; return Math.sqrt(x * x + y * y) * 6371e3; };
function grid(pts) { const g = new Map(); for (const p of pts) { const k = Math.floor(p.lat * 100) + "," + Math.floor(p.lon * 100); (g.get(k) || g.set(k, []).get(k)).push(p); } return g; }
function near(g, lat, lon, maxM) {
  const out = [], a = Math.floor(lat * 100), b = Math.floor(lon * 100);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of g.get(a + i + "," + (b + j)) || []) { const d = dist(lat, lon, p.lat, p.lon); if (d <= maxM) out.push([d, p]); }
  return out.sort((x, y) => x[0] - y[0]);
}

const j = await fetchOSM();
const pg = [], parks = [], eq = [], loos = [];
for (const e of j.elements) {
  const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  if (lat == null) continue;
  if (t.leisure === "playground") pg.push({ e, t, lat, lon });
  else if (t.leisure === "park") parks.push({ lat, lon, name: t.name });
  else if (t.amenity === "toilets") loos.push({ lat, lon });
  else if (t.playground) eq.push({ lat, lon, k: t.playground });
}
const gP = grid(parks), gE = grid(eq), gL = grid(loos), now = Date.now();
const items = pg.map(({ e, t, lat, lon }) => {
  const items = new Set();
  for (const [, x] of near(gE, lat, lon, 70)) if (EQUIP[x.k]) items.add(EQUIP[x.k]);
  for (const k in t) if (k.startsWith("playground:") && t[k] !== "no" && EQUIP[k.slice(11)]) items.add(EQUIP[k.slice(11)]);
  const f = [];
  if (t.covered === "yes" || t.shade === "yes" || t.shade === "full") f.push("Shade sail");
  if (t.fenced === "yes" || t.barrier === "fence") f.push("Fenced");
  if (t.wheelchair === "yes") f.push("Accessible");
  if (near(gL, lat, lon, 250).length) f.push("Toilets nearby");
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
  if (isNew) o.added = ts;
  return o;
});

mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/playgrounds.json", JSON.stringify({ built: now, count: items.length, items }));
console.log(`Wrote ${items.length} playgrounds (${items.filter(i => i.added).length} new) to public/data/playgrounds.json`);
if (items.length < 50 && !process.env.MOCK) { console.error("Too few playgrounds; failing the build so the last good version stays live."); process.exit(1); }
