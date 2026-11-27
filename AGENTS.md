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

## Work log (ongoing — append every work session)

Ongoing task: this section summarises the prompts given and the actions
taken on this project (including the related flugbuech fork and the
homelab deployment repo), newest first. **Append new sessions at the top.**

### 2026-11-27 (later) — 3D sailplane GLB replay marker implemented (`glb-marker` branch)

- Prompt (from a parent session): implement the queued GLB marker task in
  a worktree of `amos-fork-changes` on a new `glb-marker` branch: replace
  the flat top-down PNG glider marker with the Innerscene "Sailplane
  glider" GLB via deck.gl `SimpleMeshLayer`, verify with the Playwright
  harness (four cardinal bearings + replay), credit the model in the
  README, push the branch.
- Actions:
  - Downloaded the CC0 model to `cmd/server/web/sailplane.glb`
    (6.8 MB, valid glTF v2; 45 untransformed single-primitive meshes,
    10 materials each with its own embedded tiling texture, Y-up, nose
    along +X, ~15 m wingspan / 6.8 m length).
  - **The bundled deck.gl 9.4.2 UMD registers no glTF loader** (only
    JSON/Image), so `mesh: "/sailplane.glb"` fails with "No valid loader
    found" — `app.js` now parses the GLB itself (`loadSailplaneMesh`):
    container chunks → accessors (packed fast path + strided fallback) →
    one merged geometry + blob-URL texture per material, with each
    material's `KHR_texture_transform` tiling baked into the texels. One
    `SimpleMeshLayer` per material part shares the marker position and
    orientation; parsed once, marker appears when ready.
  - Orientation (derived from deck.gl's euler `R = Rz(yaw)·Ry(pitch)·
    Rx(roll)` in the bundle and verified with the four-bearing harness at
    0/90/180/270 — all four noses correct, wings perpendicular):
    `[pitch, 90 - bearing, 90 + bank]`; deck-positive pitch = nose down,
    so pitch = −climb angle (atan2 of windowed vertical/horizontal speed,
    8 s window); roll 90 converts the Y-up GLB to deck's Z-up, + bank =
    turn rate (windowed heading change/s) × gain, clamped ±35°
    (positive = right bank — verified with a nadir underside-visibility
    test at ±60°).
  - Scale: `sizeScale 20` (~300 m wingspan) reads like the old 28–64 px
    icon at zoom 13–15 (verified top-down + perspective screenshots).
  - `?marker=` kept: `glider` (default) = the GLB mesh, `paraglider` =
    the SVG icon layer (unchanged); the mesh shows only with the 3D
    Marker toggle on (else the 2D dot, unchanged); depthTest pattern
    unchanged (false in ground style, true in deck style).
    `glider-topdown.png` retired (was only used by app.js) and deleted.
  - Verified: flight 109 replay (launch climb pitch, thermal bank, zooms
    13–15, follow-cam-style views), flight 84 (different aircraft),
    deck style, paraglider, 2D dot fallback; no console errors; 
    `node --check`, `go test ./...` clean. Port 8095 was occupied
    (`igcviewer-panel`), the test container used 8097.
  - README Credits + CHANGELOG entries added (Innerscene sailplane, CC0,
    credited voluntarily).

### 2026-11-27 — GLB marker task recorded

- Prompt: "about the icon — would a GLB file be more useful? I found a
  free one to use in innerscene.com (sailplane glider 5d42002f)". Later:
  "yes. later. Also remember to give credit to this link in the
  documentation, despite the CC0 not requiring it."
- Action: feasibility verified (deck.SimpleMeshLayer available in the
  bundled deck.gl 9.4.2; GLB downloads as valid glTF v2, 6.8 MB, CC0).
  Task recorded in the flugbuech TODO file
  (`amos-flugbuech/TODO-igcviewer-view-track.md`) with implementation
  notes (orientation math, scale tuning, nose-axis alignment, the
  "assembly" caveat) and the credit requirement for the README. Not yet
  implemented.
- Prompt: "the docker hub vulnerability scan found a few critical
  security bugs ... Add a task to address them later."
- Action: task recorded in the TODO file — the findings come from the
  base images / Go stdlib, not the app code; fix = rebuild from fresh
  bases + toolchain updates, re-scan, and consider scheduled rebuilds.
  Also flagged the tisot image for the same check.

### 2026-11-26 — speed unit, profile click-to-seek, marker fix shipped

- Prompt: "the 2d blue circle is in the right position. the 3d marker
  still picks the wrong direction. leave it for now. where is the
  altitude graph?" → answered (Profile toggle); 3D marker orientation
  noted as an open item.
- Prompt: "Once I click 'play', is there a way to see the entire track
  without reloading the page?" → added: the full track stays visible
  during replay; then "I want a way to see the entire track as if I
  didn't press 'play' at all. Also I want to pick the location of the
  marker on the full track by clicking on the altitude profile." →
  removed the reveal/dimmed-underlay mechanic and added profile
  click-to-seek (works playing and paused). Shipped as v1.9.
- Prompt: "the 2d blue circle ... floats away from the end of the line" →
  the current-position marker now renders as deck geometry at the
  interpolated track position (attached to the line's tip). Shipped as
  v1.8.
- Prompt: "give an option to change speed to knots" → "Speed unit"
  topbar select (km/h / kn, persisted). Shipped as v1.10.
- Prompt: "maintain an AGENTS.md file summarising all the prompts and
  actions taken" → this section.

### 2026-11-26 (early) — altitude panel, render styles, marker/depth fixes shipped

- Prompt: "the 2d blue circle ... floats away..." context; user chose
  "make it an option to choose between [terrain-hugging] and
  [deck-owned terrain]" and asked for the work on a dedicated branch.
- Actions: `rendering-style-option` branch created; deck-vs-maplibre
  vertical-datum mismatch identified as the root cause of
  occlusion/floating (depthTest disabled in ground style — interleaved
  mode depth-composites deck geometry against the terrain mesh);
  2D-marker default + 3D Marker toggle implemented; altitude panel
  merged from the `altitude-panel` branch (background agent: WeGlide-
  style chart, thermal markers, live marker line, stats). Shipped as
  igcviewer v1.7 (PR #32); the homelab deploy was entangled with the
  user's parallel dawarich work on main (resolved via rebase + PR #36
  for the api v1.6 bump).
- Prompt: "would a simple 2D icon avoid the issue?" → answered; led to
  the 2D-marker default.

### 2026-11-26 (start) — render-style option requested

- Prompt: "make it an option to choose between 1 and 3" (terrain-hugging
  vs deck-owned terrain) + "make the changes in a new branch" +
  "move commits done today to the new dedicated branch" → branch
  restructure clarified: today's igcviewer commits were already on
  `amos-fork-changes`; a feature branch was created off it.
- Prompt: "another task — add an optional bottom panel showing the
  altitude AMSL and profile of the ground under the track like
  weglide.org does" (reference screenshot provided) → implemented by a
  background agent on the `altitude-panel` branch (see above).

### 2026-11-25 — preferences, favicons, NIL fix shipped

- Prompts: "add optional column to show 'P2' pilot in the flight list
  page"; "use the ICO file from freepngimg.com (glider icon)"; "favicon
  works now. create a CHANGELOG.md ... audience is the upstream author";
  "remove the done items from the TODO file"; "the generated glider icon
  seems reversed when turning"; "another example — flight 84 flying
  straight shows weird orientation"; "this worked. give an option to
  change speed to knots".
- Actions: P2 column (auto-optional); glider favicon (v1.4) + flugbuech
  favicon (v1.4 after user chose the glider silhouette); CHANGELOGs for
  both repos; TODO trimmed; the four-bearing marker test; top-down
  marker (v1.6); speed unit option (v1.10 — see 2026-11-26).

### 2026-11-24 — integration debugging day

- Prompts: "the igcviewer fetched the file but plays the track in the
  wrong location"; flight 109 described (2026-11-18, VH-GOB LS-4a);
  "right area, offset"; "floats over the map, doesn't move with it;
  start/finish disconnected"; "a reload fixes it"; "the other copy
  (igc.home) renders correctly"; "the repo used to have hooks to
  auto-deploy"; "I cleaned up space. continue"; "how to hard refresh";
  "favicon works now" context; "make the changes compile time flags";
  "instead of main, make the new changes on branch amos-fork-changes";
  "which repo do you refer to?".
- Actions: found the deploy automation (GitHub Actions deploy.yml →
  komodo listeners) and the Docker Hub private-repo issue; root causes
  for the rendering problems (HFDTEDATE:ddmmyy parsing bug; terrain
  timing); fixed + shipped v1.5–v1.7; discovered the Mac disk was full
  (100%) which had made Docker's VM read-only mid-build; branch layout
  restructure (main = upstream mirror, amos-fork-changes = fork work);
  AGENTS.md + CHANGELOG.md created; komodo/deploy verification.

### 2026-11-23 — session start: View track integration

- Prompt: "about the tisot work done in previous session — there is an
  igcviewer container in the same stack. Add a 'view track' button to
  the flugbuech/tisot container to open the igcviewer with a link which
  tells igcviewer to access the uploaded igc file locally... if the
  code has to change, fork it, clone it locally and make the changes
  there."
- Actions: forked abbbi/igcviewer → amosshapira/igcviewer (push-based:
  empty repo + push, after the API fork failed with the fine-grained
  PAT); user's design decisions: token-authenticated server-side fetch
  (flugbuech stores IGC in postgres, so the "file on disk" idea became
  a shared token), Docker Hub image deployment; implemented the
  `flugbuech` build tag fetch endpoint + IGCVIEWER_ADDR + Dockerfile
  (v1.0–v1.3 lineage); flugbuech `igc_view` redirect route + token
  download + View track buttons; deploy pipeline established
  (komodo + versioned image tags); deployed and verified end-to-end.
- Prompts during deploy: "pull access denied" (Docker Hub private repo);
  "I changed my default privacy to public"; "all stack env vars
  disappeared after the last deploy" (komodo env recovery — values
  recovered from the running containers); "the new button opens the
  igcviewer alright, but ... no flugbuech upstream configured"; "error
  when trying to pull new images: no matching manifest for linux/amd64"
  (arm64-only image mistake → multi-arch rebuild); "still waiting?";
  "could it be related to full local macos disk?"; "this worked" (after
  the deploy).

### 2026-11-20 — tisot stack origin (previous session)

- The flugbuech fork (amos-flugbuech) was created with the sailplane/
  gliding fields, glider registration column + IGC glider auto-fill,
  IGC back-fill endpoint + My Flights button, and configurable display
  units; the tisot stack (api + web + igcviewer + db) was deployed on
  picton via komodo, with the igcviewer v0.24 release binary
  (download-and-patch hack). The Caddy routes tisot.home /
  tisot-igc.home were in place.
