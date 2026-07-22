# cc-roads

Navigation web app that filters roads by a vehicle's engine displacement (cc),
built for driving an **Ape 50** (and other mopeds) in Italy where some roads are
legally off-limits. Installable on iOS as a PWA and deployable on Vercel.

## How it works

You type a `cc` value; the app translates it into the set of road classes that
vehicle may not use under the Italian *Codice della Strada*, then asks
GraphHopper for a route that avoids them.

| Engine size | Class (IT) | Excluded roads |
|---|---|---|
| ≤ 50 cc (Ape 50) | ciclomotore | autostrada + superstrada |
| 50–150 cc | motoveicolo | autostrada |
| ≥ 150 cc | motoveicolo | none |

The mapping lives in [`lib/cc-rules.ts`](lib/cc-rules.ts) — the single source of
truth. OSM road classes: autostrada → `MOTORWAY`, superstrada → `TRUNK`.

## Architecture

```
iOS Safari / PWA  ──POST /api/route {from,to,cc}──▶  Vercel serverless
  MapLibre GL JS                                       • cc → exclusions
  Geolocation                                          • hides API key
                                                       • calls GraphHopper
```

- `app/page.tsx` — map + UI (client)
- `app/api/route/route.ts` — routing proxy (applies the cc logic)
- `app/api/geocode/route.ts` — address search proxy
- `lib/cc-rules.ts` — the legal cc → road-class table

## Run locally

```bash
npm install
cp .env.example .env.local   # then paste your GRAPHHOPPER_API_KEY
npm run dev                  # http://localhost:3000
```

## Deploy to Vercel

1. Push this folder to a Git repo (GitHub/GitLab).
2. Import it at https://vercel.com/new (Next.js is auto-detected).
3. Add env var `GRAPHHOPPER_API_KEY` (and optional `NEXT_PUBLIC_MAPTILER_KEY`).
4. Deploy. Vercel serves it over HTTPS, which Geolocation and PWA install need.

## Install on iPhone

Open the deployed URL in Safari → Share → **Add to Home Screen**. It launches
full-screen (`display: standalone`).

## To do / next steps

- Add `public/icons/icon-192.png` and `icon-512.png` (referenced by the manifest).
- Turn-by-turn voice navigation with live re-routing.
- Prefer smaller roads (Ape 50 tops out at ~45 km/h), not just exclude forbidden ones.
- Offline map caching via a service worker.

> ⚠️ Routes are indicative and based on OpenStreetMap data, which can be
> incomplete. Always follow real road signage.
