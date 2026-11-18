// Turns the cached OpenStreetMap files into src/data.js: a small, compressed description of Craiova
// (buildings as boxes, roads, rails, parks, lakes, places) that world.js builds the city from.
//   node build-data.mjs
// Data (c) OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP, project } from './map.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(here, '.cache');
const load = (prefix) => readdirSync(cache).filter((f) => f.startsWith(prefix)).flatMap((f) => JSON.parse(readFileSync(path.join(cache, f), 'utf8')).elements);
const H = MAP.half;
const proj = (g) => g.map((p) => project(p.lat, p.lon));
const inMap = (x, z) => Math.abs(x) <= H + 50 && Math.abs(z) <= H + 50;
const q = (v, k) => Math.round(v * k);
const seen = new Set();
const fresh = (e) => (seen.has(e.type + e.id) ? false : (seen.add(e.type + e.id), true));

// ---------- geometry helpers ----------
const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x0, z0] = p[i], [x1, z1] = p[(i + 1) % p.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
function hull(pts) {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of s) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of [...s].reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// smallest rotated rectangle around a polygon: centre, size along / across, angle of the long side
function obb(poly) {
  const h = hull(poly);
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [x0, z0] = h[i], [x1, z1] = h[(i + 1) % h.length], a = Math.atan2(z1 - z0, x1 - x0), c = Math.cos(a), s = Math.sin(a);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const [x, z] of h) { const u = x * c + z * s, v = -x * s + z * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const ar = (u1 - u0) * (v1 - v0);
    if (!best || ar < best.ar) best = { ar, a, u0, u1, v0, v1 };
  }
  if (!best) return null;
  const { a, u0, u1, v0, v1 } = best, c = Math.cos(a), s = Math.sin(a), mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
  let L = u1 - u0, W = v1 - v0, ang = a;
  if (W > L) { [L, W] = [W, L]; ang += Math.PI / 2; }
  return { x: mu * c - mv * s, z: mu * s + mv * c, L, W, a: ((ang % Math.PI) + Math.PI) % Math.PI, ar: best.ar };
}
// clip a polygon to one side of a line (Sutherland-Hodgman)
function clip(poly, nx, nz, d, keepAbove) {
  const out = [], f = (p) => (p[0] * nx + p[1] * nz - d) * (keepAbove ? 1 : -1);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}
// one box if the footprint is roughly a rectangle, otherwise cut it along its long side and try again
function boxes(poly, depth = 0) {
  const o = obb(poly);
  if (!o) return [];
  const fill = Math.abs(area(poly)) / o.ar;
  if ((fill > 0.72 || depth >= 2 || o.W < 8) ) return [o];
  const c = Math.cos(o.a), s = Math.sin(o.a);
  const d = o.x * c + o.z * s;
  const A = clip(poly, c, s, d, true), B = clip(poly, c, s, d, false);
  if (A.length < 3 || B.length < 3) return [o];
  return [...boxes(A, depth + 1), ...boxes(B, depth + 1)];
}
// assemble the outer ways of a multipolygon relation into closed rings
function rings(rel) {
  const ways = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => proj(m.geometry));
  const out = [];
  const closed = (w) => w.length > 3 && Math.hypot(w[0][0] - w.at(-1)[0], w[0][1] - w.at(-1)[1]) < 0.01;
  const open = [];
  for (const w of ways) (closed(w) ? out : open).push(w);
  while (open.length) {
    let cur = open.pop();
    for (let guard = 0; guard < 200 && !closed(cur); guard++) {
      const e = cur.at(-1);
      const i = open.findIndex((w) => Math.hypot(w[0][0] - e[0], w[0][1] - e[1]) < 0.01 || Math.hypot(w.at(-1)[0] - e[0], w.at(-1)[1] - e[1]) < 0.01);
      if (i < 0) break;
      let w = open.splice(i, 1)[0];
      if (Math.hypot(w[0][0] - e[0], w[0][1] - e[1]) > 0.01) w = [...w].reverse();
      cur = cur.concat(w.slice(1));
    }
    if (closed(cur)) out.push(cur);
  }
  return out;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const f = pts[0], l = pts.at(-1);
  if (pts.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.01) {
    // a closed ring: cut it at the farthest point and simplify the two halves
    let k = 1, md = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - f[0], pts[i][1] - f[1]); if (d > md) { md = d; k = i; } }
    return simplify(pts.slice(0, k + 1), tol).concat(simplify(pts.slice(k), tol).slice(1));
  }
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, az] = pts[a], [bx, bz] = pts[b], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / l; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------- the points of interest: used for the shop-front density ----------
const nodes = load('nodes');
const places = [], shops = [], chimneys = [], signals = [];
for (const n of nodes) {
  const t = n.tags || {}, [x, z] = project(n.lat, n.lon);
  if (!inMap(x, z)) continue;
  if (t.place && t.name && /suburb|neighbourhood|quarter|square/.test(t.place)) places.push({ n: t.name, x, z, k: t.place === 'suburb' ? 0 : t.place === 'square' ? 2 : 1 });
  else if (t.shop || /restaurant|cafe|bar|pub|fast_food|bank|pharmacy|cinema|theatre|nightclub|marketplace/.test(t.amenity || '')) shops.push([x, z]);
  if (/chimney|water_tower|tower/.test(t.man_made || '')) chimneys.push({ x, z, h: parseFloat(t.height) || (t.man_made === 'chimney' ? 60 : 30), t: t.man_made });
  if (t.highway === 'traffic_signals') signals.push([x, z]);
}
// shop density on a coarse grid (a Gaussian of every shop), 0..15
const SG = 50, SN = Math.ceil((2 * H) / SG);
const dens = new Float32Array(SN * SN);
for (const [x, z] of shops) {
  const cx = (x + H) / SG, cz = (z + H) / SG;
  for (let r = Math.max(0, Math.floor(cz - 3)); r <= Math.min(SN - 1, Math.floor(cz + 3)); r++)
    for (let c = Math.max(0, Math.floor(cx - 3)); c <= Math.min(SN - 1, Math.floor(cx + 3)); c++)
      dens[r * SN + c] += Math.exp(-((c + 0.5 - cx) ** 2 + (r + 0.5 - cz) ** 2) / 2.2);
}
const shopAt = (x, z) => {
  const c = Math.floor((x + H) / SG), r = Math.floor((z + H) / SG);
  if (c < 0 || r < 0 || c >= SN || r >= SN) return 0;
  return Math.min(15, Math.round(dens[r * SN + c] * 3));
};

