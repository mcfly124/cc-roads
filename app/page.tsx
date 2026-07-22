"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { bearing, haversine, nearestIndex, LngLat } from "@/lib/geo";
import { signArrow } from "@/lib/maneuvers";

type Pt = { lng: number; lat: number };
type Suggestion = { name: string; lng: number; lat: number };
type Instruction = {
  text: string;
  distance: number;
  time: number;
  sign: number;
  interval: [number, number];
  street_name?: string;
};
type RouteData = {
  category: string;
  distanceMeters: number;
  timeMs: number;
  geometry: GeoJSON.LineString;
  instructions: Instruction[];
};

const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  : "https://demotiles.maplibre.org/style.json";

const OFF_ROUTE_METRES = 45; // beyond this from the line, we re-route

export default function Home() {
  const mapRef = useRef<maplibregl.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const watchId = useRef<number | null>(null);
  const coordsRef = useRef<LngLat[]>([]);
  const instrRef = useRef<Instruction[]>([]);
  const lastIdx = useRef(0);
  const offRouteCount = useRef(0);
  const toRef = useRef<Pt | null>(null);
  const ccRef = useRef(50);

  const [from, setFrom] = useState<Pt | null>(null);
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [to, setTo] = useState<Pt | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeField, setActiveField] = useState<"from" | "to" | null>(null);
  const [cc, setCc] = useState(50);
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(false);

  const [route, setRoute] = useState<RouteData | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [banner, setBanner] = useState<{ arrow: string; text: string; dist: number } | null>(null);
  const [remaining, setRemaining] = useState<{ km: number; min: number } | null>(null);

  useEffect(() => {
    toRef.current = to;
  }, [to]);
  useEffect(() => {
    ccRef.current = cc;
  }, [cc]);

  // Editing inputs invalidates a computed route -> button reverts to "Calcola".
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!navigating) setRoute(null);
  }, [fromText, toText, cc, navigating]);

  // Init map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [12.4964, 41.9028],
      zoom: 5,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    mapRef.current = map;

    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const p = { lng: pos.coords.longitude, lat: pos.coords.latitude };
        setFrom(p);
        setFromText("Posizione attuale");
        map.jumpTo({ center: [p.lng, p.lat], zoom: 14 });
        meMarker.current = new maplibregl.Marker({ color: "#4dd4e8" })
          .setLngLat([p.lng, p.lat])
          .addTo(map);
      },
      () => setStatus("Attiva la geolocalizzazione per usare la posizione attuale."),
      { enableHighAccuracy: true }
    );

    return () => map.remove();
  }, []);

  async function geocode(q: string, field: "from" | "to") {
    setActiveField(field);
    if (q.trim().length < 3) return setSuggestions([]);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setSuggestions(data.results ?? []);
    } catch {
      setSuggestions([]);
    }
  }

  function pickSuggestion(s: Suggestion) {
    if (activeField === "from") {
      setFrom({ lng: s.lng, lat: s.lat });
      setFromText(s.name);
    } else if (activeField === "to") {
      setTo({ lng: s.lng, lat: s.lat });
      setToText(s.name);
    }
    setSuggestions([]);
  }

  const fetchRoute = useCallback(async (start: Pt, dest: Pt, ccVal: number): Promise<RouteData | null> => {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: [start.lng, start.lat], to: [dest.lng, dest.lat], cc: ccVal }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "Errore nel calcolo.");
      return null;
    }
    return data as RouteData;
  }, []);

  function drawRoute(geometry: GeoJSON.LineString, fit: boolean) {
    const map = mapRef.current;
    if (!map) return;
    const geojson: GeoJSON.Feature = { type: "Feature", geometry, properties: {} };
    const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(geojson as any);
    } else {
      map.addSource("route", { type: "geojson", data: geojson as any });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#0b7285", "line-width": 6 },
      });
    }
    if (fit) {
      const coords = geometry.coordinates as [number, number][];
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: { top: 60, bottom: 300, left: 40, right: 40 } });
    }
  }

  function applyRoute(data: RouteData, fit: boolean) {
    setRoute(data);
    coordsRef.current = data.geometry.coordinates as LngLat[];
    instrRef.current = data.instructions ?? [];
    lastIdx.current = 0;
    setCategory(data.category);
    drawRoute(data.geometry, fit);
  }

  async function calculate() {
    if (!from || !to) return setStatus("Imposta partenza e destinazione.");
    setLoading(true);
    setStatus("Calcolo percorso…");
    const data = await fetchRoute(from, to, cc);
    setLoading(false);
    if (!data) return;
    applyRoute(data, true);
    const km = (data.distanceMeters / 1000).toFixed(1);
    const min = Math.round(data.timeMs / 60000);
    setStatus(`${km} km · ~${min} min`);
  }

  // --- Live navigation -----------------------------------------------------

  function updateNav(user: LngLat, heading: number | null) {
    const coords = coordsRef.current;
    const instr = instrRef.current;
    const map = mapRef.current;
    if (!coords.length || !map) return;

    const idx = nearestIndex(coords, user, lastIdx.current, 400);
    lastIdx.current = idx;

    // Off-route detection -> silent re-route.
    const distToLine = haversine(coords[idx], user);
    if (distToLine > OFF_ROUTE_METRES) {
      offRouteCount.current++;
      if (offRouteCount.current >= 2 && toRef.current) {
        offRouteCount.current = 0;
        setStatus("Ricalcolo…");
        fetchRoute({ lng: user[0], lat: user[1] }, toRef.current, ccRef.current).then((r) => {
          if (r) {
            applyRoute(r, false);
            setStatus("");
          }
        });
      }
    } else {
      offRouteCount.current = 0;
    }

    // Which instruction segment are we in, and what's the next maneuver?
    let seg = 0;
    for (let i = 0; i < instr.length; i++) {
      if (instr[i].interval[0] <= idx) seg = i;
      else break;
    }
    const next = instr[seg + 1] ?? instr[instr.length - 1];
    const maneuverPt = coords[next.interval[0]] ?? coords[coords.length - 1];
    const distToTurn = haversine(user, maneuverPt);

    const arriving = seg >= instr.length - 1;
    setBanner({
      arrow: arriving ? "◉" : signArrow(next.sign),
      text: arriving ? "Arrivo a destinazione" : next.text,
      dist: Math.round(distToTurn),
    });

    // Remaining distance/time from current point onward.
    let remM = distToTurn;
    let remT = 0;
    for (let i = seg + 1; i < instr.length; i++) {
      remM += instr[i].distance;
      remT += instr[i].time;
    }
    setRemaining({ km: remM / 1000, min: Math.round(remT / 60000) });

    // Camera follows: prefer GPS heading, else bearing along the route.
    const bng =
      heading != null && !Number.isNaN(heading)
        ? heading
        : idx + 1 < coords.length
        ? bearing(coords[idx], coords[idx + 1])
        : 0;

    meMarker.current?.setLngLat(user);
    map.easeTo({ center: user, zoom: 17, pitch: 60, bearing: bng, duration: 800 });
  }

  function startNav() {
    if (!route || !navigator.geolocation) return;
    setNavigating(true);
    setSuggestions([]);
    offRouteCount.current = 0;
    lastIdx.current = 0;
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => updateNav([pos.coords.longitude, pos.coords.latitude], pos.coords.heading),
      () => setStatus("Segnale GPS assente."),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }

  function stopNav() {
    setNavigating(false);
    setBanner(null);
    setRemaining(null);
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    mapRef.current?.easeTo({ pitch: 0, bearing: 0, zoom: 14, duration: 600 });
  }

  useEffect(() => {
    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, []);

  // --- UI ------------------------------------------------------------------

  return (
    <>
      <div id="map" ref={containerRef} />

      {navigating && banner && (
        <div className="nav-banner">
          <span className="nav-arrow">{banner.arrow}</span>
          <div className="nav-text">
            <div className="nav-dist">{banner.dist} m</div>
            <div className="nav-street">{banner.text}</div>
          </div>
        </div>
      )}

      {navigating ? (
        <div className="nav-footer">
          <div>
            {remaining && (
              <span>
                {remaining.km.toFixed(1)} km · ~{remaining.min} min
              </span>
            )}
          </div>
          <button className="end" onClick={stopNav}>
            Termina
          </button>
        </div>
      ) : (
        <div className="panel">
          {suggestions.length > 0 && (
            <ul className="suggestions">
              {suggestions.map((s, i) => (
                <li key={i} onClick={() => pickSuggestion(s)}>
                  {s.name}
                </li>
              ))}
            </ul>
          )}

          <div className="row">
            <input
              type="text"
              placeholder="Partenza"
              value={fromText}
              onChange={(e) => {
                setFromText(e.target.value);
                geocode(e.target.value, "from");
              }}
            />
          </div>

          <div className="row">
            <input
              type="text"
              placeholder="Destinazione"
              value={toText}
              onChange={(e) => {
                setToText(e.target.value);
                geocode(e.target.value, "to");
              }}
            />
          </div>

          <div className="row">
            <input
              className="cc-field"
              type="text"
              inputMode="numeric"
              aria-label="Cilindrata in cc"
              value={cc}
              onChange={(e) => setCc(parseInt(e.target.value || "0", 10))}
            />
            <span style={{ color: "#b3b3b8", fontSize: 13 }}>cc</span>
            {route ? (
              <button onClick={startNav} style={{ marginLeft: "auto" }}>
                Avvia
              </button>
            ) : (
              <button onClick={calculate} disabled={loading} style={{ marginLeft: "auto" }}>
                {loading ? "…" : "Calcola"}
              </button>
            )}
          </div>

          <div className="status">
            {category && <span className="cat">{category}</span>} {status}
          </div>

          <p className="disclaimer">
            Percorso indicativo basato su dati OpenStreetMap. Verifica sempre la segnaletica stradale.
          </p>
        </div>
      )}
    </>
  );
}
