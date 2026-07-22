import { NextRequest, NextResponse } from "next/server";

/**
 * Geocoding proxy (address -> coordinates) using GraphHopper's geocoder,
 * so we keep a single provider and hide the API key from the client.
 *
 * GET /api/geocode?q=Piazza+del+Duomo+Milano
 */
export async function GET(req: NextRequest) {
  const key = process.env.GRAPHHOPPER_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "GRAPHHOPPER_API_KEY is not set on the server." }, { status: 500 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing ?q=." }, { status: 400 });
  }

  const url = new URL("https://graphhopper.com/api/1/geocode");
  url.searchParams.set("q", q);
  url.searchParams.set("locale", "it");
  url.searchParams.set("limit", "5");
  url.searchParams.set("key", key);

  const gh = await fetch(url);
  const data = await gh.json();
  if (!gh.ok) {
    return NextResponse.json({ error: data?.message || "Geocoding failed." }, { status: gh.status });
  }

  const results = (data?.hits ?? []).map((h: any) => ({
    name: [h.name, h.city, h.state, h.country].filter(Boolean).join(", "),
    lng: h.point?.lng,
    lat: h.point?.lat,
  }));

  return NextResponse.json({ results });
}