// ---------- buildings ----------
const KIND = { house: 0, bloc: 1, commercial: 2, industrial: 3, civic: 4, church: 5 };
const hash2 = (x, z) => { let h = (Math.imul(Math.round(x), 374761393) + Math.imul(Math.round(z), 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const landmarks = {};
const lm = load('landmarks');
for (const e of lm) if (e.geometry && e.tags?.name) landmarks[e.id] = e.tags;
const B = [];
let nBuild = 0;
for (const e of load('buildings')) {
  if (!fresh(e)) continue;
  const t = e.tags || {};
  const polys = e.type === 'way' ? (e.geometry ? [proj(e.geometry)] : []) : rings(e);
  for (const poly of polys) {
    if (poly.length < 4) continue;
    const ar = Math.abs(area(poly));
    if (ar < 12) continue;
    const [px, pz] = poly[0];
    if (!inMap(px, pz)) continue;
    const bt = t.building || 'yes', lmk = landmarks[e.id] || (t.name ? t : null);
    let kind = KIND.house;
    if (/church|cathedral|chapel|monastery|temple/.test(bt) || t.amenity === 'place_of_worship') kind = KIND.church;
    else if (/industrial|warehouse|factory|manufacture|hangar|garage|garages|service|storage|barn|farm|greenhouse|shed|carport|roof/.test(bt) || t.man_made === 'works') kind = KIND.industrial;
    else if (/retail|commercial|supermarket|office|hotel|kiosk/.test(bt) || t.shop || t.office) kind = KIND.commercial;
    else if (/apartments|dormitory/.test(bt)) kind = KIND.bloc;
    else if (/civic|public|government|hospital|school|university|college|kindergarten|stadium|train_station|museum|theatre|sports_hall/.test(bt) || t.amenity || t.tourism) kind = KIND.civic;
    const hs = boxes(poly);
    for (const o of hs) {
      if (o.L < 2.5 || o.W < 2.5) continue;
      const area2 = o.L * o.W;
      let kd = kind, lv = parseFloat(t['building:levels']), height = parseFloat(t.height);
      if (kd === KIND.house && !t['building:levels'] && !t.height && /^(yes|residential)$/.test(bt) && area2 > 380 && o.W > 9 && o.W < 18 && o.L > 24) kd = KIND.bloc;
      if (kd === KIND.house && area2 > 900) kd = KIND.commercial;
      let h = height;
      if (!(h > 0)) {
        if (lv > 0) h = lv * (kd === KIND.bloc ? 2.9 : 3.1) + (kd === KIND.house ? 1.5 : 0);
        else if (kd === KIND.bloc) h = (4 + Math.floor(hash2(o.x, o.z) * 7)) * 2.9;
        else if (kd === KIND.house) h = area2 < 90 ? 3.4 : area2 < 220 ? 5.8 : 6.5;
        else if (kd === KIND.industrial) h = 6 + hash2(o.x, o.z) * 6;
        else if (kd === KIND.commercial) h = 7 + Math.floor(hash2(o.x, o.z) * 3) * 3.2;
        else if (kd === KIND.church) h = 12 + hash2(o.x, o.z) * 6;
        else h = 11 + Math.floor(hash2(o.x, o.z) * 3) * 3.5;
      }
      h = Math.max(3, Math.min(h, 120));
      // very long halls are cut into pieces so that the sizes fit the compact encoding
      const nl = Math.ceil(o.L / 110);
      for (let k = 0; k < nl; k++) {
        const len = o.L / nl, off = -o.L / 2 + len * (k + 0.5), c = Math.cos(o.a), s = Math.sin(o.a);
        const x = o.x + c * off, z = o.z + s * off, w = Math.min(o.W, 126);
        if (!inMap(x, z)) continue;
        const roof = kd === KIND.house && h < 9 && o.W < 14 && !/flat/.test(t['roof:shape'] || '') ? 1 : 0;
        B.push(q(x, 4), q(z, 4), q(len, 2), q(w, 2), Math.round((o.a / Math.PI) * 255), q(h, 2), kd | (roof << 3) | (shopAt(x, z) << 4), lmk ? 1 : 0);
        nBuild++;
      }
    }
  }
}
console.log('building boxes', nBuild);

// ---------- roads ----------
const ROADCLASS = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3, unclassified: 4, residential: 4, living_street: 5, service: 5, pedestrian: 6, footway: 7, path: 7, cycleway: 7, steps: 7, track: 7 };
const names = [], nameIdx = new Map();
const nameOf = (n) => { if (!n) return 0; if (!nameIdx.has(n)) { nameIdx.set(n, names.length + 1); names.push(n); } return nameIdx.get(n); };
const R = [];     // roads for vehicles: class, flags, name, lanes, points...
const F = [];     // footpaths
let nRoad = 0;
for (const e of load('roads')) {
  if (!fresh(e) || !e.geometry) continue;
  const t = e.tags || {};
  const cls = ROADCLASS[t.highway];
  if (cls === undefined) continue;
  if (t.area === 'yes' && cls >= 6) continue;
  let pts = proj(e.geometry);
  if (!pts.some(([x, z]) => inMap(x, z))) continue;
  pts = simplify(pts, cls <= 3 ? 1.5 : 2.5);
  const flat = []; let px = 0, pz = 0;
  for (const [x, z] of pts) { const X = q(x, 2), Z = q(z, 2); flat.push(X - px, Z - pz); px = X; pz = Z; }
  if (cls >= 7) { F.push(cls === 7 ? 0 : 1, ...flat.length ? [flat.length / 2] : [0], ...flat); continue; }
  const oneway = t.oneway === 'yes' || t.junction === 'roundabout' || /motorway|trunk/.test(t.highway) && t.oneway !== 'no' ? 1 : 0;
  let lanes = parseInt(t.lanes) || (cls === 0 ? 2 : cls === 1 ? 2 : cls === 2 ? 2 : 1);
  const bridge = t.bridge && t.bridge !== 'no' ? 1 : 0;
  R.push(cls, oneway | (bridge << 1) | (cls === 6 ? 4 : 0), nameOf(t.name), Math.min(lanes, 4), flat.length / 2, ...flat);
  nRoad++;
}
console.log('roads', nRoad, 'footways', F.length ? 'yes' : 'no');

// ---------- rails and trams ----------
const RL = [];
for (const e of load('rail')) {
  if (!fresh(e) || !e.geometry) continue;
  const t = e.tags || {};
  if (t.railway === 'platform') continue;
  if (t.service === 'yard' || t.service === 'siding' || t.railway === 'siding' || t.railway === 'yard' || t.railway === 'spur' || t.disused || t.abandoned) { if (t.railway !== 'tram') continue; }
  const pts = simplify(proj(e.geometry), 4);
  if (!pts.some(([x, z]) => inMap(x, z))) continue;
  const flat = []; let px = 0, pz = 0;
  for (const [x, z] of pts) { const X = q(x, 2), Z = q(z, 2); flat.push(X - px, Z - pz); px = X; pz = Z; }
  RL.push(t.railway === 'tram' || t.railway === 'light_rail' ? 1 : 0, flat.length / 2, ...flat);
}

// ---------- areas: parks, woods, industry, lakes ----------
const AREA = { park: 1, wood: 2, industrial: 3, water: 4, farm: 5, pitch: 6, paved: 7, grave: 8, stadium: 9, residential: 10 };
const A = [];
let nArea = 0;
const pushArea = (type, poly, name) => {
  if (poly.length < 4 || Math.abs(area(poly)) < (type === AREA.water ? 40 : 300)) return;
  if (!poly.some(([x, z]) => inMap(x, z))) return;
  const pts = simplify(poly, 1.5).slice(0, -1);
  if (pts.length < 3) return;
  const flat = []; let px = 0, pz = 0;
  for (const [x, z] of pts) { const X = q(x, 2), Z = q(z, 2); flat.push(X - px, Z - pz); px = X; pz = Z; }
  A.push(type, pts.length, ...flat); nArea++;
};
const stadiums = [];
for (const e of load('areas')) {
  const t = e.tags || {};
  if (!fresh(e)) continue;
  if (/chimney|tower|storage_tank|silo/.test(t.man_made || '')) {
    if (e.geometry) { const c = proj(e.geometry); chimneys.push({ x: c.reduce((s, p) => s + p[0], 0) / c.length, z: c.reduce((s, p) => s + p[1], 0) / c.length, h: parseFloat(t.height) || (t.man_made === 'chimney' ? 60 : 25), t: t.man_made }); }
    continue;
  }
  let type = 0;
  if (t.natural === 'water' || t.water || t.landuse === 'reservoir' || t.landuse === 'basin') type = AREA.water;
  else if (/^(park|garden|recreation_ground|dog_park|playground)$/.test(t.leisure) || /^(grass|meadow|village_green|greenfield|flowerbed|orchard|vineyard)$/.test(t.landuse) || /grassland|scrub|heath/.test(t.natural)) type = AREA.park;
  else if (t.natural === 'wood' || t.landuse === 'forest') type = AREA.wood;
  else if (/^(industrial|railway|quarry|construction|brownfield|garages|depot|commercial|retail)$/.test(t.landuse)) type = AREA.industrial;
  else if (/^(farmland|farmyard|allotments)$/.test(t.landuse)) type = AREA.farm;
  else if (/^(pitch|sports_centre|track)$/.test(t.leisure)) type = AREA.pitch;
  else if (t.leisure === 'stadium') type = AREA.stadium;
  else if (t.amenity === 'parking' || t.highway === 'pedestrian' || /^(plaza|retail)$/.test(t.place || '')) type = AREA.paved;
  else if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') type = AREA.grave;
  else if (t.landuse === 'residential') type = AREA.residential;
  if (!type) continue;
  const polys = e.type === 'way' ? (e.geometry ? [proj(e.geometry)] : []) : rings(e);
  for (const p of polys) {
    pushArea(type, p, t.name);
    if (type === AREA.stadium && p.length > 3) { const o = obb(p); if (o) stadiums.push({ x: o.x, z: o.z, L: o.L, W: o.W, a: o.a, n: t.name || '' }); }
  }
}
console.log('areas', nArea);

// ---------- named landmarks ----------
const LM = [];
for (const e of lm) {
  if (!e.geometry || !e.tags?.name) continue;
  const p = proj(e.geometry), cx = p.reduce((s, v) => s + v[0], 0) / p.length, cz = p.reduce((s, v) => s + v[1], 0) / p.length;
  if (!inMap(cx, cz)) continue;
  const t = e.tags;
  LM.push({ n: t.name, x: Math.round(cx), z: Math.round(cz), c: t.amenity || t.tourism || t.leisure || t.building });
}

const data = {
  H, names,
  b: B, r: R, f: F, l: RL, a: A,
  p: places.map((p) => [p.n, Math.round(p.x), Math.round(p.z), p.k]),
  c: chimneys.map((c) => [Math.round(c.x), Math.round(c.z), Math.round(c.h), c.t === 'chimney' ? 0 : 1]),
  s: stadiums.map((s) => [Math.round(s.x), Math.round(s.z), Math.round(s.L), Math.round(s.W), +s.a.toFixed(3), s.n]),
  g: signals.map((s) => [Math.round(s[0]), Math.round(s[1])]),
  m: LM,
};
const json = JSON.stringify(data);
const z = deflateRawSync(Buffer.from(json), { level: 9 });
const b64 = z.toString('base64');
writeFileSync(path.join(here, '..', 'src', 'data.js'),
  `// GENERATED by tools/build-data.mjs from OpenStreetMap (c) OpenStreetMap contributors, ODbL. Do not edit.\n`
  + `// ${nBuild} building boxes, ${nRoad} roads, ${RL.length ? 'rails and trams, ' : ''}${nArea} areas, ${places.length} places.\n`
  + `const CITY_DATA = '${b64}';\n`);
console.log(`json ${(json.length / 1024).toFixed(0)} kB -> data.js ${(b64.length / 1024).toFixed(0)} kB`);
console.log('places', places.map((p) => p.n).join(', '));
console.log('stadiums', stadiums.map((s) => s.n).join(', '), 'chimneys', chimneys.length);
