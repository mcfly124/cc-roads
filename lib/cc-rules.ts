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
 * Build a GraphHopper "custom model" that (a) forbids road classes the vehicle
 * may not use by driving their priority to zero, and (b) caps speed to the
 * vehicle's realistic top speed. Requires the request to disable CH
 * (`"ch.disable": true`) so the flexible engine honours the custom model.
 */
export function customModelForCc(cc: number) {
  const { forbidden } = ruleForCc(cc);
  const model: {
    priority: { if: string; multiply_by: string }[];
    speed?: { if: string; limit_to: string }[];
  } = {
    priority: forbidden.map((rc) => ({ if: `road_class == ${rc}`, multiply_by: "0" })),
  };
  const top = topSpeedForCc(cc);
  if (top != null) {
    model.speed = [{ if: "true", limit_to: String(top) }];
  }
  return model;
}
