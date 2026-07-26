/**
 * Maps a vehicle's engine displacement (cc) to the OpenStreetMap road classes
 * it is legally forbidden to use, per the Italian Codice della Strada.
 *
 *   cc <= 50   ciclomotore (e.g. Ape 50):  no autostrada, no superstrada
 *   50 < cc < 150  motoveicolo:            no autostrada
 *   cc >= 150      motoveicolo:            no restriction
 *
 * OSM/GraphHopper road_class mapping:
 *   autostrada (motorway)                 -> MOTORWAY
 *   superstrada / extraurbana principale  -> TRUNK
 *
 * This is the single source of truth for the app's filtering behaviour.
 * Adjust here if you extend to other vehicle categories or countries.
 */
export type RoadClass = "MOTORWAY" | "TRUNK";

export interface CcRule {
  /** Human-readable Italian vehicle class. */
  category: string;
  /** OSM road_class values to hard-exclude from routing. */
  forbidden: RoadClass[];
}

export function ruleForCc(cc: number): CcRule {
  if (!Number.isFinite(cc) || cc <= 0) {
    // Unknown / invalid input: be conservative, treat as a moped.
    return { category: "sconosciuto (trattato come ciclomotore)", forbidden: ["MOTORWAY", "TRUNK"] };
  }
  if (cc <= 50) {
    return { category: "ciclomotore (≤50cc)", forbidden: ["MOTORWAY", "TRUNK"] };
  }
  if (cc < 150) {
    return { category: "motoveicolo (50–150cc)", forbidden: ["MOTORWAY"] };
  }
  return { category: "motoveicolo (≥150cc)", forbidden: [] };
}

/** Approx top speed (km/h) by vehicle class, used to make ETAs realistic. */
export function topSpeedForCc(cc: number): number | null {
  if (cc <= 0) return 45;
  if (cc <= 50) return 45; // Ape 50 / ciclomotore
  if (cc < 150) return 90;
  return null; // treat as a normal vehicle, no extra cap
}

/**
 * OpenRouteService `avoid_features` for the given cc.
 *
 * "tollways" is NOT optional here. Measured on the live API, "highways" alone
 * fails to keep routes off Italian autostrade — and on some pairs it makes
 * things worse rather than better:
 *
 *   Bergamo -> Trento   no avoid 79% motorway | highways 90% | +tollways 0%
 *   Milano  -> Brescia  no avoid 88% motorway | highways 65% | +tollways 0%
 *
 * Sampling those routes against OSM confirmed real A4/A22 carriageway, so the
 * app was routing mopeds onto the motorway. Adding "tollways" fixes it because
 * Italian autostrade are tolled. Re-verify with scripts/ if this is ever
 * changed: ORS returns no warning when it silently ignores the avoidance.
 *
 * Side effect: tolled non-motorway roads (a few alpine tunnels and passes) are
 * also avoided. Acceptable — they are rare, and mostly barred to mopeds anyway.
 *
 * NOTE / known limitation: ORS still cannot separately avoid *superstrade*
 * (trunk roads), which a ciclomotore (≤50cc) may not use either. See
 * unenforcedForCc().
 */
export function avoidFeaturesForCc(cc: number): string[] {
  const { forbidden } = ruleForCc(cc);
  return forbidden.includes("MOTORWAY") ? ["highways", "tollways"] : [];
}

/** Human-readable Italian name for a road class, for user-facing warnings. */
const ROAD_CLASS_LABEL: Record<RoadClass, string> = {
  MOTORWAY: "autostrade",
  TRUNK: "superstrade",
};

/**
 * Road classes this vehicle may not legally use but that the routing backend
 * cannot actually exclude — i.e. the gap between what we claim and what we do.
 *
 * Derived from avoidFeaturesForCc() rather than hardcoded, so it collapses to
 * an empty list on its own if the backend ever gains real trunk avoidance
 * (a paid ORS custom model, or a self-hosted engine).
 */
export function unenforcedForCc(cc: number): RoadClass[] {
  const { forbidden } = ruleForCc(cc);
  const enforced: RoadClass[] = avoidFeaturesForCc(cc).includes("highways") ? ["MOTORWAY"] : [];
  return forbidden.filter((rc) => !enforced.includes(rc));
}

/** e.g. ["TRUNK"] -> "superstrade". */
export function labelRoadClasses(classes: RoadClass[]): string {
  return classes.map((rc) => ROAD_CLASS_LABEL[rc]).join(" e ");
}
