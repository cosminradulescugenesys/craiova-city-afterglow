// Downloads the raw OpenStreetMap data for the map window around Craiova from the Overpass API
// and caches it in tools/.cache/*.json. Run it once, then run `node build-data.mjs`.
//   node fetch-osm.mjs          (skips what is already cached)
//   node fetch-osm.mjs --force  (downloads everything again)
// Data (c) OpenStreetMap contributors, ODbL: https://www.openstreetmap.org/copyright
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAP } from './map.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(here, '.cache');
mkdirSync(cache, { recursive: true });
const force = process.argv.includes('--force');
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'craiova-city/0.1 (open source hobby project)';

// the window, with a little margin, cut into a grid so that no single answer is huge
const m = 0.002;
const S = MAP.south - m, N = MAP.north + m, W = MAP.west - m, E = MAP.east + m;
const tiles = [];
const NT = 3;
for (let i = 0; i < NT; i++)
  for (let j = 0; j < NT; j++)
    tiles.push([S + ((N - S) * i) / NT, W + ((E - W) * j) / NT, S + ((N - S) * (i + 1)) / NT, W + ((E - W) * (j + 1)) / NT]);
const bb = (t) => t.map((v) => v.toFixed(5)).join(',');
const whole = [S, W, N, E];

const jobs = [];
tiles.forEach((t, k) => jobs.push([`buildings-${k}`, `(way["building"](${bb(t)});relation["building"](${bb(t)}););out geom;`]));
tiles.forEach((t, k) => jobs.push([`roads-${k}`, `way["highway"](${bb(t)});out geom;`]));
jobs.push(['areas', `(way["landuse"](${bb(whole)});way["leisure"](${bb(whole)});way["natural"](${bb(whole)});way["amenity"~"^(parking|school|university|hospital|grave_yard)$"](${bb(whole)});way["man_made"~"^(chimney|tower|water_tower|storage_tank|silo)$"](${bb(whole)});relation["leisure"~"^(park|garden|stadium)$"](${bb(whole)});relation["landuse"](${bb(whole)});relation["natural"="water"](${bb(whole)}););out geom;`]);
jobs.push(['rail', `way["railway"~"^(rail|tram|light_rail|siding|yard|spur|platform)$"](${bb(whole)});out geom;`]);
jobs.push(['nodes', `(node["place"~"^(suburb|neighbourhood|quarter|village|square)$"](${bb(whole)});node["shop"](${bb(whole)});node["amenity"~"^(restaurant|cafe|bar|pub|fast_food|bank|pharmacy|cinema|theatre|nightclub|marketplace|place_of_worship|fountain)$"](${bb(whole)});node["tourism"](${bb(whole)});node["historic"](${bb(whole)});node["man_made"~"^(chimney|tower|water_tower)$"](${bb(whole)});node["railway"~"^(station|halt|tram_stop|level_crossing)$"](${bb(whole)});node["highway"="traffic_signals"](${bb(whole)}););out;`]);
jobs.push(['landmarks', `(way["name"]["building"~"^(church|cathedral|chapel|civic|public|government|stadium|hospital|university|school|train_station|hotel|retail|commercial|industrial)$"](${bb(whole)});way["name"]["amenity"~"^(theatre|townhall|university|place_of_worship|courthouse|library|hospital)$"](${bb(whole)});way["name"]["tourism"~"^(museum|attraction|hotel)$"](${bb(whole)});way["name"]["leisure"~"^(stadium|sports_centre|park)$"](${bb(whole)}););out geom tags;`]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, q] of jobs) {
  const file = path.join(cache, name + '.json');
  if (existsSync(file) && !force) { console.log('cached', name); continue; }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(`[out:json][timeout:180];${q}`),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      JSON.parse(text);
      writeFileSync(file, text);
      console.log('fetched', name, (text.length / 1048576).toFixed(1) + ' MB');
      break;
    } catch (e) {
      console.log(`${name}: ${e.message} (attempt ${attempt})`);
      if (attempt >= 5) throw e;
      await sleep(8000 * attempt);
    }
  }
  await sleep(3000);
}
console.log('done');
