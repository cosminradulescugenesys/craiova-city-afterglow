# Craiova Afterglow

**The real Craiova at dusk, flown in your browser.** About 27,000 buildings, 5,700 streets, the park lakes, the railway and
the tram lines of the actual city, built from OpenStreetMap data and drawn with raw WebGPU in **one ~700 KB HTML file**:
no images, no 3D models, no sound files.

> A rebuild of [Afterglow City](https://github.com/J-o-h-n-M/afterglow-city) by John (MIT), which in turn is based on
> [Abyssal Garden](https://github.com/Noniv/abyssal-garden) by Maksymilian Dendura. The renderer, shaders, soundscape and menu come
> from Afterglow City; the invented street grid and skyline are replaced by Craiova. See [Credits](#credits).

## Try it

Open [`index.html`](index.html) in **Chrome** or **Edge** on a desktop computer (it needs WebGPU). If the page stays blank, serve
the folder (`python3 -m http.server`) and open `http://localhost:8000`.

## What is Craiova in here

- **8 × 8 km of the real city**, centred just south-east of Piața Mihai Viteazul. Every building is a box on its real footprint,
  rotated to match, with its real height where OpenStreetMap has one and an estimate otherwise: tiled gable roofs on houses,
  flat blocks of flats (*blocuri*) of 4–10 floors, shop-front streets in the centre, industrial halls with floodlit yards
- **Real streets** with their widths, lanes, one-way carriageways, junctions, zebra crossings and street lamps; traffic drives each lane
- **Parcul Nicolae Romanescu** with its lakes and footpaths, plus the other parks, woods and ponds
- **Stadionul Ion Oblemenco** and **Stadionul Extensiv** as floodlit bowls, the old centre, the cathedral's dome, **Gara Craiova**,
  **Electroputere** and the **Ford** plant
- **The railway** with trains, and **trams** on the tram lines
- A **label** of the street and neighbourhood under you, and viewpoints on `1`–`6`: Piața Mihai Viteazul, the old centre from above,
  Parcul Romanescu, Stadionul Ion Oblemenco, Gara Craiova, Electroputere and Ford
- Dusk, night and dawn, rain that soaks the streets, and a soundscape made up as you listen

The Jiu does not flow through Craiova (it passes several kilometres to the west, outside the map), so unlike in the original city
there is no river: the water is the park lakes and ponds.

## Controls

| | Keyboard & mouse |
|---|---|
| Look around | Move the mouse |
| Fly | `W` `A` `S` `D` |
| Down / up | `Q` / `E` |
| Faster | Hold `Shift` |
| Jump to a viewpoint | `1` to `6` |
| Time of day | `T` (dusk → night → dawn) |
| Rain on / off | `R` |
| Menu | `Esc` |
| Sound on / off | `M` |
| Performance stats | `H` |
| Detail level | **Low**, **Medium** or **High** in the menu (reloads the page) |

Buildings are solid: you glide along their walls. On a touchscreen, hold one finger down to fly forward and slide to steer.

## Rebuilding

You only need [Node.js](https://nodejs.org) 18 or newer, with no packages to install.

```bash
cd source
node build.mjs          # writes ../index.html from src/ (including the ready-made src/data.js)
node build.mjs --min    # smaller: squeezes the shaders (and minifies the JS if esbuild is installed)
```

To download the map again and regenerate [`source/src/data.js`](source/src/data.js):

```bash
cd source
node tools/fetch-osm.mjs     # Overpass API, cached in tools/.cache (takes a few minutes)
node tools/build-data.mjs    # buildings -> boxes, roads, rails, parks, lakes, places -> compressed data.js
```

| File | What's inside |
|---|---|
| [`source/tools/map.mjs`](source/tools/map.mjs) | The window of the world (centre and size) and the projection. Change it to move the map |
| [`source/tools/build-data.mjs`](source/tools/build-data.mjs) | OpenStreetMap to compact data: fits each building footprint with rectangles, estimates heights, classifies roads and land |
| [`source/src/world.js`](source/src/world.js) | Builds the city from the data: buildings, streets, junctions, lamps, trees, stadiums, rails, traffic, baked ground light |
| [`source/src/shaders.js`](source/src/shaders.js) | The look (WGSL): sky, fog, windows and rooms, wet asphalt, lakes, neon, light sprites, rain, bloom |
| [`source/src/main.js`](source/src/main.js) | Camera and controls, time-of-day presets, menu, viewpoints, street label |
| [`source/src/renderer.js`](source/src/renderer.js) | The WebGPU renderer |
| [`source/src/audio.js`](source/src/audio.js), [`quality.js`](source/src/quality.js), [`math.js`](source/src/math.js) | Soundscape, detail levels, noise / matrices / meshes |

## Credits and data

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
  [Open Database Licence](https://opendatacommons.org/licenses/odbl/). `source/src/data.js` is a derived extract of it.
- [Afterglow City](https://github.com/J-o-h-n-M/afterglow-city) by John (MIT): renderer, shaders, audio, menu and build script,
  adapted here for arbitrary street directions, real footprints and a lake-based ground.
- [Abyssal Garden](https://github.com/Noniv/abyssal-garden) by Maksymilian Dendura (MIT), the origin of the single-file WebGPU approach.

## License

Code: [MIT](LICENSE), carrying the notices of Afterglow City and Abyssal Garden. Map data: ODbL, see above.
