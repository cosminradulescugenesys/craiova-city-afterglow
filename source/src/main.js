// ---------------------------------------------------------------------------
// main.js: startup, the camera and its controls, the time of day and the weather,
// the menu, the six viewpoints, the street / neighbourhood label and the automatic resolution scaling.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const setState = (s) => { document.body.className = s; };

// ---- detail level: step down once if the last start on this level never got going ----
let level = pickLevel();
{
  const p = loadPrefs(), i = LEVEL_ORDER.indexOf(level);
  if (p.pending === level && i > 0) { level = LEVEL_ORDER[i - 1]; p.level = level; delete p.scale; }
  p.pending = level;
  savePrefs(p);
}
const Q = LEVELS[level];
const prefs = loadPrefs();
[...$('q').querySelectorAll('button')].forEach((b, i) => {
  b.classList.toggle('on', LEVEL_ORDER[i] === level);
  b.onclick = () => { const p = loadPrefs(); p.level = LEVEL_ORDER[i]; delete p.scale; delete p.pending; savePrefs(p); location.reload(); };
});
if (!/Chrome|Edg/.test(navigator.userAgent)) $('w').hidden = false;

// ---- time of day: the city fades between these over a few seconds ----
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const TIMES = {
  dusk: {
    label: 'Dusk', skyTop: [0.012, 0.022, 0.085], skyHor: [0.34, 0.13, 0.12], sunDir: norm([-0.55, 0.02, -0.83]), sunCol: [1.3, 0.45, 0.18],
    amb: [0.022, 0.022, 0.045], glow: [0.55, 0.24, 0.14], lit: 0.45, fog: 0.0004, stars: 0.35, exposure: 1.0, beams: 0.5,
  },
  night: {
    label: 'Night', skyTop: [0.003, 0.004, 0.014], skyHor: [0.045, 0.035, 0.07], sunDir: norm([0.35, 0.5, -0.7]), sunCol: [0.07, 0.08, 0.12],
    amb: [0.01, 0.011, 0.02], glow: [0.45, 0.22, 0.12], lit: 0.55, fog: 0.00045, stars: 1, exposure: 1.35, beams: 1,
  },
  dawn: {
    label: 'Dawn', skyTop: [0.06, 0.11, 0.26], skyHor: [0.6, 0.38, 0.36], sunDir: norm([0.75, 0.04, 0.6]), sunCol: [1.4, 0.85, 0.55],
    amb: [0.07, 0.07, 0.1], glow: [0.45, 0.33, 0.3], lit: 0.16, fog: 0.0006, stars: 0.05, exposure: 0.9, beams: 0,
  },
};
TIMES.day = {
  label: 'Day', skyTop: [0.16, 0.34, 0.72], skyHor: [0.62, 0.72, 0.86], sunDir: norm([0.35, 0.72, -0.5]), sunCol: [2.6, 2.3, 1.9],
  amb: [0.26, 0.3, 0.4], glow: [0.12, 0.12, 0.12], lit: 0.03, fog: 0.00028, stars: 0, exposure: 0.55, beams: 0,
};
// 'live' follows the real sun over Craiova; the others are fixed
const TIME_ORDER = ['live', 'day', 'dusk', 'night', 'dawn'];
const WEATHER_ORDER = ['live', 'clear', 'rain'];
const CRAIOVA = { lat: 44.3125, lon: 23.804 };
// elevation of the sun over Craiova right now (degrees), and whether it is before noon
function sunNow(date = new Date()) {
  const rad = Math.PI / 180, d = date.getTime() / 86400000 + 2440587.5 - 2451545;
  const g = (357.529 + 0.98560028 * d) * rad, L = (280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = 23.439 * rad, ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ha = (18.697374558 + 24.06570982441908 * d) * 15 * rad + CRAIOVA.lon * rad - ra, lat = CRAIOVA.lat * rad;
  const elev = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)) / rad;
  return { elev, morning: Math.sin(ha) < 0 };
}
function liveTime() {
  const { elev, morning } = sunNow();
  return elev > 6 ? 'day' : elev > -5 ? (morning ? 'dawn' : 'dusk') : 'night';
}
const craiovaClock = () => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest' }).format(new Date());
const VEC = ['skyTop', 'skyHor', 'sunDir', 'sunCol', 'amb', 'glow'], SCAL = ['lit', 'fog', 'stars', 'exposure', 'beams'];
// every visit starts on live time and live weather; a choice made in the menu only lasts until the page is closed
let timeKey = 'live';
let weatherMode = 'live';
let liveRain = false, liveTemp = null;
const activeTime = () => (timeKey === 'live' ? liveTime() : timeKey);
const isRaining = () => (weatherMode === 'live' ? liveRain : weatherMode === 'rain');
let raining = isRaining();
const env = { rain: raining ? 1 : 0, wet: raining ? 1 : 0 };
for (const k of VEC) env[k] = [...TIMES[activeTime()][k]];
for (const k of SCAL) env[k] = TIMES[activeTime()][k];
// the weather in Craiova right now, from Open-Meteo (free, no key; only the coordinates of Craiova are sent). If it cannot be reached it stays clear.
async function fetchWeather() {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CRAIOVA.lat}&longitude=${CRAIOVA.lon}&current=temperature_2m,weather_code,precipitation`, { cache: 'no-store' });
    const c = (await r.json()).current, code = c.weather_code;
    liveRain = c.precipitation > 0.05 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
    liveTemp = Math.round(c.temperature_2m);
    updateMenuButtons();
  } catch { /* offline: the live weather stays clear */ }
}
function stepEnv(dt) {
  const T = TIMES[activeTime()], k = 1 - Math.exp(-dt * 1.3);
  raining = isRaining();
  for (const key of VEC) for (let i = 0; i < 3; i++) env[key][i] += (T[key][i] - env[key][i]) * k;
  env.sunDir = norm(env.sunDir);
  for (const key of SCAL) env[key] += (T[key] - env[key]) * k;
  env.rain = clamp(env.rain + (raining ? 1 : -1) * dt * 0.5, 0, 1);
  env.wet = clamp(env.wet + (raining ? dt * 0.12 : -dt * 0.03), 0, 1);
}

// ---- build the city ----
const progress = (f, label) => { $('b').style.transform = `scaleX(${f})`; if (label) $('s').textContent = label + '…'; };
progress(0.01, 'Unpacking the map');
const city = await loadCity();
const world = await buildWorld(Q, progress, city);
progress(0.95, 'Compiling shaders');
const R = await createRenderer(canvas, Q, world, (info) => {
  console.error('GPU device lost:', info.message);
  const p = loadPrefs(), i = LEVEL_ORDER.indexOf(level);
  if (i > 0) p.level = LEVEL_ORDER[i - 1];
  delete p.scale; delete p.pending; savePrefs(p);
  setTimeout(() => location.reload(), 400);
});
progress(1, 'Ready');
const audio = new Soundscape();
let soundOn = prefs.sound !== false;

// ---- resolution: starts from what this device settled on last time, then adapts ----
let scale = clamp(prefs.scale || Q.scale, Q.minScale, 1), tooSlowAt = 9;
function applySize() {
  const dpr = Math.min(window.devicePixelRatio || 1, Q.maxDpr);
  const w = Math.max(16, Math.round(innerWidth * dpr * scale)), h = Math.max(16, Math.round(innerHeight * dpr * scale));
  canvas.width = w; canvas.height = h;
  R.resize(w, h);
}
applySize();
addEventListener('resize', applySize);

// ---- camera ----
const cam = { pos: [0, 400, 1500], yaw: 0, pitch: -0.2, vel: [0, 0, 0], fov: 1.05 };
function lookAt(pos, at) {
  const d = [at[0] - pos[0], at[1] - pos[1], at[2] - pos[2]];
  cam.pos = [...pos]; cam.vel = [0, 0, 0];
  cam.yaw = Math.atan2(d[0], -d[2]); cam.pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
}
function orbit(t) {
  const a = 0.5 + t * 0.012, [cx, cz] = world.center;
  lookAt([cx + 1500 * Math.cos(a), 380 + 60 * Math.sin(t * 0.05), cz + 1500 * Math.sin(a)], [cx, 20, cz]);
}
// glide along walls instead of flying into them
function collide(p) {
  const r = 1.4, { boxes, grid, CELL } = world.collide;
  for (let gx = Math.floor((p[0] - r) / CELL); gx <= Math.floor((p[0] + r) / CELL); gx++)
    for (let gz = Math.floor((p[2] - r) / CELL); gz <= Math.floor((p[2] + r) / CELL); gz++) {
      const list = grid.get(gx * 100003 + gz);
      if (!list) continue;
      for (const i of list) {
        // boxes face any way: work in the box's own frame, then turn the push back
        const o = i * 10, c = boxes[o + 8], sn = boxes[o + 9], dx0 = p[0] - boxes[o + 6], dz0 = p[2] - boxes[o + 7];
        const lx = dx0 * c + dz0 * sn, lz = -dx0 * sn + dz0 * c;
        const cx = clamp(lx, boxes[o], boxes[o + 3]), cy = clamp(p[1], boxes[o + 1], boxes[o + 4]), cz = clamp(lz, boxes[o + 2], boxes[o + 5]);
        const dx = lx - cx, dy = p[1] - cy, dz = lz - cz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r) continue;
        let ux = 0, uy = 0, uz = 0;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), push = (r - d) / d;
          ux = dx * push; uy = dy * push; uz = dz * push;
        } else {
          // inside: leave through the nearest face
          const faces = [lx - boxes[o], boxes[o + 3] - lx, p[1] - boxes[o + 1], boxes[o + 4] - p[1], lz - boxes[o + 2], boxes[o + 5] - lz];
          const m = faces.indexOf(Math.min(...faces)), ax = m >> 1, target = m & 1 ? boxes[o + 3 + ax] + r : boxes[o + ax] - r;
          if (ax === 0) ux = target - lx; else if (ax === 1) uy = target - p[1]; else uz = target - lz;
        }
        p[0] += ux * c - uz * sn; p[1] += uy; p[2] += ux * sn + uz * c;
      }
    }
  p[1] = clamp(p[1], 1.5, 1600);
  p[0] = clamp(p[0], -WORLD - 800, WORLD + 800);
  p[2] = clamp(p[2], -WORLD - 800, WORLD + 800);
}

// ---- input ----
const keys = new Set(), touches = new Map();
let entered = false, playing = false, showStats = false;
function toast(msg) {
  const v = $('v');
  v.textContent = msg; v.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => v.classList.remove('on'), 1800);
}
function updateMenuButtons() {
  [...$('t').querySelectorAll('button')].forEach((b, i) => b.classList.toggle('on', TIME_ORDER[i] === timeKey));
  [...$('r').querySelectorAll('button')].forEach((b, i) => b.classList.toggle('on', WEATHER_ORDER[i] === weatherMode));
  $('t').firstElementChild.textContent = timeKey === 'live' ? `Time · ${craiovaClock()}` : 'Time';
  $('r').firstElementChild.textContent = weatherMode === 'live' ? `Weather · ${liveRain ? 'rain' : 'clear'}${liveTemp === null ? '' : ' ' + liveTemp + '°'}` : 'Weather';
}
function setTime(k) { timeKey = k; updateMenuButtons(); }
function setWeather(m) { weatherMode = m; updateMenuButtons(); }
function setSound(on) { soundOn = on; audio.setEnabled(on); const p = loadPrefs(); p.sound = on; savePrefs(p); }
[...$('t').querySelectorAll('button')].forEach((b, i) => { b.onclick = () => setTime(TIME_ORDER[i]); });
[...$('r').querySelectorAll('button')].forEach((b, i) => { b.onclick = () => setWeather(WEATHER_ORDER[i]); });
updateMenuButtons();
fetchWeather();
setInterval(fetchWeather, 600000);
setInterval(updateMenuButtons, 30000);

function enter() {
  if (!entered) { lookAt(world.start.pos, world.start.at); collide(cam.pos); }
  entered = true; playing = true;
  setState('g');
  $('d').textContent = 'Resume';
  audio.start(); audio.setEnabled(soundOn);
  if (!matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.()?.catch?.(() => {});
}
function openMenu() {
  playing = false; keys.clear(); touches.clear();
  setState('m');
  if (document.pointerLockElement) document.exitPointerLock();
}
$('d').onclick = enter;
$('o').onclick = openMenu;
canvas.addEventListener('click', () => { if (playing && !document.pointerLockElement && !matchMedia('(pointer: coarse)').matches) canvas.requestPointerLock?.()?.catch?.(() => {}); });
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) document.body.classList.add('p');
  else { document.body.classList.remove('p'); if (playing) openMenu(); }
});
addEventListener('mousemove', (e) => {
  if (!playing) return;
  if (document.pointerLockElement === canvas || (e.buttons & 1 && e.target === canvas)) {
    cam.yaw += e.movementX * 0.0022;
    cam.pitch = clamp(cam.pitch - e.movementY * 0.0022, -1.52, 1.52);
  }
});
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Escape' && playing && !document.pointerLockElement) { openMenu(); return; }
  if (!playing || e.repeat) return;
  const n = /^Digit([1-6])$/.exec(e.code);
  if (n) { const v = world.views[+n[1] - 1]; lookAt(v.pos, v.at); collide(cam.pos); toast(v.name); }
  if (e.code === 'KeyM') { setSound(!soundOn); toast(soundOn ? 'Sound on' : 'Sound off'); }
  if (e.code === 'KeyH') { showStats = !showStats; $('i').hidden = !showStats; }
  if (e.code === 'KeyT') { setTime(TIME_ORDER[(TIME_ORDER.indexOf(timeKey) + 1) % TIME_ORDER.length]); toast(timeKey === 'live' ? `Craiova now: ${TIMES[activeTime()].label}` : TIMES[timeKey].label); }
  if (e.code === 'KeyR') { setWeather(WEATHER_ORDER[(WEATHER_ORDER.indexOf(weatherMode) + 1) % WEATHER_ORDER.length]); toast(weatherMode === 'live' ? `Craiova now: ${liveRain ? 'rain' : 'clear sky'}` : weatherMode === 'rain' ? 'Rain' : 'Clear sky'); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && playing) touches.set(e.pointerId, [e.clientX, e.clientY]); });
canvas.addEventListener('pointermove', (e) => {
  const t = touches.get(e.pointerId);
  if (!t) return;
  if (touches.keys().next().value === e.pointerId) {
    cam.yaw += (e.clientX - t[0]) * 0.005;
    cam.pitch = clamp(cam.pitch - (e.clientY - t[1]) * 0.005, -1.52, 1.52);
  }
  touches.set(e.pointerId, [e.clientX, e.clientY]);
});
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => touches.delete(e.pointerId));

function fly(dt) {
  const b = camBasis(cam.yaw, cam.pitch), k = (...c) => c.some((x) => keys.has(x));
  const fwd = (k('KeyW', 'ArrowUp') || touches.size ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
  const side = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
  const up = (k('KeyE', 'Space') ? 1 : 0) - (k('KeyQ', 'KeyC', 'ControlLeft') ? 1 : 0);
  let wish = [b.f[0] * fwd + b.r[0] * side, b.f[1] * fwd + up, b.f[2] * fwd + b.r[2] * side];
  const l = Math.hypot(...wish);
  if (l > 1) wish = wish.map((x) => x / l);
  const fast = k('ShiftLeft', 'ShiftRight') || touches.size > 1;
  const speed = (fast ? 150 : 28) * (1 + Math.max(0, cam.pos[1]) / 260);
  const a = 1 - Math.exp(-dt * 5);
  for (let i = 0; i < 3; i++) { cam.vel[i] += (wish[i] * speed - cam.vel[i]) * a; cam.pos[i] += cam.vel[i] * dt; }
  collide(cam.pos);
}

// for poking at the city from the developer console
window.__city = { cam, lookAt, world };

// ---- the loop ----
setState('m');
let labelT = 0, last = performance.now(), t0 = last, frames = 0, statT = 0, statN = 0, perfT = 0, perfN = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = (now - t0) / 1000;
  if (!entered) orbit(t); else if (playing) fly(dt);
  stepEnv(dt);
  R.render(cam, env, t);
  audio.update(dt, { alt: cam.pos[1], speed: Math.hypot(...cam.vel), rain: env.rain });

  if (++frames === 40) { const p = loadPrefs(); delete p.pending; savePrefs(p); }
  // adapt the resolution towards a steady 60 fps
  if (!document.hidden && frames > 20) {
    perfT += dt; perfN++;
    if (perfT > 1.5) {
      const avg = perfT / perfN;
      if (avg > 0.0215 && scale > Q.minScale) { tooSlowAt = scale; scale = Math.max(Q.minScale, scale * 0.88); applySize(); }
      else if (avg < 0.0175 && scale < 1 && scale * 1.06 < tooSlowAt) { scale = Math.min(1, scale * 1.06); applySize(); }
      const p = loadPrefs(); p.scale = +scale.toFixed(3); savePrefs(p);
      perfT = 0; perfN = 0;
    }
  }
  labelT += dt;
  if (labelT > 0.4 && entered) {
    labelT = 0;
    const st = world.label.street(cam.pos[0], cam.pos[2]), pl = world.label.place(cam.pos[0], cam.pos[2]);
    const txt = [st, pl].filter(Boolean).join('  ·  ');
    if (txt !== $('n').textContent) $('n').textContent = txt;
  }
  statT += dt; statN++;
  if (showStats && statT > 0.5) {
    const [w, h] = R.size;
    $('i').textContent = `${Math.round(statN / statT)} fps  ${((statT / statN) * 1000).toFixed(1)} ms\n${w}×${h} (${Math.round(scale * 100)}%)  ${Q.name}\n`
      + `${world.stats.buildings} buildings  ${world.stats.cars} cars  ${R.instances} instances\n`
      + `x ${cam.pos[0].toFixed(0)}  y ${cam.pos[1].toFixed(0)}  z ${cam.pos[2].toFixed(0)}`;
    statT = 0; statN = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
