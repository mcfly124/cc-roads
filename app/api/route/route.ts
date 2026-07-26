import { NextRequest, NextResponse } from "next/server";
import { avoidFeaturesForCc, labelRoadClasses, ruleForCc, topSpeedForCc, unenforcedForCc } from "@/lib/cc-rules";

/**
 * Server-side routing proxy (OpenRouteService).
 *
 * - Keeps the ORS key secret (never shipped to the browser).
 * - Applies the cc -> avoid-motorway logic before calling ORS.
 * - Caps ETAs to the vehicle's realistic top speed (ORS returns car speeds).
 * - Returns a GeoJSON LineString plus GraphHopper-shaped instructions so the
 *   client's turn-by-turn code keeps working unchanged.
 *
 * Request body: { from: [lng, lat], to: [lng, lat], cc: number }
 */
export async function POST(req: NextRequest) {
  const key = process.env.ORS_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "ORS_API_KEY is not set on the server." }, { status: 500 });
  }

  let body: { from?: [number, number]; to?: [number, number]; cc?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { from, to, cc } = body;
  if (!isLngLat(from) || !isLngLat(to) || typeof cc !== "number") {
    return NextResponse.json({ error: "Expected { from:[lng,lat], to:[lng,lat], cc:number }." }, { status: 400 });
  }

  const rule = ruleForCc(cc);
  const avoid = avoidFeaturesForCc(cc);

  const orsBody: Record<string, unknown> = {
    coordinates: [from, to],
    instructions: true,
    language: "it",
  };
  if (avoid.length) {
    orsBody.options = { avoid_features: avoid };
  }

  let ors: Response;
  try {
    ors = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
        Accept: "application/geo+json",
      },
      body: JSON.stringify(orsBody),
    });
  } catch {
    return NextResponse.json({ error: "Failed to reach the routing service." }, { status: 502 });
  }

  const data = await ors.json();
  if (!ors.ok) {
    const msg = data?.error?.message || data?.error || "Routing failed.";
    return NextResponse.json({ error: msg, category: rule.category }, { status: ors.status });
  }

  const feature = data?.features?.[0];
  const geometry = feature?.geometry;
  if (!geometry || geometry.type !== "LineString") {
    return NextResponse.json({ error: "No route found for this vehicle.", category: rule.category }, { status: 404 });
  }

  // ORS returns durations at car speed. Slow each step down so its average
  // speed never exceeds the vehicle's realistic top speed. Urban segments
  // already slower than the cap are left untouched.
  const topKmh = topSpeedForCc(cc);
  const capMs = topKmh != null ? topKmh / 3.6 : Infinity; // m/s

  const steps: any[] = feature?.properties?.segments?.flatMap((s: any) => s.steps ?? []) ?? [];

  let totalTimeMs = 0;
  const instructions = steps.map((st) => {
    const dist: number = st.distance ?? 0;
    const dur: number = st.duration ?? 0; // seconds, car speed
    const carSpeed = dur > 0 ? dist / dur : capMs;
    const cappedSpeed = Math.min(carSpeed, capMs);
    const timeMs = cappedSpeed > 0 ? (dist / cappedSpeed) * 1000 : 0;
    totalTimeMs += timeMs;
    const wp: [number, number] = st.way_points ?? [0, 0];
    return {
      text: st.instruction ?? "",
      distance: dist,
      time: timeMs,
      sign: orsTypeToSign(st.type),
      interval: wp,
      street_name: st.name && st.name !== "-" ? st.name : undefined,
    };
  });

  const summary = feature?.properties?.summary ?? {};
  const distanceMeters: number = summary.distance ?? instructions.reduce((a, i) => a + i.distance, 0);

  // Road classes we claim to exclude but cannot: the client warns about these
  // so the UI never silently promises more filtering than it delivers.
  const unenforced = unenforcedForCc(cc);

  return NextResponse.json({
    category: rule.category,
    forbidden: rule.forbidden,
    unenforced,
    unenforcedLabel: unenforced.length ? labelRoadClasses(unenforced) : "",
    distanceMeters,
    timeMs: totalTimeMs,
    geometry, // GeoJSON LineString ([lng,lat] coords)
    instructions,
  });
}

function isLngLat(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";
}

/**
 * Map an OpenRouteService maneuver `type` to the GraphHopper `sign` the client's
 * signArrow() understands, so the turn banner arrows keep working.
 * ORS types: https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/instruction-types
 */
function orsTypeToSign(type: number): number {
  switch (type) {
    case 0: // left
      return -2;
    case 1: // right
      return 2;
    case 2: // sharp left
      return -3;
    case 3: // sharp right
      return 3;
    case 4: // slight left
      return -1;
    case 5: // slight right
      return 1;
    case 6: // straight
      return 0;
    case 7: // enter roundabout
    case 8: // exit roundabout
      return 6;
    case 9: // u-turn
      return -8;
    case 10: // goal
      return 4;
    case 11: // depart
      return 0;
    case 12: // keep left
      return -7;
    case 13: // keep right
      return 7;
    default:
      return 0;
  }
}
