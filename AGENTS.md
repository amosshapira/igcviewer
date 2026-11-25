# IGC 3D Flight Viewer (fork)

A 3D IGC flight track viewer. This is a fork of
[abbbi/igcviewer](https://github.com/abbbi/igcviewer) (AGPL-3.0), maintained
for the tisot homelab deployment, with upstream-compatible additions:

- **flugbuech integration** (compile-time, `flugbuech` build tag): a `GET
  /api/flight?flight=<id>` endpoint that fetches the IGC file of a flight
  from the [flugbuech fork](https://github.com/amosshapira/flugbuech)
  (deployed as the `tisot` stack) over the docker network, using a shared
  access token. Used by the "View track" button in the flugbuech UI.
- **Configurable listen address** (`IGCVIEWER_ADDR`) and a multi-stage
  `Dockerfile`.

Please see the upstream README.md for the viewer basics.

## Branch layout

- **`main`**: mirrors upstream (`abbbi/igcviewer`). Fetch upstream updates
  into it (`git fetch upstream && git merge upstream/main`); never commit
  fork changes here. (On the fork it was force-reset to `aacf1d6`, the
  divergence point, when the fork branch was introduced.)
- **`amos-fork-changes`**: `main` + all fork changes. **The default working
  branch** — make changes here, and build release images from this branch.
  To update: merge `main` (upstream) into it as desired.

## Build & Commands

- Build binary: `go build ./cmd/server` (run on `amos-fork-changes`)
- Build with flugbuech integration: `go build -tags flugbuech ./cmd/server`
- Run tests: `go test ./...` (also test with `-tags flugbuech`)
- Vet: `go vet ./...` (run with and without the tag)
- Format: `gofmt -w .`
- Docker build: `docker buildx build --platform linux/amd64,linux/arm64 -t amosshapira/igcviewer:vX.Y -t amosshapira/igcviewer:latest --push .`
  - Multi-arch: the deployment target (picton) is linux/amd64; the dev Mac is arm64. Push BOTH.
  - The `FEATURE_FLUGBUECH=1` build arg (default: 1) controls the build tag.
  - Build from the `amos-fork-changes` branch; bump the version tag and the
    pin in the homelab compose file to deploy.

### Local run

```
IGCVIEWER_ADDR=0.0.0.0:8080 go build -tags flugbuech -o igcviewer ./cmd/server
IGCVIEWER_ADDR=0.0.0.0:8080 ./igcviewer
```

When testing against the production flugbuech API over HTTPS (Caddy with a
private CA), point Go at the CA: `-e SSL_CERT_FILE=/cacert.crt -v
~/caddy-root.crt:/cacert.crt:ro` in docker, or `SSL_CERT_FILE=...` directly.
In production the upstream is plain HTTP inside the docker network, so this
only matters locally.

## Architecture

- **Go server** (`cmd/server/main.go`): HTTP server serving an embedded web
  frontend (`//go:embed web/*`) and a small JSON API.
  - `POST /api/flight`: multipart upload (`igc` field) → parse → flight JSON.
  - `GET /api/flight?flight=<id>` (flugbuech build tag only): fetch the
    flight's IGC file from `IGCVIEWER_UPSTREAM` (the flugbuech web service)
    with `IGCVIEWER_TOKEN` as `?t=` query parameter, parse, return the same
    flight JSON. The flight id must be digits; 404 passes through; the
    response is served to the browser, the token never appears in browser
    URLs.
- **Parser** (`internal/igc/parser.go`): IGC format parser. Handles the
  standard `HFDTEDATE:ddmmyy` header form as well as the plain
  `HFDTEddmmyy` form, and signed pressure altitudes (e.g. Oudie writes
  `EA-0035`).
- **Frontend** (`cmd/server/web/`): plain JS (no build step). MapLibre GL
  (map + terrain) + deck.gl (track layers) loaded from unpkg CDN.
  - `app.js` renders the parsed flight: deck.gl PathLayer/IconLayer over
    the map, start/end markers as a MapLibre circle layer, replay engine.
  - Deep links: `?flight=<id>` auto-loads a flight from the flugbuech
    upstream.

### Environment variables

- `IGCVIEWER_ADDR`: listen address (default `localhost:8080`)
- `IGCVIEWER_UPSTREAM`: flugbuech base URL for flight fetching (flugbuech
  build tag; default disabled)
- `IGCVIEWER_TOKEN`: access token sent to the flugbuech API

## Deployment

- Images are versioned (`amosshapira/igcviewer:vX.Y`) and pinned in the
  homelab compose file
  (`homelab/hosts/picton/sefer-tisot/compose.yml`, project: picton-tisot).
  Compose auto-pulls a tag it doesn't have locally, so **bumping the tag in
  compose deploys the new build without a manual image pull**.
- The stack deploys automatically: merge to homelab `main` → GitHub Actions
  workflow (`deploy.yml`, self-hosted runner on picton) → komodo
  (`deploy-homelab-stacks` procedure) → `BatchDeployStackIfChanged`.
- Komodo stack environment (UI) holds the shared `IGCVIEWER_TOKEN` and
  `FLUGBUECH_*` secrets. Watch for a komodo ResourceSync wiping the stack
  environment (it is regenerated from the repo's stack TOML, which does not
  contain the secrets).

## Rendering knowledge (hard-won)

- **Floating track / disconnected markers**: the track is clamped onto the
  terrain in `buildAdjustedPath` using `map.queryTerrainElevation`. If the
  track renders before the terrain elevation tiles of the flight area have
  loaded, it is clamped against stale/missing data and floats above the map
  (parallax at pitch). `renderFlight` therefore re-clamps via
  `reclampTrackOnTerrain` on `map.once("idle")` after the initial
  `fitBounds`. A browser reload "fixes" it because tiles are cached.
- **`queryTerrainElevation`**: since maplibre v5 it returns the actual
  altitude (unexaggerated by definition); the old `{exaggerated: false}`
  option is gone. With `TERRAIN_EXAGGERATION = 1.0` the semantics are
  equivalent either way.
- **Far-field imagery band at pitch**: a horizontal band of mismatched
  satellite imagery near the horizon in pitched views. This is **content in
  the Esri World_Imagery mosaic** (proven: present even with all DEM tiles
  blocked), NOT a maplibre/deck.gl rendering bug. Do not chase it in
  renderer code.
- **Esri tile server**: no API key, but no rate-limit problems observed in
  normal use; `net::ERR_ABORTED` on tile requests are view-driven
  cancellations (normal), not failures.
- Verification harness: Playwright scripts (cold-cache headless runs +
  headed real-GPU runs) loading `?flight=<id>`, screenshotting at pitch and
  multiple zooms, and asserting the track connects to the start/end dots
  and the terrain clamp is sane (track start alt ≈ terrain + 15..GPS alt).

## Code style

- Go: gofmt, idiomatic small handlers, doc comments on exported/unexported
  functions.
- Frontend JS: no build step, plain ES2020 in browser, `node --check` for
  syntax; keep upstream structure (top-level `const` bindings, classic
  script globals).

## Decisions

- Choose between two approaches: ask (see the flugbuech AGENTS.md).
- Security posture: homelab, LAN-only. The flugbuech integration trusts the
  shared token holder for all flights (no per-user scoping); the token must
  never appear in browser-facing URLs.
