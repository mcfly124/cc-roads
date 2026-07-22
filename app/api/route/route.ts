import { NextRequest, NextResponse } from "next/server";
import { customModelForCc, ruleForCc } from "@/lib/cc-rules";

/**
 * Server-side routing proxy.
 *
 * - Keeps the GraphHopper key secret (never shipped to the browser).
 * - Applies the cc -> forbidden-road-class logic before calling GraphHopper.
 * - Returns a GeoJSON LineString plus distance/time for the client to draw.
 *
 * Request body: { from: [lng, lat], to: [lng, lat], cc: number }
 */
export async function POST(req: NextRequest) {
  const key = process.env.GRAPHHOPPER_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "GRAPHHOPPER_API_KEY is not set on the server." }, { status: 500 });
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

  const ghBody = {
    // GraphHopper expects [lng, lat] pairs.
    points: [from, to],
    profile: "scooter", // low-power base profile; custom model tightens it further
    points_encoded: false,
    "ch.disable": true, // required for custom models
    custom_model: customModelForCc(cc),
    locale: "it",
    instructions: true,
    details: ["road_class"],
  };

  let gh: Response;
  try {
    gh = await fetch(`https://graphhopper.com/api/1/route?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ghBody),
    });
  } catch (e) {
    return NextResponse.json({ error: "Failed to reach the routing service." }, { status: 502 });
  }

  const data = await gh.json();
  if (!gh.ok) {
    return NextResponse.json(
      { error: data?.message || "Routing failed.", category: rule.category },
      { status: gh.status }
    );
  }

  const path = data?.paths?.[0];
  if (!path) {
    return NextResponse.json({ error: "No route found for this vehicle.", category: rule.category }, { status: 404 });
  }

  return NextResponse.json({
    category: rule.category,
    forbidden: rule.forbidden,
    distanceMeters: path.distance,
    timeMs: path.time,
    geometry: path.points, // GeoJSON LineString ([lng,lat] coords)
    instructions: path.instructions ?? [],
  });
}

function isLngLat(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number";
}
