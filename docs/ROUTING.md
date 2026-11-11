# Route planning, navigation and tracking

How trips get a planned route, how a driver navigates it, how the driven route is checked, and
how to move from Mapbox to Rapid Rise's own route server. Founder decisions of 11 November 2026:
Mapbox until trips pass about 1,000 a month, then the own server; screen-off tracking through an
Android app (to come) and through vehicle trackers.

All of it sits behind the map switch (Admin, Features in testing).

## What a business gets

- **Plan the route** on a trip (owner or manager): search for a place or tap the map to drop a
  pin, add stops, drag pins, and choose one of up to three routes. Saved with the trip: the stops,
  the line chosen, its distance and time, and which service drew it (`trip_routes`).
- **Navigate**: the trip page opens Google Maps with every stop in order, or Waze to the
  destination. Turn-by-turn stays with those apps; there is no cost or key for these links.
- **Record**: starting a trip starts the driver's driving record, and the driver records the
  route from the trip page. The screen is kept awake while recording, but a phone web page cannot
  record with the screen locked. Trackers and the Android app close that gap.
- **Check**: the trip page and the trip report hold the planned distance against the odometer
  (or the recorded route when there is no odometer reading at both ends), flag a difference
  beyond the business's allowed percentage (10% unless changed on the trip report), and show how
  far the driven route was from the planned one.

## Settings (Vercel environment variables)

| Variable | What it is |
|---|---|
| `ROUTING_PROVIDER` | `mapbox` (the default when unset) or `osrm` |
| `MAPBOX_TOKEN` | Mapbox access token, used only by the server |
| `OSRM_URL` | The own route server's address, for example `https://routes.fleet-wise.co.za` |
| `ROUTING_MONTHLY_CAP` | Route requests a month before planning stops. Mapbox default 95,000 (the free allowance is 100,000); no cap for the own server |
| `NOMINATIM_URL` | Place search. Default: OpenStreetMap's public service |

Nothing else changes between services: both answer in the same shape (`src/lib/routing/providers.ts`).
`/api/health` reports `routing_not_configured` while the settings are missing or wrong.

## Now: Mapbox

1. Create an account at mapbox.com. A card may be asked for; the Directions API's first
   100,000 requests a month are free (mapbox.com/pricing, read 11 November 2026).
2. Account, Tokens, **Create a token**. Leave the default public scopes. Do **not** add URL
   restrictions: the token is used by FLEETWISE's server, which sends no web address, so a
   restricted token would be refused.
3. Vercel, the project, Settings, Environment Variables: add `MAPBOX_TOKEN` for Production with
   the token. Redeploy (Deployments, the latest, Redeploy).
4. Check: `/api/health` no longer lists `routing_not_configured`, and Plan the route shows routes.

Place search does **not** use Mapbox: its free search results may not be stored ("Temporary
results are not allowed to be cached", docs.mapbox.com/api/search/geocoding), and a trip stores its
stops. Searching uses OpenStreetMap instead, whose results may be kept with attribution. Its public
service allows about one search a second for the whole application, so FLEETWISE searches only
when someone presses Search, never while they type.

## When to switch

Admin, Usage, **Route planning** shows trips planned, route requests and searches this month, per
business. When trips planned pass about 1,000 a month, move to the own server.

## Later: the own route server (OSRM)

The open-source engine OSRM with OpenStreetMap's South African roads. The road data is about
400 MB (download.geofabrik.de, South Africa, 404 MB on 10 November 2026). OSRM keeps its prepared
files in memory, roughly the size of those files (OSRM wiki, Disk and Memory Requirements), so a
4 GB server answers routes. Preparing the files takes more memory than serving them: prepare on a
larger machine (or the server resized for an hour) and copy the files across.

1. **Server**: Azure, a Linux VM in South Africa North. Standard_B2s (2 vCPU, 4 GB) was $39.57 a
   month plus about $7 for a 64 GB Standard SSD (Azure retail price list, 11 November 2026).
   Install Docker.
2. **Prepare the roads** (on a machine with 8 GB or more):
   ```sh
   mkdir osrm && cd osrm
   curl -LO https://download.geofabrik.de/africa/south-africa-latest.osm.pbf
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/south-africa-latest.osm.pbf
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/south-africa-latest.osrm
   docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/south-africa-latest.osrm
   ```
   For trips into neighbouring countries, merge their extracts with `osmium merge` first.
3. **Serve** on the VM, with the prepared files copied to `/srv/osrm`:
   ```sh
   docker run -d --restart unless-stopped -p 127.0.0.1:5000:5000 -v /srv/osrm:/data \
     ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/south-africa-latest.osrm
   ```
   Put HTTPS in front (Caddy: `routes.fleet-wise.co.za { reverse_proxy 127.0.0.1:5000 }`), and
   point a DNS record at the VM.
4. **Check** from anywhere:
   `curl "https://routes.fleet-wise.co.za/route/v1/driving/31.0218,-29.8587;28.0473,-26.2041?overview=false"`
   answers `"code":"Ok"`.
5. **Switch**: in Vercel set `ROUTING_PROVIDER=osrm` and `OSRM_URL=https://routes.fleet-wise.co.za`,
   then redeploy. `MAPBOX_TOKEN` can stay as it is; it is no longer used. Routes saved before the
   switch keep `mapbox` as their service.
6. **Keep the roads current**: repeat step 2 monthly and restart the container with the new files.

The same server can later serve the map tiles, which must move off the free test service before
the map is released.

## Vehicle trackers

A business's tracker company sends positions to FLEETWISE through the tracker connection set up
in Driver activity (Rapid Rise provisions it; see `docs/DRIVER_ACTIVITY.md`), with the same token:

```http
POST /api/integrations/positions
Authorization: Bearer <the connection's token>
Content-Type: application/json

{ "machine_id": "<the tracker's own id for the vehicle>",
  "points": [ { "at": "2026-11-11T08:00:00+02:00", "lat": -25.7461, "lng": 28.1881, "speed": 82 } ] }
```

- The vehicle must be linked to that tracker id in Driver activity. A driver is not needed.
- Up to 500 points a request and 128 KB; points up to seven days old (a backlog after a dead
  zone), none in the future.
- Kept only while the map is on for the business. The answer is `{ "ok": true, "kept": n }`.
- Errors: 401 bad token, 409 unknown vehicle id or unusable points, 403 business paused.

Positions are personal information while a person drives (docs/POPIA.md): kept 180 days, seen by
owners and managers, and by a driver only for their own drives.
