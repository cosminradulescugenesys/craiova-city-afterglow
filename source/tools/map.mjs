// The window of the real world that the city covers, and how latitude / longitude map onto it.
// x runs east, z runs south (so the camera, which starts out looking along -z, looks north).
export const MAP = {
  lat0: 44.3125, lon0: 23.804,   // the middle of the map (a little south-east of Piata Mihai Viteazul)
  half: 4000,                    // half the side of the square window, in metres
};
const KLAT = 110574, KLON = 111320 * Math.cos((MAP.lat0 * Math.PI) / 180);
export const project = (lat, lon) => [(lon - MAP.lon0) * KLON, -(lat - MAP.lat0) * KLAT];
MAP.south = MAP.lat0 - MAP.half / KLAT; MAP.north = MAP.lat0 + MAP.half / KLAT;
MAP.west = MAP.lon0 - MAP.half / KLON; MAP.east = MAP.lon0 + MAP.half / KLON;
