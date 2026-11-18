// ---------------------------------------------------------------------------
// world.js: builds Craiova from real OpenStreetMap data (data.js): every building as a box,
// the street network with its lanes and junctions, the parks and lakes, the railway and the
// tram lines, the stadium bowls, street lamps, trees, traffic and the baked ground light.
// A good place to start.
// ---------------------------------------------------------------------------

const WORLD = 4000;                 // the map spans -WORLD..WORLD on x and z (metres); x runs east, z runs south
const ROADY = 0.1;                  // top of the asphalt
const LAYOUT_N = 4096, LIGHT_N = 2048;
const MAT = { basic: 0, building: 1, emissive: 2, road: 3, sidewalk: 4, foliage: 5, neon: 7, train: 8 };
const ANIM = { none: 0, car: 1, blink: 5, beam: 7 };
const MAP_REF = { lat0: 44.3125, lon0: 23.804 };
// latitude / longitude to metres on the map (the same projection tools/map.mjs used to make data.js)
function geo(lat, lon) { return [(lon - MAP_REF.lon0) * 111320 * Math.cos((MAP_REF.lat0 * Math.PI) / 180), -(lat - MAP_REF.lat0) * 110574]; }

// the compressed OpenStreetMap extract (data.js) back into plain arrays
async function loadCity() {
  const bin = Uint8Array.from(atob(CITY_DATA), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

// growable list of instances, 24 floats each: 3x4 transform, color, p, q
class InstList {
  constructor() { this.a = new Float32Array(24 * 4096); this.n = 0; }
  push(m, c, p, q = [0, 0, 0, 0]) {
    if ((this.n + 1) * 24 > this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const a = this.a, o = this.n * 24;
    for (let i = 0; i < 12; i++) a[o + i] = m[i];
    a[o + 12] = c[0]; a[o + 13] = c[1]; a[o + 14] = c[2]; a[o + 15] = c[3];
    a[o + 16] = p[0]; a[o + 17] = p[1]; a[o + 18] = p[2]; a[o + 19] = p[3];
    a[o + 20] = q[0]; a[o + 21] = q[1]; a[o + 22] = q[2]; a[o + 23] = q[3];
    this.n++;
  }
  data() { return this.a.subarray(0, this.n * 24); }
}

// delta-coded polylines back into points; every record starts with `head` numbers, then the point count
function readLines(arr, head, cb) {
  for (let i = 0; i < arr.length;) {
    const h = arr.slice(i, i + head), n = arr[i + head];
    i += head + 1;
    const pts = [];
    let x = 0, z = 0;
    for (let k = 0; k < n; k++) { x += arr[i++]; z += arr[i++]; pts.push([x / 2, z / 2]); }
    cb(h, pts);
  }
}

const KIND = { house: 0, bloc: 1, commercial: 2, industrial: 3, civic: 4, church: 5 };
const AREA = { park: 1, wood: 2, industrial: 3, water: 4, farm: 5, pitch: 6, paved: 7, grave: 8, stadium: 9, residential: 10 };

async function buildWorld(Q, progress, city) {
  const rng = mulberry32(20261118);
  const R = (a, b) => a + (b - a) * rng();
  // decorations that depend on the detail level draw from their own stream, so every level is the same city
  const rd = mulberry32(5150), Rd = (a, b) => a + (b - a) * rd(), pickd = (arr) => arr[Math.floor(rd() * arr.length)];
  const tick = async (f, label) => { progress(f, label); await new Promise((r) => setTimeout(r, 0)); };

  const G = { cube: new InstList(), cyl: new InstList(), sphere: new InstList(), cone: new InstList(), prism: new InstList(), beam: new InstList(), sprite: new InstList() };
  const layout = new Uint8Array(LAYOUT_N * LAYOUT_N * 4);
  const light = new Float32Array(LIGHT_N * LIGHT_N * 3);
  const foot = new Float32Array(LIGHT_N * LIGHT_N);
  const boxes = [];
  let seedN = 1;

  // ---------- rasterising into the ground textures ----------
  const lx = (x) => (x / (2 * WORLD) + 0.5) * LAYOUT_N;
  const PXL = LAYOUT_N / (2 * WORLD);
  function layPoly(pts, type) {
    // scanline fill, even-odd
    let z0 = 1e9, z1 = -1e9;
    for (const p of pts) { z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const r0 = Math.max(0, Math.floor(lx(z0))), r1 = Math.min(LAYOUT_N - 1, Math.ceil(lx(z1)));
    const xs = [];
    for (let r = r0; r <= r1; r++) {
      const z = ((r + 0.5) / LAYOUT_N - 0.5) * 2 * WORLD;
      xs.length = 0;
      for (let i = 0, n = pts.length; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a[1] <= z) !== (b[1] <= z)) xs.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.round(lx(xs[k]))), c1 = Math.min(LAYOUT_N, Math.round(lx(xs[k + 1])));
        for (let c = c0; c < c1; c++) layout[(r * LAYOUT_N + c) * 4] = type;
      }
    }
  }
  // stamp a disk of one ground type
  function layDiskType(x, z, rad, type) {
    const cx = lx(x), cz = lx(z), rr = rad * PXL;
    for (let r = Math.max(0, Math.floor(cz - rr)); r <= Math.min(LAYOUT_N - 1, Math.ceil(cz + rr)); r++)
      for (let c = Math.max(0, Math.floor(cx - rr)); c <= Math.min(LAYOUT_N - 1, Math.ceil(cx + rr)); c++)
        if ((c + 0.5 - cx) ** 2 + (r + 0.5 - cz) ** 2 <= rr * rr) layout[(r * LAYOUT_N + c) * 4] = type;
  }
  function layDisk(x, z, rad, ch, soft = 1.2) {
    const cx = lx(x), cz = lx(z), rr = (rad + soft) * PXL;
    for (let r = Math.max(0, Math.floor(cz - rr)); r <= Math.min(LAYOUT_N - 1, Math.ceil(cz + rr)); r++)
      for (let c = Math.max(0, Math.floor(cx - rr)); c <= Math.min(LAYOUT_N - 1, Math.ceil(cx + rr)); c++) {
        const d = Math.hypot(c + 0.5 - cx, r + 0.5 - cz) / PXL, v = Math.round(255 * smooth(rad + soft, rad - soft, d));
        const i = (r * LAYOUT_N + c) * 4 + ch;
        if (v > layout[i]) layout[i] = v;
      }
  }
  const ll = (x) => (x / (2 * WORLD) + 0.5) * LIGHT_N;
  const llPx = LIGHT_N / (2 * WORLD);
  function splat(x, z, r, g, b, sigma) {
    const cx = ll(x), cz = ll(z), s = Math.max(sigma * llPx, 0.8), rr = Math.ceil(s * 2.6), k = 1 / (2 * s * s);
    if (cx < -rr || cz < -rr || cx > LIGHT_N + rr || cz > LIGHT_N + rr) return;
    for (let row = Math.max(0, Math.floor(cz - rr)); row <= Math.min(LIGHT_N - 1, Math.ceil(cz + rr)); row++)
      for (let col = Math.max(0, Math.floor(cx - rr)); col <= Math.min(LIGHT_N - 1, Math.ceil(cx + rr)); col++) {
        const dx = col + 0.5 - cx, dz = row + 0.5 - cz, w = Math.exp(-(dx * dx + dz * dz) * k), i = (row * LIGHT_N + col) * 3;
        light[i] += r * w; light[i + 1] += g * w; light[i + 2] += b * w;
      }
  }
  // buildings darken the light bake around their feet (ambient occlusion); boxes may face any way
  function footBox(cx, cz, ux, uz, hl, hw) {
    const ex = Math.abs(ux) * hl + Math.abs(uz) * hw, ez = Math.abs(uz) * hl + Math.abs(ux) * hw;
    for (let r = Math.max(0, Math.floor(ll(cz - ez))); r < Math.min(LIGHT_N, Math.ceil(ll(cz + ez))); r++)
      for (let c = Math.max(0, Math.floor(ll(cx - ex))); c < Math.min(LIGHT_N, Math.ceil(ll(cx + ex))); c++) {
        const x = ((c + 0.5) / LIGHT_N - 0.5) * 2 * WORLD - cx, z = ((r + 0.5) / LIGHT_N - 0.5) * 2 * WORLD - cz;
        if (Math.abs(x * ux + z * uz) <= hl && Math.abs(-x * uz + z * ux) <= hw) foot[r * LIGHT_N + c] = 1;
      }
  }
  const footAt = (x, z) => {
    const c = Math.floor(ll(x)), r = Math.floor(ll(z));
    return c < 0 || r < 0 || c >= LIGHT_N || r >= LIGHT_N ? 0 : foot[r * LIGHT_N + c];
  };
  const layAt = (x, z, ch) => {
    const c = Math.floor(lx(x)), r = Math.floor(lx(z));
    return c < 0 || r < 0 || c >= LAYOUT_N || r >= LAYOUT_N ? 0 : layout[(r * LAYOUT_N + c) * 4 + ch];
  };

  // ---------- small helpers that place things ----------
  const sprite = (x, y, z, col, inten, size, anim = 0, dir = 0, phase = 0, q = [0, 0, 0, 0]) =>
    G.sprite.push([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z], [col[0], col[1], col[2], inten], [size, anim, dir, phase], q);
  const basic = (list, m, col, anim = 0, q, phase = 0) => list.push(m, [col[0], col[1], col[2], 0], [MAT.basic, anim, seedN++, phase], q);
  const emissive = (list, m, col, inten, anim = 0, q, phase = 0) => list.push(m, [col[0], col[1], col[2], inten], [MAT.emissive, anim, seedN++, phase], q);
  // a box that faces direction ang (the direction of its long side in the x-z plane), for the fly-through collision
  const collider = (cx, y0, cz, hl, hw, y1, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    boxes.push(-hl, y0, -hw, hl, y1, hw, cx, cz, c, s);
  };
  const LAMP = [1.0, 0.72, 0.44];
  const NEON = [[0.2, 0.9, 1.0], [1.0, 0.2, 0.75], [1.0, 0.55, 0.15], [0.5, 0.35, 1.0], [0.3, 1.0, 0.5], [1.0, 0.15, 0.2], [1.0, 0.9, 0.4]];

  function streetLamp(x, z, ox, oz, h = 7) {
    // pole at (x, z); the head reaches out over the road along (ox, oz)
    basic(G.cyl, TM.box(x, h / 2, z, 0.22, h, 0.22), [0.06, 0.06, 0.07]);
    const hx = x + ox * 1.4, hz = z + oz * 1.4;
    basic(G.cube, TM.seg(x, h - 0.05, z, hx, h - 0.1, hz, 0.12), [0.06, 0.06, 0.07]);
    emissive(G.cube, TM.box(hx, h - 0.15, hz, 0.7, 0.14, 0.4), LAMP, 2.5);
    sprite(hx, h - 0.3, hz, LAMP, 5, 0.75);
    splat(hx, hz, 0.95, 0.68, 0.42, 6.5);
  }
  const startPt = geo(44.318435, 23.800570);   // where you start: keep it clear of trees
  function tree(x, z, s = 1, conifer = false) {
    if ((x - startPt[0]) ** 2 + (z - startPt[1]) ** 2 < 100) return;
    const tint = pickd([[0.06, 0.1, 0.045], [0.05, 0.085, 0.05], [0.08, 0.1, 0.04], [0.045, 0.075, 0.06]]);
    basic(G.cyl, TM.box(x, 1.5 * s, z, 0.35 * s, 3 * s, 0.35 * s), [0.06, 0.04, 0.03]);
    if (conifer) {
      G.cone.push(TM.box(x, 6 * s, z, 4.5 * s, 9 * s, 4.5 * s), [...tint, 0], [MAT.foliage, 0, seedN++, 0]);
    } else {
      const w = Rd(3.6, 5.2) * s;
      G.sphere.push(TM.box(x, 4.4 * s, z, w, w * Rd(0.8, 1.0), w), [...tint, 0], [MAT.foliage, 0, seedN++, 0]);
    }
  }

  // ---------- 1. read the map ----------
  await tick(0.03, 'Reading the map of Craiova');
  const names = city.names;
  const roads = [];
  readLines(city.r, 4, ([cls, fl, nm, ln], pts) => { if (pts.length > 1) roads.push({ cls, ow: fl & 1, ped: (fl >> 2) & 1, nm, ln, pts, id: roads.length }); });
  const foots = [];
  readLines(city.f, 1, ([t], pts) => foots.push(pts));
  const rails = [];
  readLines(city.l, 1, ([t], pts) => rails.push({ tram: t === 1, pts }));
  const areas = [];
  readLines(city.a, 1, ([t], pts) => areas.push({ type: t, pts }));
  const rpGrid = new Map();
  for (const rd2 of roads) {
    if (rd2.cls > 5) continue;
    for (let i = 0; i + 1 < rd2.pts.length; i++) {
      const [ax, az] = rd2.pts[i], [bx, bz] = rd2.pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 10));
      for (let k = 0; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n, key = Math.floor(x / 30) * 100003 + Math.floor(z / 30);
        if (!rpGrid.has(key)) rpGrid.set(key, []);
        rpGrid.get(key).push(x, z);
      }
    }
  }
  const roadWithin = (x, z, rad) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const l = rpGrid.get((Math.floor(x / 30) + dx) * 100003 + Math.floor(z / 30) + dz);
      if (l) for (let k = 0; k < l.length; k += 2) if ((l[k] - x) ** 2 + (l[k + 1] - z) ** 2 < rad * rad) return true;
    }
    return false;
  };

  // ---------- 2. ground: fields, industry, parks, lakes ----------
  await tick(0.08, 'Painting the ground');
  const GROUND = { [AREA.farm]: 5, [AREA.industrial]: 3, [AREA.park]: 2, [AREA.wood]: 2, [AREA.grave]: 8, [AREA.pitch]: 2, [AREA.paved]: 6 };
  for (const t of [AREA.farm, AREA.industrial, AREA.park, AREA.wood, AREA.grave, AREA.pitch, AREA.paved])
    for (const a of areas) if (a.type === t) layPoly(a.pts, GROUND[t]);
  // lakes: a soft-edged mask in the alpha channel
  {
    const mask = new Uint8Array(LAYOUT_N * LAYOUT_N);
    let rMin = LAYOUT_N, rMax = 0;
    const saved = new Uint8Array(0);
    for (const a of areas) {
      if (a.type !== AREA.water) continue;
      // fill into a separate mask by borrowing layPoly on a scratch copy of the red channel
      let z0 = 1e9, z1 = -1e9;
      for (const p of a.pts) { z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
      const r0 = Math.max(0, Math.floor(lx(z0)) - 1), r1 = Math.min(LAYOUT_N - 1, Math.ceil(lx(z1)) + 1);
      rMin = Math.min(rMin, r0); rMax = Math.max(rMax, r1);
      const xs = [];
      for (let r = r0; r <= r1; r++) {
        const z = ((r + 0.5) / LAYOUT_N - 0.5) * 2 * WORLD;
        xs.length = 0;
        for (let i = 0, n = a.pts.length; i < n; i++) {
          const p = a.pts[i], q = a.pts[(i + 1) % n];
          if ((p[1] <= z) !== (q[1] <= z)) xs.push(p[0] + ((z - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let c = Math.max(0, Math.round(lx(xs[k]))); c < Math.min(LAYOUT_N, Math.round(lx(xs[k + 1]))); c++) mask[r * LAYOUT_N + c] = 255;
      }
    }
    for (let r = Math.max(1, rMin); r <= Math.min(LAYOUT_N - 2, rMax); r++)
      for (let c = 1; c < LAYOUT_N - 1; c++) {
        const i = r * LAYOUT_N + c;
        if (!mask[i] && !mask[i - 1] && !mask[i + 1] && !mask[i - LAYOUT_N] && !mask[i + LAYOUT_N]) continue;
        let s = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s += mask[i + dr * LAYOUT_N + dc];
        layout[i * 4 + 3] = Math.round(s / 9);
      }
  }

  // ---------- 3. buildings ----------
  await tick(0.15, 'Raising the buildings');
  const WALLS = {
    house: [[0.46, 0.42, 0.34], [0.42, 0.3, 0.22], [0.38, 0.4, 0.36], [0.5, 0.5, 0.5], [0.45, 0.3, 0.3], [0.5, 0.45, 0.28]],
    bloc: [[0.55, 0.5, 0.42], [0.5, 0.4, 0.35], [0.42, 0.5, 0.52], [0.58, 0.58, 0.56], [0.52, 0.52, 0.5], [0.5, 0.36, 0.3]],
  };
  const stadiumBoxes = city.s.filter((s) => s[2] > 90 && s[3] > 70);
  const inStadium = (x, z) => stadiumBoxes.some(([sx, sz, L, W, a]) => {
    const dx = x - sx, dz = z - sz, c = Math.cos(a), s = Math.sin(a);
    return Math.abs(dx * c + dz * s) < L / 2 && Math.abs(-dx * s + dz * c) < W / 2;
  });
  const B = city.b;
  let buildingCount = 0;
  const tallest = [];
  const bTop = new Map();          // roof height of every building box, by index in the data
  for (let i = 0; i < B.length; i += 8) {
    const x = B[i] / 4, z = B[i + 1] / 4, len = B[i + 2] / 2, wid = B[i + 3] / 2, ang = (B[i + 4] / 255) * Math.PI, h = B[i + 5] / 2;
    const kind = B[i + 6] & 7, roof = (B[i + 6] >> 3) & 1, shopRaw = B[i + 6] >> 4;
    if (inStadium(x, z)) continue;
    buildingCount++;
    const seed = 7919 + 13 * buildingCount;
    const u = [Math.cos(ang), Math.sin(ang)], v = [-Math.sin(ang), Math.cos(ang)], yaw = -ang;
    let style = 0, wall, refl = 0.3, fh = 3, cw = 3, wx = 0.55;
    switch (kind) {
      case KIND.house: wall = pickWall(WALLS.house); fh = R(2.8, 3.2); cw = R(2.2, 3.2); break;
      case KIND.bloc: style = 4; wall = pickWall(WALLS.bloc); refl = 0.4; fh = 2.9; cw = R(3.0, 3.6); wx = 0.62; break;
      case KIND.commercial: style = rng() < 0.3 ? 1 : 3; wall = style === 1 ? [R(0.02, 0.05), R(0.04, 0.07), R(0.06, 0.1)] : rng() < 0.5 ? [0.5, 0.5, 0.5] : [0.08, 0.08, 0.09]; refl = style === 1 ? 0.85 : 0.65; fh = R(3.4, 3.9); cw = R(3, 4.2); wx = style === 1 ? 0.92 : 1.0; break;
      case KIND.industrial: wall = [R(0.22, 0.34), R(0.22, 0.34), R(0.22, 0.32)]; fh = R(5, 6); cw = R(5, 7); wx = 0.28; break;
      case KIND.civic: wall = [R(0.46, 0.56), R(0.42, 0.5), R(0.36, 0.44)]; fh = R(3.8, 4.4); cw = R(3.4, 4.2); wx = 0.5; break;
      default: wall = [R(0.5, 0.58), R(0.48, 0.54), R(0.44, 0.5)]; fh = R(4.5, 5.5); cw = R(3.6, 4.4); wx = 0.3;
    }
    function pickWall(list) { const c = list[Math.floor(rng() * list.length)]; return [c[0] * R(0.9, 1.1), c[1] * R(0.9, 1.1), c[2] * R(0.9, 1.1)]; }
    // the gable roof of a house sits on top of the walls
    const ridge = roof ? Math.min(wid * 0.34, 3.4) : 0;
    let H = Math.max(fh, Math.round((h - ridge) / fh) * fh);
    const shop = kind === KIND.industrial || kind === KIND.house ? 0 : clamp(shopRaw / 15 * 1.1 + R(-0.1, 0.1), 0, 1);
    G.cube.push(TM.yaw(x, H / 2, z, len, H, wid, yaw), [...wall, refl], [MAT.building, 0, seed, shop], [style, fh, cw, wx]);
    collider(x, 0, z, len / 2, wid / 2, H + ridge, ang);
    footBox(x, z, u[0], u[1], len / 2, wid / 2);
    const top = H + ridge;
    bTop.set(i, top);
    const det = Q.details, facing = [roadWithin(x + v[0] * (wid / 2 + 7), z + v[1] * (wid / 2 + 7), 12), roadWithin(x - v[0] * (wid / 2 + 7), z - v[1] * (wid / 2 + 7), 12)];
    const trim = [wall[0] * 0.78, wall[1] * 0.78, wall[2] * 0.78];
    if (!roof && kind !== KIND.industrial && det > 0.3) basic(G.cube, TM.yaw(x, H + 0.3, z, len + 0.5, 0.6, wid + 0.5, yaw), trim);   // parapet
    if ((kind === KIND.civic || kind === KIND.church || kind === KIND.commercial) && det > 0.3) {
      basic(G.cube, TM.yaw(x, 0.45, z, len + 0.5, 0.9, wid + 0.5, yaw), [wall[0] * 0.55, wall[1] * 0.55, wall[2] * 0.55]);      // plinth
      if (kind !== KIND.commercial && H > 7) basic(G.cube, TM.yaw(x, H - 0.5, z, len + 1.0, 0.5, wid + 1.0, yaw), trim);           // cornice
    }
    if (kind === KIND.bloc && det > 0.5) {
      // balcony slabs on the sides that face a street, one per floor
      for (const sd of [1, -1]) {
        if (!facing[sd > 0 ? 0 : 1]) continue;
        for (let k = 2; k * fh < H - 1; k++)
          basic(G.cube, TM.yaw(x + v[0] * sd * (wid / 2 + 0.55), k * fh - 0.1, z + v[1] * sd * (wid / 2 + 0.55), len * 0.9, 0.14, 1.1, yaw), [wall[0] * 0.85, wall[1] * 0.85, wall[2] * 0.85]);
      }
      // stairwell and lift housings on the roof
      for (const t of len > 40 ? [-0.3, 0.3] : [0]) basic(G.cube, TM.yaw(x + u[0] * len * t, top + 1.4, z + u[1] * len * t, 3.4, 2.8, Math.min(3.4, wid * 0.4), yaw), trim);
    }
    if (roof && rd() < 0.55) basic(G.cube, TM.yaw(x + u[0] * len * Rd(-0.3, 0.3), H + ridge * 0.95 + 0.5, z + u[1] * len * Rd(-0.3, 0.3), 0.7, 1.5, 0.7, yaw), [0.28, 0.12, 0.08]);   // chimney
    if (shop > 0.3 && det > 0.3 && kind !== KIND.house)
      for (const sd of [1, -1]) {
        if (!facing[sd > 0 ? 0 : 1] || rd() < 0.15) continue;
        const ac = pickd([[0.55, 0.1, 0.1], [0.1, 0.25, 0.5], [0.12, 0.4, 0.25], [0.5, 0.4, 0.12], [0.4, 0.4, 0.42]]);
        basic(G.cube, TM.yaw(x + v[0] * sd * (wid / 2 + 0.7), 3.7, z + v[1] * sd * (wid / 2 + 0.7), len * 0.85, 0.12, 1.5, yaw), ac);   // awning
      }
    if (roof) {
      const tile = pickd([[0.3, 0.1, 0.06], [0.26, 0.09, 0.06], [0.2, 0.12, 0.09], [0.14, 0.14, 0.15]]);
      basic(G.prism, TM.yaw(x, H + ridge / 2, z, len + 0.7, ridge, wid + 0.8, yaw), tile);
    }
    // light spilling out of shop windows onto the pavement
    if (shop > 0.3) {
      for (let t = -len / 2 + 3; t < len / 2 - 2; t += 7)
        for (const s of [-1, 1]) {
          const d = wid / 2 + 2;
          if (!facing[s > 0 ? 0 : 1]) continue;
          splat(x + u[0] * t + v[0] * s * d, z + u[1] * t + v[1] * s * d, 0.5 * shop, 0.36 * shop, 0.22 * shop, 3.5);
        }
    }
    if (kind === KIND.industrial && len * wid > 700) {
      // floodlit yards: a white-orange light on every corner
      for (const [a, b] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        const px = x + u[0] * a * (len / 2 + 1) + v[0] * b * (wid / 2 + 1), pz = z + u[1] * a * (len / 2 + 1) + v[1] * b * (wid / 2 + 1);
        sprite(px, Math.min(H, 9), pz, [1, 0.85, 0.65], 4.5, 0.8);
        splat(px, pz, 0.8, 0.62, 0.4, 7);
      }
    }
    if (kind === KIND.church) {
      const r = Math.min(wid * 0.3, 4.5);
      basic(G.cyl, TM.box(x, top + r * 0.5, z, r * 1.5, r, r * 1.5), [0.34, 0.33, 0.3]);
      basic(G.sphere, TM.box(x, top + r * 1.1, z, r * 1.6, r * 1.6, r * 1.6), [0.1, 0.2, 0.18]);
      basic(G.cone, TM.box(x, top + r * 2.6, z, r * 0.5, r * 1.8, r * 0.5), [0.1, 0.2, 0.18]);
      sprite(x, top + r * 3.6, z, [1, 0.8, 0.5], 5, 0.7);
      splat(x, z, 0.5, 0.4, 0.25, 12);
    }
    if (top > 55) {
      for (const [a, b] of [[-1, -1], [1, 1]]) sprite(x + u[0] * a * len * 0.4 + v[0] * b * wid * 0.4, top + 0.6, z + u[1] * a * len * 0.4 + v[1] * b * wid * 0.4, [1, 0.08, 0.04], 5, 0.8, ANIM.blink, 0, rd());
    }
    // rooftops: water tanks, machinery, aerials, billboards, blade signs
    if (!roof && kind !== KIND.house) {
      if (top > 12 && top < 60 && rd() < 0.3 * Q.details) {
        const px = x + u[0] * Rd(-len * 0.3, len * 0.3), pz = z + u[1] * Rd(-len * 0.3, len * 0.3), r = Rd(2.5, 4);
        basic(G.cyl, TM.box(px, top + 2.4, pz, r, 3.2, r), [0.22, 0.14, 0.09]);
        basic(G.cone, TM.box(px, top + 4.5, pz, r * 1.05, 1.2, r * 1.05), [0.18, 0.12, 0.08]);
      }
      if (rd() < 0.5 * Q.details) {
        const sx = Rd(1.5, Math.min(5, len * 0.25)), sz = Rd(1.5, Math.min(5, wid * 0.25)), sy = Rd(1.2, 2.4);
        basic(G.cube, TM.yaw(x + u[0] * Rd(-len * 0.3, len * 0.3), top + sy / 2, z + u[1] * Rd(-len * 0.3, len * 0.3), sx, sy, sz, yaw), [0.16, 0.16, 0.17]);
      }
      if (top > 20 && top < 70 && rd() < 0.12 * Q.details) {
        const ah = Rd(8, 18), px = x + u[0] * Rd(-len * 0.3, len * 0.3), pz = z + u[1] * Rd(-len * 0.3, len * 0.3);
        basic(G.cyl, TM.box(px, top + ah / 2, pz, 0.3, ah, 0.3), [0.25, 0.25, 0.27]);
        sprite(px, top + ah, pz, [1, 0.1, 0.05], 3, 0.5, ANIM.blink, 0, rd());
      }
      if (shop > 0.55 && top < 40 && rd() < 0.14 * Q.details && len > 14) {
        const c = pickd(NEON), bw = Math.min(14, len * 0.7), bh = Rd(4, 7), s = rd() < 0.5 ? -1 : 1;
        G.cube.push(TM.yaw(x + v[0] * s * (wid / 2 - 1), top + 2 + bh / 2, z + v[1] * s * (wid / 2 - 1), bw, bh, 0.4, yaw), [...c, Rd(2, 3.5)], [MAT.neon, 0, seedN++, 1]);
        basic(G.cube, TM.box(x + v[0] * s * (wid / 2 - 1), top + 1, z + v[1] * s * (wid / 2 - 1), 0.3, 2, 0.3), [0.1, 0.1, 0.1]);
      }
    }
    if (shop > 0.45 && h > 7 && h < 80 && rd() < 0.55 * Q.details && len > 8) {
      const c = pickd(NEON), sh = Rd(4, 8), y = Rd(5.5, Math.max(5.6, Math.min(13, top - sh / 2 - 1))) + sh / 2, s = rd() < 0.5 ? -1 : 1, t = Rd(-len / 2 + 2, len / 2 - 2);
      if (y + sh / 2 < top) {
        const sx = x + u[0] * t + v[0] * s * (wid / 2 + 0.9), sz = z + u[1] * t + v[1] * s * (wid / 2 + 0.9);
        G.cube.push(TM.yaw(sx, y, sz, 1.7, sh, 0.35, yaw + (s > 0 ? -Math.PI / 2 : Math.PI / 2)), [...c, Rd(2.5, 4.5)], [MAT.neon, 0, seedN++, 0]);
        splat(sx, sz, c[0] * 0.35, c[1] * 0.35, c[2] * 0.35, 4);
      }
    }
    if (top > 30) tallest.push({ x, z, top });
  }
  function pointInPoly(x, z, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  // ---------- 4. the street network ----------
  await tick(0.35, 'Laying the streets');
  // width, lanes and the height of each class: bigger roads sit a hair higher, so crossings never flicker
  const WID = (r) => {
    const tot = r.ow ? Math.max(1, r.ln) : Math.max(2, r.ln + (r.ln & 1));
    r.tot = tot;
    switch (r.cls) {
      case 0: return tot * 3.5 + 1;
      case 1: return tot * 3.4 + 1.2;
      case 2: return tot * 3.3 + 1;
      case 3: return Math.min(tot * 3.2 + 0.8, 9);
      case 4: return r.ow ? 4.6 : 6.2;
      case 5: return 3.8;
      default: return 6;
    }
  };
  const yOff = (r) => (7 - r.cls) * 0.012 + (r.id % 5) * 0.002;
  const key = (p) => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
  const junctions = new Map();
  for (const r of roads) {
    r.w = WID(r);
    if (r.ped || r.cls >= 6) continue;
    r.pts.forEach((p, i) => {
      const k = key(p);
      let nd = junctions.get(k);
      if (!nd) junctions.set(k, (nd = { x: p[0], z: p[1], arms: [] }));
      for (const q of [r.pts[i - 1], r.pts[i + 1]]) if (q) nd.arms.push({ ang: Math.atan2(q[1] - p[1], q[0] - p[0]), w: r.w, cls: r.cls, y: yOff(r) });
    });
  }
  const jCell = new Map();
  const jKey = (x, z) => Math.floor(x / 40) * 100003 + Math.floor(z / 40);
  const nearJunction = (x, z, extra = 3) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const l = jCell.get(jKey(x + dx * 40, z + dz * 40));
      if (l) for (const j of l) if ((j.x - x) ** 2 + (j.z - z) ** 2 < (j.r + extra) ** 2) return true;
    }
    return false;
  };
  const signalCell = new Map();
  for (const [sx, sz] of city.g) { const k = jKey(sx, sz); if (!signalCell.has(k)) signalCell.set(k, []); signalCell.get(k).push([sx, sz]); }
  const signalNear = (x, z) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      for (const s of signalCell.get(jKey(x + dx * 40, z + dz * 40)) || []) if ((s[0] - x) ** 2 + (s[1] - z) ** 2 < 900) return true;
    return false;
  };
  for (const nd of junctions.values()) {
    if (nd.arms.length < 3) continue;
    nd.w = Math.max(...nd.arms.map((a) => a.w));
    nd.r = nd.w / 2 + 0.3;
    nd.y = Math.max(...nd.arms.map((a) => a.y)) + 0.004;
    const k = jKey(nd.x, nd.z);
    if (!jCell.has(k)) jCell.set(k, []);
    jCell.get(k).push(nd);
    G.cyl.push(TM.box(nd.x, ROADY + nd.y - 0.15, nd.z, nd.r * 2, 0.3, nd.r * 2), [0, 0, 0, 0], [MAT.road, 0, 0, 0], [1, nd.w, 0, 0]);
    // zebra crossings where the bigger streets meet
    if (Math.min(...nd.arms.map((a) => a.cls)) <= 3 && (signalNear(nd.x, nd.z) || rd() < 0.3))
      for (const a of nd.arms) {
        if (a.w < 6 || a.cls > 4) continue;
        const d = nd.r + 2.4;
        G.cube.push(TM.yaw(nd.x + Math.cos(a.ang) * d, ROADY + a.y + 0.006 - 0.15, nd.z + Math.sin(a.ang) * d, 2.8, 0.3, a.w - 0.4, -a.ang), [0, 0, 0, 0], [MAT.road, 0, 0, 0], [2, a.w - 0.4, 0, 0]);
      }
  }

  const named = [];                     // street names for the on-screen label
  const runs = [];                      // straight stretches for the traffic
  for (const r of roads) {
    const pts = r.pts, y = ROADY + yOff(r);
    if (r.ped) {
      // pedestrian streets: paving, no asphalt
      for (let i = 0; i + 1 < pts.length; i++) layLine(pts[i], pts[i + 1], r.w / 2 + 1, 6);
      lampsAlong(pts, Q.lampStep * 0.8, 3.4, 5.5, false);
      continue;
    }
    if (r.cls >= 6) continue;
    // pavements on both sides, painted into the ground
    if (r.cls <= 4) for (let i = 0; i + 1 < pts.length; i++) layLine(pts[i], pts[i + 1], r.w / 2 + 2.4, 6);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.3) continue;
      const ang = Math.atan2(bz - az, bx - ax), e = Math.min(r.w * 0.3, 1.2);
      G.cube.push(TM.yaw((ax + bx) / 2, y - 0.15, (az + bz) / 2, L + e * 2, 0.3, r.w, -ang), [0, 0, 0, 0], [MAT.road, 0, 0, 0], [0, r.w, r.tot, r.ow]);
      if (r.nm && r.cls <= 4) named.push({ n: r.nm, ax, az, bx, bz, w: r.w });
    }
    // straight runs for the cars: stretches where every vertex stays within a metre of the line
    for (let i = 0; i + 1 < pts.length;) {
      let j = i + 1, len = 0;
      while (j < pts.length) {
        const [ax, az] = pts[i], [bx, bz] = pts[j], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
        let ok = l < 240;
        for (let k = i + 1; ok && k < j; k++) ok = Math.abs((pts[k][0] - ax) * dz - (pts[k][1] - az) * dx) / (l || 1) < 0.6;
        if (!ok) break;
        len = l; j++;
      }
      j = Math.max(j - 1, i + 1);
      if (len >= 26) runs.push({ ax: pts[i][0], az: pts[i][1], bx: pts[j][0], bz: pts[j][1], L: len, r });
      i = j;
    }
    // street lamps and street trees along the way
    const lampStep = Q.lampStep * [1.3, 1, 1, 0.85, 0.95, 2.2][r.cls];
    const lampsOn = r.cls <= 4 || r.cls === 5 && false;
    let acc = lampStep * 0.5, accT = 6, side = rd() < 0.5 ? 1 : -1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const dx = (bx - ax) / L, dz = (bz - az) / L, nx = -dz, nz = dx;
      for (let s = 0; s < L; s += 1) {
        acc -= 1; accT -= 1;
        if (acc <= 0 && lampsOn) {
          acc += lampStep;
          const x = ax + dx * s, z = az + dz * s;
          if (!nearJunction(x, z, 4)) {
            const sides = r.cls <= 2 ? [1, -1] : [(side = -side)];
            for (const sd of sides) {
              const px = x + nx * sd * (r.w / 2 + 0.9), pz = z + nz * sd * (r.w / 2 + 0.9);
              if (!footAt(px, pz)) streetLamp(px, pz, -nx * sd, -nz * sd, r.cls <= 2 ? 9 : 7);
            }
          }
        }
        if (accT <= 0) {
          accT += 15;
          const x = ax + dx * s, z = az + dz * s;
          if (r.cls >= 1 && r.cls <= 4 && !nearJunction(x, z, 6))
            for (const sd of [1, -1]) {
              if (rd() > 0.5 * Q.trees) continue;
              const px = x + nx * sd * (r.w / 2 + 3.2), pz = z + nz * sd * (r.w / 2 + 3.2);
              if (!footAt(px, pz)) tree(px, pz, Rd(0.8, 1.1));
            }
        }
      }
    }
  }
  function layLine(a, b, rad, type) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 1.2));
    for (let k = 0; k <= n; k++) layDiskType(lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n), rad, type);
  }
  // footpaths: pale tracks across the grass
  for (const pts of foots) for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s < L; s += 1.2) layDisk(ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L, 1.4, 1, 0.9);
  }

  // lamps along a path, on alternating sides, at a distance off the centre line
  function lampsAlong(pts, step, off, h, anyGround) {
    let acc = step * 0.5, side = 1;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const dx = (bx - ax) / L, dz = (bz - az) / L;
      for (let s = 0; s < L; s += 1) {
        if ((acc -= 1) > 0) continue;
        acc += step; side = -side;
        const px = ax + dx * s - dz * off * side, pz = az + dz * s + dx * off * side;
        if (footAt(px, pz) || nearJunction(px, pz, 2)) continue;
        if (!anyGround && layAt(px, pz, 0) === 0) continue;
        streetLamp(px, pz, 0, 0, h);
      }
    }
  }
  // lamps along the footpaths that cross parks, and over the car parks and squares
  for (const pts of foots) lampsAlong(pts, Q.lampStep * 1.3, 0.9, 4.2, false);
  for (const a of areas) {
    if (a.type !== AREA.paved || polyArea(a.pts) < 900) continue;
    const [x0, z0, x1, z1] = bounds(a.pts);
    for (let x = x0 + 8; x < x1; x += Q.lampStep * 0.9)
      for (let z = z0 + 8; z < z1; z += Q.lampStep * 0.9)
        if (pointInPoly(x, z, a.pts) && !footAt(x, z)) streetLamp(x, z, 0, 0, 5.5);
  }

  // ---------- a double-sided billboard that spells CERBU on the roof of the building at 44.318713, 23.801919 ----------
  {
    const [tx, tz] = geo(44.318713, 23.801919);
    let bi = -1, bd = 1e9;
    for (let i = 0; i < B.length; i += 8) {
      if (!bTop.has(i)) continue;
      const x = B[i] / 4, z = B[i + 1] / 4, len = B[i + 2] / 2, wid = B[i + 3] / 2, a = (B[i + 4] / 255) * Math.PI;
      const dx = tx - x, dz = tz - z, lu = dx * Math.cos(a) + dz * Math.sin(a), lv = -dx * Math.sin(a) + dz * Math.cos(a);
      const out = Math.max(Math.abs(lu) - len / 2, Math.abs(lv) - wid / 2, 0);   // 0 when the point is inside
      if (out < bd) { bd = out; bi = i; }
    }
    if (bi >= 0 && bd < 40) {
      const x = B[bi] / 4, z = B[bi + 1] / 4, len = B[bi + 2] / 2, wid = B[bi + 3] / 2, a = (B[bi + 4] / 255) * Math.PI, top = bTop.get(bi);
      const u = [Math.cos(a), Math.sin(a)], v = [-Math.sin(a), Math.cos(a)];
      // face the long side that looks towards the nearest street
      let near = [1e9, 1e9], best = 1e9;
      for (const rd2 of roads) for (const p of rd2.pts) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < best) { best = d; near = p; } }
      const side = (near[0] - x) * v[0] + (near[1] - z) * v[1] > 0 ? 1 : -1;
      const N = [v[0] * side, v[1] * side], right = [N[1], -N[0]], yawR = Math.atan2(-right[1], right[0]);
      const FONT = { C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'], E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
        R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
        U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'] };
      const word = 'CERBU', cols = word.length * 6 - 1, cs = clamp((len * 0.85) / cols, 0.55, 1.5);
      const W = cols * cs + 2 * cs, Hh = 7 * cs + 2 * cs, base = top + 3.2 + Hh / 2;
      const at = (xo, yo, off) => [x + N[0] * (wid / 2 - 1.2 + off) + right[0] * xo, base + yo, z + N[1] * (wid / 2 - 1.2 + off) + right[1] * xo];
      const pc = at(0, 0, 0);
      basic(G.cube, TM.yaw(pc[0], pc[1], pc[2], W, Hh, 0.5, yawR), [0.03, 0.03, 0.04]);
      for (const f of [-0.35, 0.35]) { const p = at(f * W, 0, 0); basic(G.cube, TM.box(p[0], top + 1.6, p[2], 0.3, 3.2, 0.3), [0.1, 0.1, 0.1]); }
      const hue = [0.35, 0.75, 1.0];
      // the word on both faces; seen from behind the letters are mirrored along the panel so that they read the right way round
      for (const sd of [1, -1]) {
        for (let li = 0; li < word.length; li++) for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
          if (FONT[word[li]][row][col] !== '1') continue;
          const xo = (li * 6 + col - (cols - 1) / 2) * cs, yo = (3 - row) * cs, p = at(sd * xo, yo, 0.4 * sd);
          emissive(G.cube, TM.yaw(p[0], p[1], p[2], cs * 0.9, cs * 0.9, 0.3, yawR), hue, 4.5);
        }
        for (let k = 0; k < 6; k++) { const p = at(sd * (k - 2.5) * (W / 7), 0, 1.2 * sd); sprite(p[0], p[1], p[2], hue, 5, 1.2 * cs); }
      }
      collider(pc[0], top + 1.5, pc[2], W / 2, 0.4, base + Hh / 2, Math.atan2(right[1], right[0]));
      splat(x + N[0] * (wid / 2 + 6), z + N[1] * (wid / 2 + 6), 0.3, 0.6, 1.0, 14);
      splat(x - N[0] * (wid / 2 - 8), z - N[1] * (wid / 2 - 8), 0.2, 0.4, 0.66, 12);
    }
  }

  // ---------- 5. trees: parks, woods and gardens ----------
  await tick(0.5, 'Planting the parks');
  function bounds(pts) { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return [x0, z0, x1, z1]; }
  function polyArea(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
  let treeCount = 0;
  const DENS = { [AREA.park]: 230, [AREA.wood]: 55, [AREA.grave]: 260, [AREA.residential]: 2800, [AREA.farm]: 0, [AREA.pitch]: 0 };
  for (const a of areas) {
    const d = DENS[a.type];
    if (!d) continue;
    const [x0, z0, x1, z1] = bounds(a.pts), n = (polyArea(a.pts) / d) * Q.trees * (a.type === AREA.residential ? 0.7 : 1);
    for (let k = 0; k < n; k++) {
      const x = Rd(x0, x1), z = Rd(z0, z1);
      if (!pointInPoly(x, z, a.pts)) continue;
      if (footAt(x, z) || footAt(x + 3, z) || footAt(x, z + 3) || layAt(x, z, 0) === 6 || layAt(x, z, 1) > 40 || layAt(x, z, 3) > 8) continue;
      tree(x, z, Rd(0.9, 1.6), rd() < (a.type === AREA.wood ? 0.35 : 0.2));
      treeCount++;
    }
  }

  // ---------- 6. the stadiums ----------
  await tick(0.6, 'Lighting the stadiums');
  for (const [sx, sz, L, W, a, nm] of stadiumBoxes) {
    const c = Math.cos(a), s = Math.sin(a), rx = L / 2, rz = W / 2;
    const pt = (t, k, y = 0) => [sx + c * Math.cos(t) * rx * k - s * Math.sin(t) * rz * k, sz + s * Math.cos(t) * rx * k + c * Math.sin(t) * rz * k];
    // grass inside the bowl
    const pitch = [];
    for (let k = 0; k < 40; k++) pitch.push(pt((k / 40) * Math.PI * 2, 0.5));
    layPoly(pitch, 2);
    // three raked rings of stands, and a glowing rim along the roof
    const tiers = [[0.62, 0.78, 7], [0.76, 0.9, 13], [0.88, 1.0, 19]];
    const N = 44;
    for (const [k0, k1, h] of tiers)
      for (let k = 0; k < N; k++) {
        const t0 = (k / N) * Math.PI * 2, t1 = ((k + 1) / N) * Math.PI * 2, km = (k0 + k1) / 2;
        const A = pt(t0, km), Bp = pt(t1, km), len = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]) + 0.6;
        const ang = Math.atan2(Bp[1] - A[1], Bp[0] - A[0]);
        basic(G.cube, TM.yaw((A[0] + Bp[0]) / 2, h / 2, (A[1] + Bp[1]) / 2, len, h, (k1 - k0) * Math.min(rx, rz) * 1.05, -ang), [0.28, 0.28, 0.3]);
        collider((A[0] + Bp[0]) / 2, 0, (A[1] + Bp[1]) / 2, len / 2, (k1 - k0) * Math.min(rx, rz) * 0.52, h, ang);
        if (k0 > 0.85) emissive(G.cube, TM.yaw((A[0] + Bp[0]) / 2, h + 0.3, (A[1] + Bp[1]) / 2, len, 0.5, 0.5, -ang), [0.9, 0.95, 1], 3.5);
      }
    // floodlight masts at the corners
    for (const t of [0.8, 2.34, 3.94, 5.48]) {
      const [mx, mz] = pt(t, 1.04);
      basic(G.cyl, TM.box(mx, 20, mz, 1.2, 40, 1.2), [0.3, 0.3, 0.32]);
      collider(mx, 0, mz, 0.6, 0.6, 40, 0);
      for (let i = -2; i <= 2; i++) for (let j = 0; j < 2; j++) sprite(mx + i * 1.2, 40 + j * 1.2, mz, [1, 0.97, 0.9], 7, 1.0);
    }
    // the pitch is floodlit
    for (let x = -rx * 0.5; x < rx * 0.5; x += 14)
      for (let z = -rz * 0.5; z < rz * 0.5; z += 14) splat(sx + c * x - s * z, sz + s * x + c * z, 0.95, 0.98, 0.9, 14);
  }

  // ---------- 7. chimneys and towers ----------
  for (const [x, z, h, t] of city.c) {
    basic(G.cyl, TM.box(x, h / 2, z, t === 0 ? 4 : 3, h, t === 0 ? 4 : 3), [0.3, 0.3, 0.32]);
    collider(x, 0, z, 2, 2, h, 0);
    sprite(x, h + 0.6, z, [1, 0.08, 0.04], 8, 1.1, ANIM.blink, 0, rd());
  }

  // ---------- 8. the railway and the tram lines ----------
  await tick(0.65, 'Running the trains');
  const BED = [0.05, 0.045, 0.04], RAIL = [0.34, 0.33, 0.32];
  const tracks = [];
  for (const rl of rails) {
    const pts = rl.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
      if (L < 0.5) continue;
      const ang = Math.atan2(bz - az, bx - ax), mx = (ax + bx) / 2, mz = (az + bz) / 2, nx = -Math.sin(ang), nz = Math.cos(ang);
      if (!rl.tram) basic(G.cube, TM.yaw(mx, 0.12, mz, L + 0.4, 0.24, 4.6, -ang), BED);
      for (const s of [-0.72, 0.72]) basic(G.cube, TM.yaw(mx + nx * s, rl.tram ? 0.12 : 0.28, mz + nz * s, L + 0.3, 0.1, 0.12, -ang), RAIL);
      if (L > (rl.tram ? 70 : 150)) tracks.push({ ax, az, bx, bz, L, tram: rl.tram });
    }
  }
  let vehicles = 0;
  for (const tr of tracks) {
    if (rd() > (tr.tram ? 0.5 : 0.35)) continue;
    const ang = Math.atan2(tr.bz - tr.az, tr.bx - tr.ax), pack = (ang < 0 ? ang + Math.PI * 2 : ang) + 8 * (tr.tram ? 9 : 22);
    const q = [tr.ax, tr.az, pack, tr.L], cars = tr.tram ? 2 : 4, len = tr.tram ? 13 : 15, y0 = tr.tram ? 1.9 : 2.1;
    const s0 = Rd(0, tr.L);
    for (let k = 0; k < cars; k++) {
      const ph = s0 - k * (len + 0.5);
      const col = tr.tram ? [0.75, 0.6, 0.1, 0] : [0.7, 0.72, 0.75, 0];
      G.cube.push(TM.box(0, y0, 0, len, tr.tram ? 3.2 : 3.4, tr.tram ? 2.5 : 3.0), col, [MAT.train, ANIM.car, seedN++, ph], q);
      if (k === 0) for (const z of [-0.9, 0.9]) sprite(len / 2 + 0.1, 1.2, z, [1, 0.95, 0.85], 6, 0.5, ANIM.car, 1, ph, q);
      if (k === cars - 1) for (const z of [-0.9, 0.9]) sprite(-len / 2 - 0.1, 1.2, z, [1, 0.06, 0.03], 4, 0.4, ANIM.car, -1, ph, q);
    }
    vehicles++;
  }

  // ---------- 9. traffic ----------
  await tick(0.75, 'Starting the traffic');
  const CARS = [[0.5, 0.05, 0.04], [0.06, 0.07, 0.09], [0.6, 0.6, 0.62], [0.12, 0.2, 0.35], [0.03, 0.03, 0.03], [0.35, 0.35, 0.37], [0.05, 0.18, 0.12], [0.55, 0.38, 0.05]];
  const dens = [1, 1, 1, 1.2, 2.4, 4];
  let expected = 0;
  for (const rn of runs) expected += (rn.L * (rn.r.ow ? rn.r.tot : rn.r.tot)) * (1 / dens[rn.r.cls]);
  const thin = Math.min(1, Q.carCap / Math.max(1, (expected / (Q.carGap + 9)) * 1.0));
  let carCount = 0;
  function lane(ax, az, bx, bz, off, rn) {
    const L = rn.L, dx = (bx - ax) / L, dz = (bz - az) / L;
    const x0 = ax - dz * off, z0 = az + dx * off;           // the right-hand side of the direction of travel
    let ang = Math.atan2(dz, dx); if (ang < 0) ang += Math.PI * 2;
    const fast = rn.r.cls <= 2, speed = Math.round(fast ? Rd(12, 17) : Rd(6, 11));
    const gap = (Q.carGap * dens[rn.r.cls]) / thin;
    for (let s = Rd(0, gap); s < L - 8; s += gap * Rd(0.4, 1.6) + 9) {
      const q = [x0, z0, ang + 8 * speed, L], bus = rn.r.cls <= 2 && rd() < 0.05;
      const det = Q.details;
      const wheel = (x, z, rad = 0.33) => basic(G.cyl, TM.seg(x, rad, z - 0.15, x, rad, z + 0.15, 2 * rad), [0.02, 0.02, 0.022], ANIM.car, q, s);
      if (bus) {
        G.cube.push(TM.box(0, 1.8, 0, 11, 2.9, 2.5), [0.75, 0.75, 0.72, 0], [MAT.train, ANIM.car, seedN++, s], q);
        if (det > 0.3) {
          for (const x of [3.6, -3.4]) for (const z of [-1.15, 1.15]) wheel(x, z, 0.5);
          basic(G.cube, TM.box(-1, 3.4, 0, 3.2, 0.4, 1.6), [0.6, 0.6, 0.62], ANIM.car, q, s);
          emissive(G.cube, TM.box(5.52, 2.7, 0, 0.1, 0.45, 1.8), [1, 0.65, 0.15], 3, ANIM.car, q, s);
        }
        for (const z of [-0.8, 0.8]) { sprite(5.55, 0.9, z, [1, 0.92, 0.8], 4, 0.4, ANIM.car, 1, s, q); sprite(-5.55, 0.9, z, [1, 0.06, 0.03], 3, 0.32, ANIM.car, -1, s, q); }
      } else {
        const kr = rd(), taxi = rd() < 0.1, col = taxi ? [0.75, 0.55, 0.05] : pickd(CARS);
        // sedan, hatchback, SUV or van
        let L = 4.5, W = 1.85, bh = 0.7, by = 0.68, cl = 2.4, cx = -0.35, ch = 0.6, cy = 1.28, cwid = 1.62;
        if (kr < 0.2) { L = 3.9; cl = 2.6; cx = -0.45; }
        else if (kr < 0.35) { L = 4.7; W = 1.95; bh = 0.95; by = 0.82; cl = 3.0; cx = -0.25; ch = 0.72; cy = 1.65; cwid = 1.8; }
        else if (kr < 0.45) { L = 5.3; W = 2.0; bh = 1.5; by = 1.08; cl = 1.0; cx = 2.0; ch = 0.7; cy = 1.88; cwid = 1.8; }
        G.cube.push(TM.box(0, by, 0, L, bh, W), [...col, 0], [MAT.basic, ANIM.car, seedN++, s], q);
        G.cube.push(TM.box(cx, cy, 0, cl, ch, cwid), [0.02, 0.022, 0.026, 0], [MAT.basic, ANIM.car, seedN++, s], q);
        if (det > 0.3) for (const x of [L * 0.31, -L * 0.31]) for (const z of [-(W / 2 - 0.08), W / 2 - 0.08]) wheel(x, z);
        if (det > 0.7) for (const sd of [1, -1]) basic(G.cube, TM.box(sd * L / 2, 0.45, 0, 0.25, 0.3, W), [0.05, 0.05, 0.05], ANIM.car, q, s);
        if (taxi) emissive(G.cube, TM.box(0, cy + ch / 2 + 0.12, 0, 0.5, 0.2, 0.35), [1, 0.85, 0.3], 3, ANIM.car, q, s);
        for (const z of [-0.62, 0.62]) { sprite(L / 2, by + 0.1, z * W / 1.86, [1, 0.92, 0.8], 4, 0.35, ANIM.car, 1, s, q); sprite(-L / 2, by + 0.17, z * W / 1.86, [1, 0.06, 0.03], 3, 0.3, ANIM.car, -1, s, q); }
      }
      carCount++;
    }
  }
  for (const rn of runs) {
    const r = rn.r, lw = (r.w - 1) / (r.ow ? r.tot : r.tot);
    if (r.cls === 5 && rd() < 0.5) continue;
    if (r.ow) {
      for (let k = 0; k < r.tot; k++) lane(rn.ax, rn.az, rn.bx, rn.bz, (k + 0.5 - r.tot / 2) * lw, rn);
    } else {
      const per = Math.max(1, Math.floor(r.tot / 2));
      for (let k = 0; k < per; k++) {
        lane(rn.ax, rn.az, rn.bx, rn.bz, (k + 0.5) * lw, rn);
        lane(rn.bx, rn.bz, rn.ax, rn.az, (k + 0.5) * lw, rn);
      }
    }
  }

  // ---------- 10. bake the ground light and ambient occlusion ----------
  await tick(0.85, 'Baking light');
  const blur = (src, n, rad) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let r = 0; r < n; r++) {
      let acc = 0;
      for (let c = -rad; c < n + rad; c++) {
        if (c + rad < n) acc += src[r * n + c + rad];
        if (c - rad - 1 >= 0) acc -= src[r * n + c - rad - 1];
        if (c >= 0 && c < n) tmp[r * n + c] = acc / (2 * rad + 1);
      }
    }
    for (let c = 0; c < n; c++) {
      let acc = 0;
      for (let r = -rad; r < n + rad; r++) {
        if (r + rad < n) acc += tmp[(r + rad) * n + c];
        if (r - rad - 1 >= 0) acc -= tmp[(r - rad - 1) * n + c];
        if (r >= 0 && r < n) out[r * n + c] = acc / (2 * rad + 1);
      }
    }
    return out;
  };
  const ao = blur(blur(foot, LIGHT_N, 1), LIGHT_N, 1);
  const lightTex = new Uint8Array(LIGHT_N * LIGHT_N * 4);
  for (let i = 0; i < LIGHT_N * LIGHT_N; i++) {
    lightTex[i * 4] = Math.min(255, light[i * 3] * 64);
    lightTex[i * 4 + 1] = Math.min(255, light[i * 3 + 1] * 64);
    lightTex[i * 4 + 2] = Math.min(255, light[i * 3 + 2] * 64);
    lightTex[i * 4 + 3] = Math.round(255 * (1 - 0.7 * Math.min(1, ao[i] * 1.6)));
  }

  // collision: a coarse grid of the building boxes
  const CELL = 64, grid = new Map(), nb = boxes.length / 10;
  for (let i = 0; i < nb; i++) {
    const o = i * 10, hl = boxes[o + 3], hw = boxes[o + 5], cx = boxes[o + 6], cz = boxes[o + 7], c = boxes[o + 8], s = boxes[o + 9];
    const ex = Math.abs(c) * hl + Math.abs(s) * hw, ez = Math.abs(s) * hl + Math.abs(c) * hw;
    for (let gx = Math.floor((cx - ex) / CELL); gx <= Math.floor((cx + ex) / CELL); gx++)
      for (let gz = Math.floor((cz - ez) / CELL); gz <= Math.floor((cz + ez) / CELL); gz++) {
        const k = gx * 100003 + gz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  }

  // street names and neighbourhoods for the label on screen
  const nameGrid = new Map();
  named.forEach((s, i) => {
    const x0 = Math.min(s.ax, s.bx), x1 = Math.max(s.ax, s.bx), z0 = Math.min(s.az, s.bz), z1 = Math.max(s.az, s.bz);
    for (let gx = Math.floor((x0 - 12) / 100); gx <= Math.floor((x1 + 12) / 100); gx++)
      for (let gz = Math.floor((z0 - 12) / 100); gz <= Math.floor((z1 + 12) / 100); gz++) {
        const k = gx * 100003 + gz;
        if (!nameGrid.has(k)) nameGrid.set(k, []);
        nameGrid.get(k).push(i);
      }
  });
  function streetAt(x, z) {
    let best = null, bd = 1e9;
    for (const i of nameGrid.get(Math.floor(x / 100) * 100003 + Math.floor(z / 100)) || []) {
      const s = named[i], dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
      const t = clamp(((x - s.ax) * dx + (z - s.az) * dz) / l2, 0, 1), d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) - s.w / 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best && bd < 22 ? names[best.n - 1] : '';
  }
  function placeAt(x, z) {
    let best = '', bd = 1e9;
    for (const [n, px, pz, k] of city.p) {
      let d = Math.hypot(x - px, z - pz);
      if (k === 2) d = d < 140 ? d * 0.3 : 1e9;
      else if (k === 0) d *= 0.8;
      if (d < bd) { bd = d; best = n; }
    }
    return bd < 1800 ? best : '';
  }

  // ---------- 11. viewpoints (keys 1-6) ----------
  const sq = geo(44.31798, 23.79493), cat = geo(44.31516, 23.79193), stad = geo(44.3140, 23.7843);
  const gara = geo(44.3288, 23.8167), elec = geo(44.3078, 23.8302), lake0 = geo(44.2990, 23.8135);
  let lake = lake0, lakeD = 1e9;
  for (const a of areas) {
    if (a.type !== AREA.water || polyArea(a.pts) < 20000) continue;
    const [x0, z0, x1, z1] = bounds(a.pts), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, d = Math.hypot(cx - lake0[0], cz - lake0[1]);
    if (d < lakeD) { lakeD = d; lake = [cx, cz]; }
  }
  const views = [
    { name: 'Piața Mihai Viteazul', pos: [sq[0] + 10, 2.2, sq[1] + 18], at: [cat[0], 22, cat[1]] },
    { name: 'The old centre from above', pos: [sq[0] + 450, 300, sq[1] + 600], at: [sq[0], 20, sq[1]] },
    { name: 'Parcul Nicolae Romanescu', pos: [lake[0] - 40, 35, lake[1] + 190], at: [lake[0], 0, lake[1]] },
    { name: 'Stadionul Ion Oblemenco', pos: [stad[0] + 150, 75, stad[1] + 210], at: [stad[0], 14, stad[1]] },
    { name: 'Gara Craiova', pos: [gara[0] - 90, 70, gara[1] + 230], at: [gara[0], 8, gara[1]] },
    { name: 'Electroputere and Ford', pos: [elec[0] - 300, 260, elec[1] + 520], at: [elec[0] + 300, 6, elec[1] - 180] },
  ];

  // where you start: street level at 44.318435, 23.800570, looking east-south-east along the street (heading 102 degrees from north)
  const heading = (102 * Math.PI) / 180;
  const start = { pos: [startPt[0], 3.2, startPt[1]], at: [startPt[0] + Math.sin(heading) * 160, 9, startPt[1] - Math.cos(heading) * 160] };

  await tick(0.92, 'Uploading the city');
  return {
    groups: G, layout, lightTex, views, start, center: sq,
    collide: { boxes: new Float32Array(boxes), grid, CELL },
    consts: {},
    label: { street: streetAt, place: placeAt },
    stats: { buildings: buildingCount, cars: carCount, boxes: nb, trees: treeCount, roads: roads.length },
  };
}
