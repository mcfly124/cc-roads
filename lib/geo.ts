// Small geodesy helpers for live navigation. Coordinates are [lng, lat].

export type LngLat = [number, number];

const R = 6371000; // earth radius, metres
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres between two [lng,lat] points. */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing in degrees (0=N, 90=E) from a to b. */
export function bearing(a: LngLat, b: LngLat): number {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLng = toRad(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Index of the route coordinate nearest to `p`. Optional search window
 *  around `from` keeps it cheap on long routes and prevents jumping back. */
export function nearestIndex(coords: LngLat[], p: LngLat, from = 0, window = 0): number {
  const start = window > 0 ? Math.max(0, from - 5) : 0;
  const end = window > 0 ? Math.min(coords.length, from + window) : coords.length;
  let best = start;
  let bestD = Infinity;
  for (let i = start; i < end; i++) {
    const d = haversine(coords[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
