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
  /** Road classes forbidden by law that the backend could not actually exclude. */
  unenforcedLabel?: string;
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

/**
 * Recentre-on-me control. Rendered as a child of the panel / nav footer and
 * pinned just above it, so it never overlaps whatever their current height is.
 */
function LocateButton({
  onClick,
  locating,
  hasFix,
}: {
  onClick: () => void;
  locating: boolean;
  hasFix: boolean;
}) {
  return (
    <button
      className={`locate-btn${hasFix ? " has-fix" : ""}`}
      onClick={onClick}
      disabled={locating}
      aria-label="Centra sulla mia posizione"
    >
      {locating ? "◌" : "◎"}
    </button>
  );
}

/** Turn a GeolocationPositionError into something actionable, in Italian. */
function geoErrorText(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Permesso posizione negato: consentilo nelle impostazioni del sito.";
    case err.POSITION_UNAVAILABLE:
      return "Posizione non disponibile: segnale GPS assente.";
    case err.TIMEOUT:
      return "GPS lento: attendo un segnale…";
    default:
      return "Impossibile ottenere la posizione.";
  }
}

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

  const [locating, setLocating] = useState(false);
  const [hasFix, setHasFix] = useState(false);
  // iOS remembers a denial and never re-prompts, so "allow it in the site
  // settings" is a dead end without the actual steps. Show them inline.
  const [denied, setDenied] = useState(false);

  const [route, setRoute] = useState<RouteData | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [banner, setBanner] = useState<{ arrow: string; text: string; dist: number } | null>(null);
  const [remaining, setRemaining] = useState<{ km: number; min: number } | null>(null);
  // Shown *inside* the navigation UI: while navigating the panel (and its
  // `status` line) is unmounted, so GPS problems would otherwise be invisible.
  const [navError, setNavError] = useState("");

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
        setFromText("La mia posizione");
        map.jumpTo({ center: [p.lng, p.lat], zoom: 14 });
        showMe([p.lng, p.lat]);
      },
      (err) => setStatus(geoErrorText(err)),
      { enableHighAccuracy: true }
    );

    return () => map.remove();
  }, []);

  /**
   * Move the "you are here" marker, creating it on demand.
   *
   * It must be lazy: it used to be created only in the initial
   * getCurrentPosition callback, so if that prompt was denied, still pending,
   * or the user typed both addresses by hand, the marker stayed null and
   * navigation silently showed no position at all.
   */
  function showMe(p: LngLat) {
    const map = mapRef.current;
    if (!map) return;
    if (meMarker.current) {
      meMarker.current.setLngLat(p);
    } else {
      const el = document.createElement("div");
      el.className = "me-dot";
      meMarker.current = new maplibregl.Marker({ element: el }).setLngLat(p).addTo(map);
    }
    setHasFix(true);
  }

  /**
   * Take a fresh fix: drop the dot, and optionally recentre the map or adopt it
   * as the start point. Prefer calling this from a tap — iOS Safari shows the
   * permission prompt far more reliably on a user gesture than on page load,
   * which is why asking only in the init effect could stay silent forever.
   */
  const locateMe = useCallback(async (opts: { center?: boolean; asFrom?: boolean } = {}) => {
    if (!navigator.geolocation) {
      setStatus("Geolocalizzazione non supportata da questo browser.");
      return null;
    }
    if (!window.isSecureContext) {
      setStatus("La posizione richiede HTTPS.");
      return null;
    }
    setLocating(true);
    setStatus("Ricerca posizione…");
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 10000,
        })
      );
      const p = { lng: pos.coords.longitude, lat: pos.coords.latitude };
      setDenied(false);
      showMe([p.lng, p.lat]);
      if (opts.center) mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: 15, duration: 600 });
      if (opts.asFrom) {
        setFrom(p);
        setFromText("La mia posizione");
        setSuggestions([]);
        setActiveField(null);
      }
      setStatus("");
      return p;
    } catch (err) {
      const e = err as GeolocationPositionError;
      setDenied(e.code === 1); // PERMISSION_DENIED
      setStatus(geoErrorText(e));
      return null;
    } finally {
      setLocating(false);
    }
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
    setActiveField(null);
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

    // Always show where we are, even if the instruction list is unusable —
    // a throw further down would otherwise kill every later GPS update.
    showMe(user);
    if (!instr.length) {
      setNavError("Percorso senza indicazioni: ricalcola.");
      return;
    }
    setNavError("");

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

    map.easeTo({ center: user, zoom: 17, pitch: 60, bearing: bng, duration: 800 });
  }

  function startNav() {
    if (!route) return;
    if (!navigator.geolocation) return setStatus("Geolocalizzazione non supportata da questo browser.");
    // Geolocation is blocked on non-HTTPS origins, so testing from a phone on
    // http://<lan-ip>:3000 yields a silent permission error.
    if (!window.isSecureContext) {
      return setStatus("La posizione richiede HTTPS: apri il sito con https:// (o su localhost).");
    }

    setNavigating(true);
    setSuggestions([]);
    setNavError("");
    offRouteCount.current = 0;
    lastIdx.current = 0;

    const onPos = (pos: GeolocationPosition) =>
      updateNav([pos.coords.longitude, pos.coords.latitude], pos.coords.heading);
    const onErr = (err: GeolocationPositionError) => {
      setDenied(err.code === 1); // PERMISSION_DENIED
      setNavError(geoErrorText(err));
    };

    // watchPosition can take many seconds for its first fix; ask for one
    // immediately so the marker and banner appear as soon as "Avvia" is tapped.
    navigator.geolocation.getCurrentPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 30000 });
    watchId.current = navigator.geolocation.watchPosition(onPos, onErr, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });
  }

  function stopNav() {
    setNavigating(false);
    setBanner(null);
    setRemaining(null);
    setNavError("");
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

      {navigating && !banner && !navError && (
        <div className="nav-banner warn">
          <span className="nav-arrow">◌</span>
          <div className="nav-text">
            <div className="nav-street">Ricerca posizione GPS…</div>
          </div>
        </div>
      )}

      {navigating && navError && (
        <div className="nav-banner warn">
          <span className="nav-arrow">!</span>
          <div className="nav-text">
            <div className="nav-street">{navError}</div>
          </div>
        </div>
      )}

      {navigating ? (
        <div className="nav-footer">
          <LocateButton onClick={() => locateMe({ center: true })} locating={locating} hasFix={hasFix} />
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
          <LocateButton onClick={() => locateMe({ center: true })} locating={locating} hasFix={hasFix} />
          {(suggestions.length > 0 || activeField === "from") && (
            <ul className="suggestions">
              {/* Using the current location is the most common start, so it is
                  pinned above the geocoder results rather than buried in them. */}
              {activeField === "from" && (
                <li className="use-me" onClick={() => locateMe({ asFrom: true, center: true })}>
                  <span className="use-me-icon">◎</span>
                  {locating ? "Ricerca posizione…" : "La mia posizione"}
                </li>
              )}
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
              onFocus={() => setActiveField("from")}
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
              onFocus={() => setActiveField("to")}
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

          {denied && (
            <div className="help">
              <strong>Posizione bloccata</strong>
              <p>iOS ricorda il rifiuto e non richiede più il permesso. Per sbloccarlo:</p>
              <ol>
                <li>
                  Impostazioni → Privacy e sicurezza → Localizzazione → <em>Safari (siti web)</em> →
                  “Mentre utilizzo l’app”, e attiva “Posizione esatta”.
                </li>
                <li>
                  Qui in Safari, tocca l’icona a sinistra dell’indirizzo →{" "}
                  <em>Impostazioni sito web</em> → Posizione → “Consenti”.
                </li>
                <li>
                  Se la voce Posizione non c’è: Impostazioni → Safari → Avanzate → Dati dei siti web
                  → elimina <em>vercel.app</em>, poi ricarica.
                </li>
              </ol>
              <p className="help-note">
                Su Android: tocca il lucchetto accanto all’indirizzo → Autorizzazioni → Posizione.
                In navigazione privata i permessi non vengono salvati.
              </p>
              <button className="help-retry" onClick={() => locateMe({ center: true })}>
                Riprova
              </button>
            </div>
          )}

          {route?.unenforcedLabel && (
            <p className="warning">
              ⚠ Questo percorso <strong>non esclude le {route.unenforcedLabel}</strong>, che il tuo
              veicolo non può percorrere. Controlla i cartelli di divieto prima di imboccare una
              strada a scorrimento veloce.
            </p>
          )}

          <p className="disclaimer">
            Percorso indicativo basato su dati OpenStreetMap. Verifica sempre la segnaletica stradale.
          </p>
        </div>
      )}
    </>
  );
}
