# Changelog

All notable changes in this fork (`amosshapira/igcviewer`) since it diverged
from upstream (`abbbi/igcviewer`) at `aacf1d6` (main), newest first. Written
for the upstream maintainer to decide what (if anything) to integrate.

Highlights in one paragraph: the fork fixes **`HFDTEDATE` parsing for
spec-conformant headers** (upstream only parses the `HFDTEddmmyy` short
form, so e.g. Naviter Oudie files end up with zero dates), fixes the
**floating track** that occurs when a flight renders before its terrain
elevation data has loaded, adds a **`?marker=` choice between glider and
paraglider replay markers**, an **optional altitude/ground profile bottom
panel**, a **favicon**, an **`IGCVIEWER_ADDR`**
listen-address override plus a **multi-stage Dockerfile** for container
deployments, and an **optional flugbuech integration** (behind a build tag)
that can render flights straight from a flugbuech instance. Rendering stack
bumped to maplibre-gl 5.24.1 / deck.gl 9.4.2.

## Added

- **Optional altitude + ground profile panel** (WeGlide-style): a
  "Profile" toggle in the top bar (persisted in
  `localStorage` as `flugbuech-profile-panel`, default hidden) shows a
  bottom panel with a 2D-canvas chart — blue altitude (MSL) line over
  time, brown filled ground profile under the track, magenta vertical
  markers at sustained thermal climbs (windowed climb rate > 0.5 m/s,
  short gaps merged), an HH:MM time axis, a metre altitude axis, and a
  vertical marker line at the current replay position. A stats row above
  the chart shows altitude MSL, height AGL (altitude minus ground
  elevation), climb rate and speed at the replay position. The ground
  profile is sampled lazily via `map.queryTerrainElevation` once the
  terrain elevation tiles have loaded (retried on subsequent idle
  events); when terrain data is unavailable the chart degrades to the
  altitude line without the ground profile.
- **Rendering style option** (`?style=`): `ground` (default; maplibre
  terrain, track clamped onto the terrain surface) or `deck`
  (experimental; the terrain mesh and imagery rendered by deck.gl's
  `TerrainLayer`, with the track flying at true altitude in the same
  projection and deck-side start/end markers). Tile LOD steps at terrain
  edges are a known cosmetic issue in the deck style.
- **2D replay marker by default** with a "3D Marker" top bar toggle
  (persisted in `localStorage` as `flugbuech-marker-3d`): the default
  marker is a map-drawn dot at the current fix's ground position — immune
  to the marker-vs-terrain datum mismatch; the 3D option shows the
  glider/paraglider icon at flight altitude.

## Fixed

- **Track/marker occluded by the terrain in interleaved mode** (`ce2f298`):
  deck.gl layers sharing maplibre's WebGL context are depth-composited
  against the rendered terrain mesh, but deck geometry uses a different
  vertical datum (known upstream limitation, deck.gl #7064) — parts of the
  track and the marker were hidden behind the terrain, which read as a
  "disconnected/reversed" replay. Depth testing is disabled in ground
  style (the track always draws over the terrain); deck style keeps
  natural depth, since its terrain belongs to deck.gl itself.

- **`HFDTEDATE:ddmmyy` header parsing** (`a558f74`): upstream's
  `parseDateHeader` expects the date directly after `HFDTE` (e.g.
  `HFDTE181126`), but the IGC spec form is `HFDTEDATE:ddmmyy[,nn]` —
  written by many recorders (e.g. Naviter Oudie). Those files silently
  parsed with a zero date: the info panel showed `1/1/1` start/end times
  and all fix timestamps were 0001-01-01. Both header forms are now
  accepted (with test).
- **Floating track before terrain loads** (`a558f74`): when a flight
  renders while the terrain elevation tiles of its area are still loading,
  the track was clamped against missing data and floated above the map,
  disconnected from the start/end markers (parallax at pitch). It
  self-"fixed" on reload because tiles were cached. `renderFlight` now
  re-clamps the track onto the terrain once the map is idle after the
  initial `fitBounds`.
- **Replay marker orientation** (`0f68b02`): the freepngimg side-view
  glider icon rotated by heading reads as an X-shaped cross at every
  bearing (a side view cannot be rotated into a heading marker). The
  `glider` marker is now a top-down glider silhouette drawn for this
  project, which reads correctly at every heading. The side-view icon
  remains in use as the favicon art source.

## Added

- **Replay marker choice** (`793a8b8`, `0f68b02`): `?marker=paraglider|glider` query
  parameter selects the replay marker (default: `glider`, a top-down
  silhouette drawn for this project — a side-view icon cannot be rotated
  into a heading marker; `paraglider` is the original SVG marker). Marker
  icon sources and licenses documented in the README Credits section —
  note the freepngimg side-view icon (used for the favicon) is CC BY-NC
  4.0, which you may not want upstream.
- **Favicon** (`90b699a`, `793a8b8`): a GPS-tracking style favicon (map +
  pin + dashed track) as clean SVG (`favicon.svg`) with an ICO fallback —
  the page previously had none.
- **`IGCVIEWER_ADDR` environment variable** (`60a091b`): listen address
  override (default `localhost:8080` unchanged). Makes containerized
  deployments clean — previously the binary hardcoded `localhost:8080`,
  which required a `sed` patch of the binary inside the container to listen
  on a routable interface.
- **Multi-stage Dockerfile** (`60a091b`): golang builder → debian:13-slim
  runtime, `CGO_ENABLED=0` static build. Multi-arch (amd64/arm64) images
  build with `docker buildx build --platform linux/amd64,linux/arm64`.
- **Optional flugbuech integration** (`60a091b`, behind the `flugbuech`
  build tag — NOT compiled in by default, so upstream builds are
  unaffected): `GET /api/flight?flight=<id>` fetches the IGC file of a
  flight from a flugbuech instance (base URL via `IGCVIEWER_UPSTREAM`,
  shared token via `IGCVIEWER_TOKEN` sent as `?t=`) and serves the parsed
  flight JSON. Used by the flugbuech fork's "View track" deep links
  (`amosshapira/flugbuech`, behind ITS `igcviewer` feature flag). The
  integration is integration-specific — include or skip as you see fit;
  the build tag keeps it out of the default binary.

## Changed

- **Rendering stack** (`0f68b02`): maplibre-gl 4.7.1 → 5.24.1, deck.gl
  9.0.40 → 9.4.2. No code changes needed except noted below; verified
  across pitch/zoom/cold-cache runs.
- **Cleanup** (`8621318`): removed the `{exaggerated: false}` option from
  `queryTerrainElevation` (no-op since v5, which returns the actual
  altitude), a dead `typeof map.queryTerrainElevation === "function"`
  version guard, and the unused `buildVisiblePath` function (already dead
  in v0.24, superseded by `buildVisibleSegments`).

## Not a bug (documented to save you debugging time)

- A horizontal band of mismatched satellite imagery near the horizon in
  pitched views is **content in the Esri World_Imagery mosaic** (proven:
  it persists when all DEM tiles are blocked), not a rendering defect.
- During replay, the marker/track legitimately float above the terrain when
  the aircraft is high above the ground (deck.gl projects [lon, lat, alt]
  without maplibre's terrain displacement). Proper terrain-aware layer
  draping would need maplibre 5/6 `renderToTerrainTile` custom layers.
- Esri tile request `net::ERR_ABORTED` entries are view-driven
  cancellations, not server errors.
