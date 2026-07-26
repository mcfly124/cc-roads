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
 * ORS's free tier does not support custom cost models, so we can only avoid
 * whole feature classes. For the `driving-car` profile the only relevant one is
 * "highways" (= autostrade / motorways).
 *
 * NOTE / known limitation: ORS cannot separately avoid *superstrade* (trunk
 * roads). Legally a ciclomotore (≤50cc) may not use them either, but on the ORS
 * free tier we can only exclude motorways. Trunk-road avoidance for ≤50cc would
 * require a paid ORS custom model or a self-hosted engine.
 */
export function avoidFeaturesForCc(cc: number): string[] {
  const { forbidden } = ruleForCc(cc);
  return forbidden.includes("MOTORWAY") ? ["highways"] : [];
}
