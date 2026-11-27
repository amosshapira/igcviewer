const igcFileInput = document.getElementById("igcFileInput");
const uploadBtn = document.getElementById("uploadBtn");
const playBtn = document.getElementById("playBtn");
const baseViewSelect = document.getElementById("baseView");
const playbackSpeedSelect = document.getElementById("playbackSpeed");
const followCamToggle = document.getElementById("followCam");
const marker3dToggle = document.getElementById("marker3d");
const speedUnitSelect = document.getElementById("speedUnit");
const altUnitSelect = document.getElementById("altUnit");
const info = document.getElementById("info");
const topbar = document.querySelector(".topbar");
const profilePanel = document.getElementById("profilePanel");
const profileToggleBtn = document.getElementById("profileToggleBtn");
const profileCanvas = document.getElementById("profileCanvas");
const profileAltMslEl = document.getElementById("profileAltMsl");
const profileAglEl = document.getElementById("profileAgl");
const profileClimbEl = document.getElementById("profileClimb");
const profileSpeedEl = document.getElementById("profileSpeed");

let deckOverlay;
let currentPath = [];
let currentSamples = [];
let currentSegments = [];
let cumulativeDistances = [];
let totalDistanceM = 0;
let animationFrameId = null;
let isPlaying = false;
let playbackProgress = 0;
let playbackStartTs = 0;

const TERRAIN_EXAGGERATION = 1.0;
const MIN_TERRAIN_CLEARANCE_M = 15;
const TERRAIN_DEM_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TERRAIN_TEXTURE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const ALTITUDE_VISUAL_OFFSET_M = 10;
const BASE_PLAYBACK_DURATION_MS = 60000;
const TRACK_COLOR_CLIMB = [239, 68, 68, 245];
const TRACK_COLOR_DEFAULT = [255, 184, 108, 250];
const TRACK_WIDTH_METERS = 1;
const TRACK_STYLE_ZOOM_FAR = 8;
const TRACK_STYLE_ZOOM_NEAR = 14;
const TRACK_STYLE_ZOOM_VERY_NEAR_START = 15;
const TRACK_STYLE_ZOOM_VERY_NEAR_END = 18;
const TRACK_WIDTH_SCALE_FAR = 1.65;
const TRACK_WIDTH_SCALE_NEAR = 1.0;
const TRACK_WIDTH_SCALE_VERY_NEAR = 0.82;
const TRACK_MAIN_MIN_PIXELS_FAR = 5;
const TRACK_MAIN_MIN_PIXELS_NEAR = 2;
const TRACK_MAIN_MIN_PIXELS_VERY_NEAR = 1.5;
const FOLLOW_CAM_MAX_ZOOM = 16;
const FOLLOW_CAM_PITCH_SOFT_LIMIT = 55;

// 3D sailplane replay marker (deck.gl SimpleMeshLayer, GLB model). The
// model is Y-up with the nose along +X at real-world scale (~15 m wingspan;
// deck.gl's euler order means yaw = 90 - bearing points the nose along the
// compass bearing, and roll carries a constant +90 to convert Y-up to
// deck's Z-up). MESH_MARKER_SIZE_SCALE exaggerates the real-world size so
// the marker reads like the previous 28-64 px icon at typical zooms; the
// bank gain maps the turn rate (deg/s) to a roll angle in turns.
const MESH_MARKER_SIZE_SCALE = 20;
const MESH_MARKER_PITCH_SIGN = -1; // deck positive pitch = nose down
const MESH_MARKER_BANK_BASE_DEG = 90; // Y-up GLB -> deck Z-up
const MESH_MARKER_BANK_GAIN = 2.0;
const MESH_MARKER_BANK_MAX_DEG = 35;
const MESH_MARKER_WINDOW_MS = 8000;

// Altitude + ground profile panel (optional, WeGlide-style bottom chart).
const PROFILE_PANEL_STORAGE_KEY = "flugbuech-profile-panel";
const PROFILE_CLIMB_WINDOW_MS = 8000;
const PROFILE_THERMAL_CLIMB_THRESHOLD_MS = 0.5;
const PROFILE_THERMAL_MIN_DURATION_MS = 20000;
const PROFILE_GROUND_MAX_ATTEMPTS = 30;
const PROFILE_CHART_MARGIN = { left: 52, right: 12, top: 8, bottom: 20 };
const PROFILE_CHART_COLORS = {
  altitudeLine: "#3b6ec8",
  ground: "#a97e57",
  thermal: "#c026d3",
  marker: "#1d4ed8",
  grid: "rgba(255, 255, 255, 0.08)",
  label: "#99a7b8",
};

let latestPlaybackDetail = null;
let syncingFollowCamera = false;
// While the pointer hovers over the profile, the marker line and the panel
// stats follow the pointer instead of the replay position (null = follow
// the replay). Declared early: currentProfileTimeMs (called during the
// flight load when the profile panel is enabled) reads it.
let profileHoverTimeMs = null;

const MARKER_3D_STORAGE_KEY = "flugbuech-marker-3d";

// Replay marker preference: the 2D marker (a screen-space dot at the
// revealed track's tip, default) or the 3D marker (deck.gl icon at flight
// altitude). Persisted per browser.
function isMarker3dEnabled() {
  return marker3dToggle?.checked ?? false;
}

function initializeMarker3dToggle() {
  if (!marker3dToggle) {
    return;
  }
  marker3dToggle.checked = localStorage.getItem(MARKER_3D_STORAGE_KEY) === "1";
  marker3dToggle.addEventListener("change", () => {
    localStorage.setItem(MARKER_3D_STORAGE_KEY, marker3dToggle.checked ? "1" : "0");
    rerenderTrackForCurrentState();
  });
}

// Profile panel state: ground elevations per sample (null when unknown),
// detected thermal segments, and an offscreen canvas holding the static
// chart (redrawn per replay tick by blitting + overlaying the marker).
let profileVisible = false;
let profileGroundM = [];
let profileGroundAvailable = false;
let profileGroundAttempts = 0;
let profileThermals = [];
let profileStaticCanvas = null;
let profileChartGeom = null;

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
        maxzoom: 19,
      },
      satellite: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "osm-base",
        type: "raster",
        source: "osm",
      },
      {
        id: "satellite-base",
        type: "raster",
        source: "satellite",
        layout: {
          visibility: "none",
        },
      },
    ],
  },
  center: [11.47, 47.39],
  zoom: 10,
  pitch: 65,
  bearing: 20,
  antialias: true,
});

map.addControl(new maplibregl.NavigationControl({
    visualizePitch: true,
    showCompass: true,
    showZoom: true,
    visualizePitch: true,
    visualizeRoll: true
}), "top-right");

map.on("load", async () => {
  initializeMarker3dToggle();
  initializeSpeedUnit();
  initializeAltUnit();  applyBaseView(baseViewSelect.value);

  if (RENDER_STYLE === "deck") {
    // Experimental deck-owned terrain: maplibre stays flat and hidden, the
    // terrain mesh + imagery come from deck.gl's TerrainLayer.
    map.setLayoutProperty("osm-base", "visibility", "none");
    map.setLayoutProperty("satellite-base", "visibility", "none");
    map.addLayer({ id: "bg", type: "background", paint: { "background-color": "#0b1220" } });
  } else {
    applyTerrain();
  }

  deckOverlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(deckOverlay);

  map.addSource("route-points", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  if (RENDER_STYLE !== "deck") {
    map.addLayer({
      id: "route-points",
      type: "circle",
      source: "route-points",
      paint: {
        "circle-radius": ["case", ["==", ["get", "pointType"], "start"], 6, 4],
        "circle-color": ["case", ["==", ["get", "pointType"], "start"], "#22c55e", "#ef4444"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  info.textContent = "Choose an IGC file and click Upload.";

  // If a "flight" query parameter is present, load and render the referenced
  // flight from the flugbuech instance (used for deep links from other tools).
  const flightId = new URLSearchParams(window.location.search).get("flight");
  if (flightId) {
    info.textContent = "Loading flight...";
    try {
      const res = await fetch(`/api/flight?flight=${encodeURIComponent(flightId)}`);
      if (!res.ok) {
        throw new Error(await res.text());
      }
      renderFlight(await res.json());
    } catch (err) {
      info.textContent = String(err?.message || err);
    }
  }
});

map.on("zoomend", () => {
  if (syncingFollowCamera || !isFollowCamEnabled() || !latestPlaybackDetail?.position) {
    return;
  }
  updateFollowCamera(latestPlaybackDetail);
});

map.on("zoom", () => {
  rerenderTrackForCurrentState();
});

uploadBtn.addEventListener("click", async () => {
  const file = igcFileInput.files?.[0];
  if (!file) {
    info.textContent = "Please choose an .igc file first.";
    return;
  }

  try {
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Uploading...";
    const flight = await uploadFlight(file);
    renderFlight(flight);
  } catch (err) {
    info.textContent = String(err?.message || err);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = "Upload";
  }
});

playBtn.addEventListener("click", () => {
  if (currentPath.length < 2) {
    return;
  }

  if (isPlaying) {
    pausePlayback();
    return;
  }

  if (playbackProgress >= 1) {
    playbackProgress = 0;
  }

  startPlayback();
});

playbackSpeedSelect.addEventListener("change", () => {
  if (!isPlaying) {
    return;
  }
  // Keep current progress when changing speed mid-flight.
  playbackStartTs = performance.now() - playbackProgress * getPlaybackDurationMs();
});

baseViewSelect.addEventListener("change", () => {
  applyBaseView(baseViewSelect.value);
});

followCamToggle?.addEventListener("change", () => {
  if (!isFollowCamEnabled() || !latestPlaybackDetail?.position) {
    return;
  }
  updateFollowCamera(latestPlaybackDetail);
});

profileToggleBtn.addEventListener("click", () => {
  setProfileVisible(!profileVisible);
});

window.addEventListener("resize", () => {
  if (!profileVisible) {
    return;
  }
  drawProfileChart();
  drawProfileMarker(currentProfileTimeMs());
});

// Restore the persisted panel preference (default: hidden).
setProfileVisible(
  (() => {
    try {
      return localStorage.getItem(PROFILE_PANEL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  })()
);

async function uploadFlight(file) {
  const formData = new FormData();
  formData.append("igc", file, file.name);

  const res = await fetch("/api/flight", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to parse flight: ${text}`);
  }
  return res.json();
}

function renderFlight(flight) {
  stopPlayback();

  const coords = flight.geojson.features[0].geometry.coordinates;
  currentSamples = (flight.samples || []).map((s) => ({
    lon: Number(s.lon),
    lat: Number(s.lat),
    altM: Number(s.altM),
    timeMs: new Date(s.time).getTime(),
  }));

  const start = coords[0];
  const end = coords[coords.length - 1];

  currentPath = buildAdjustedPath(coords);
  currentSegments = buildRouteSegments(currentPath, currentSamples);

  buildPathMetrics(currentPath);
  playbackProgress = 0;
  playBtn.disabled = false;
  playBtn.textContent = "Play";
  const startDetail = { position: currentPath[0], segIndex: 1, segT: 0 };
  latestPlaybackDetail = startDetail;
  renderDeckLayers(currentPath, markerFromDetail(startDetail), startDetail);

  if (RENDER_STYLE !== "deck") {
    map.getSource("route-points").setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { pointType: "start" },
          geometry: { type: "Point", coordinates: start },
        },
        {
          type: "Feature",
          properties: { pointType: "end" },
          geometry: { type: "Point", coordinates: end },
        },
      ],
    });
  }

  map.fitBounds(
    [
      [flight.bounds[0], flight.bounds[1]],
      [flight.bounds[2], flight.bounds[3]],
    ],
    { padding: 80, duration: 1200 }
  );

  // Re-clamp the track once the map has settled on the new view: terrain
  // elevation tiles for the flight area might only be loaded by then. While
  // the terrain is still loading, the track would otherwise stay clamped
  // against stale (or missing) elevation data and float above the map.
  map.once("idle", () => reclampTrackOnTerrain(coords));

  // Reset the profile panel for the new flight: the altitude line and the
  // thermal markers can be drawn right away; the ground profile is sampled
  // once the terrain elevation tiles have loaded (see map idle above).
  resetProfileForFlight();
  scheduleGroundProfileComputation();

  renderInfo(flight);
  updateReplayStats({ speedKmh: 0, climbRateMs: 0, progress: 0, elapsedSec: 0 });
}

function reclampTrackOnTerrain(coords) {
  if (map.isMoving()) {
    // Still animating (e.g. the fitBounds flight): wait for the next idle.
    map.once("idle", () => reclampTrackOnTerrain(coords));
    return;
  }
  if (currentPath.length < 2) {
    return;
  }
  currentPath = buildAdjustedPath(coords);
  currentSegments = buildRouteSegments(currentPath, currentSamples);
  rerenderTrackForCurrentState();
}

function renderDeckLayers(path, marker, detail) {
  const trackStyle = getTrackStyleForZoom();
  const layers = [];

  // In ground style the deck geometry shares maplibre's WebGL context but
  // uses a different vertical datum than the rendered terrain (known
  // deck.gl/maplibre limitation), which would occlude parts of the track
  // and marker behind the terrain mesh. Depth testing is therefore off.
  // In deck style the terrain belongs to deck.gl itself, so natural depth
  // testing is consistent.
  const depthTest = RENDER_STYLE === "deck";

  if (RENDER_STYLE === "deck") {
    // Experimental: the terrain mesh + imagery rendered by deck.gl itself,
    // so track and terrain share one projection.
    layers.push(
      new deck.TerrainLayer({
        id: "deck-terrain",
        elevationData: TERRAIN_DEM_URL,
        texture: TERRAIN_TEXTURE_URL,
        elevationDecoder: { rScaler: 256, gScaler: 1, bScaler: 1 / 256, offset: -32768 },
        wireframe: false,
      }),
    );
  }

  // The full track is always visible, also during replay: the moving
  // marker (2D dot or 3D icon) shows the replay position along it.
  layers.push(
    new deck.PathLayer({
      id: "flight-path-3d",
      data: currentSegments,
      getPath: (d) => d.path,
      getColor: (d) => d.color,
      widthUnits: "meters",
      getWidth: TRACK_WIDTH_METERS,
      widthScale: trackStyle.widthScale,
      widthMinPixels: trackStyle.mainMinPixels,
      capRounded: true,
      jointRounded: true,
      billboard: false,
      parameters: { depthTest },
    }),
  );
  if (USE_MESH_MARKER) {
    // The glider marker: a 3D sailplane GLB mesh oriented with the flight
    // (yaw = bearing, pitch = climb angle, roll = bank), shown under the
    // same conditions as the flat icon: only with the 3D marker toggle
    // enabled; otherwise the 2D screen-space dot below is used.
    if (isMarker3dEnabled() && marker) {
      const meshLayers = getMarkerMeshLayers(marker, depthTest);
      if (meshLayers) {
        layers.push(...meshLayers);
      }
    }
  } else {
    layers.push(
      new deck.IconLayer({
        id: "flight-marker",
        data: isMarker3dEnabled() && marker ? [marker] : [],
        pickable: false,
        getPosition: (d) => d.position,
        getAngle: (d) => d.angle || 0,
        getIcon: () => markerIcon,
        sizeUnits: "meters",
        getSize: 95,
        sizeMinPixels: 28,
        sizeMaxPixels: 64,
        billboard: false,
        parameters: { depthTest },
      }),
    );
  }

  if (RENDER_STYLE === "deck") {
    // Start/end markers as deck geometry (the maplibre route-points layer
    // is not loaded in this style and sits on the datum plane).
    layers.push(
      new deck.ScatterplotLayer({
        id: "endpoints",
        data: [currentPath[0], currentPath[currentPath.length - 1]],
        pickable: false,
        getPosition: (d) => d,
        getRadius: 12,
        radiusUnits: "pixels",
        getFillColor: (d, { index }) => (index === 0 ? [34, 197, 94, 230] : [239, 68, 68, 230]),
        stroked: true,
        getLineColor: [255, 255, 255, 230],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
      }),
    );
  }

  // Current-position marker: a screen-space dot exactly at the revealed
  // track's tip, so it always stays connected to the line regardless of the
  // marker-vs-terrain datum difference. Used unless the 3D icon marker is
  // enabled.
  if (!isMarker3dEnabled() && detail?.position) {
    layers.push(
      new deck.ScatterplotLayer({
        id: "current-marker",
        data: [detail.position],
        pickable: false,
        getPosition: (d) => d,
        getRadius: 8,
        radiusUnits: "pixels",
        getFillColor: [59, 130, 246, 255],
        stroked: true,
        getLineColor: [255, 255, 255, 255],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
      }),
    );
  }

  deckOverlay.setProps({ layers });
}

function getTrackStyleForZoom() {
  const zoomT = clamp(
    (map.getZoom() - TRACK_STYLE_ZOOM_FAR) / (TRACK_STYLE_ZOOM_NEAR - TRACK_STYLE_ZOOM_FAR),
    0,
    1
  );
  const veryNearT = clamp(
    (map.getZoom() - TRACK_STYLE_ZOOM_VERY_NEAR_START) /
      (TRACK_STYLE_ZOOM_VERY_NEAR_END - TRACK_STYLE_ZOOM_VERY_NEAR_START),
    0,
    1
  );

  const nearWidthScale = lerp(TRACK_WIDTH_SCALE_FAR, TRACK_WIDTH_SCALE_NEAR, zoomT);
  const nearMinPixels = lerp(TRACK_MAIN_MIN_PIXELS_FAR, TRACK_MAIN_MIN_PIXELS_NEAR, zoomT);

  return {
    widthScale: lerp(nearWidthScale, TRACK_WIDTH_SCALE_VERY_NEAR, veryNearT),
    mainMinPixels: lerp(nearMinPixels, TRACK_MAIN_MIN_PIXELS_VERY_NEAR, veryNearT),
  };
}

function rerenderTrackForCurrentState() {
  if (!deckOverlay || currentPath.length < 2) {
    return;
  }

  const detail = latestPlaybackDetail || { position: currentPath[0], segIndex: 1, segT: 0 };
  renderDeckLayers(currentPath, markerFromDetail(detail), detail);
}

function createParagliderIcon() {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <path d="M8 40 C24 12, 72 12, 88 40 L80 42 C66 24, 30 24, 16 42 Z" fill="#111111"/>
  <line x1="30" y1="40" x2="46" y2="66" stroke="#dbe4f3" stroke-width="2.8"/>
  <line x1="66" y1="40" x2="50" y2="66" stroke="#dbe4f3" stroke-width="2.8"/>
  <ellipse cx="48" cy="74" rx="7" ry="9" fill="#f8fafc"/>
  <circle cx="48" cy="62" r="3.8" fill="#f8fafc"/>
  <line x1="48" y1="66" x2="48" y2="83" stroke="#f8fafc" stroke-width="2"/>
</svg>`;
  return {
    id: "paraglider",
    url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    width: 96,
    height: 96,
    anchorY: 72,
  };
}

// Replay marker selection: "glider" (default; the 3D sailplane GLB mesh)
// or "paraglider" (the flat SVG icon), chosen via the "marker" query
// parameter (used by flugbuech deep links; see the per-user track marker
// preference).
const MARKER_PARAM = new URLSearchParams(window.location.search).get("marker");
const USE_MESH_MARKER = MARKER_PARAM !== "paraglider";
const markerIcon = USE_MESH_MARKER ? null : createParagliderIcon();

// The bundled deck.gl build registers no glTF loader, so the sailplane GLB
// is parsed here into the plain geometry objects SimpleMeshLayer accepts.
// The model (Innerscene "Sailplane glider", CC0) is one unanimated scene of
// 45 single-primitive meshes whose ten materials each sample their own
// embedded tiling texture, so one geometry + texture pair is produced per
// material group. Parsed once, then reused by every marker layer.
const GLB_COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const GLB_COMPONENT_READERS = {
  5120: (v, at) => v.getInt8(at),
  5121: (v, at) => v.getUint8(at),
  5122: (v, at) => v.getInt16(at, true),
  5123: (v, at) => v.getUint16(at, true),
  5125: (v, at) => v.getUint32(at, true),
  5126: (v, at) => v.getFloat32(at, true),
};
const GLB_COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"
const GLB_CHUNK_BIN = 0x004e4942; // "BIN\0"

let markerMeshPromise = null;
let markerMeshParts = null;
let markerMeshFailed = false;

// Starts parsing /sailplane.glb once; re-renders when it is ready so the
// marker appears as soon as loading finishes.
function ensureMarkerMeshLoaded() {
  if (markerMeshPromise || markerMeshFailed) {
    return;
  }
  markerMeshPromise = loadSailplaneMesh("/sailplane.glb")
    .then((parts) => {
      markerMeshParts = parts;
      rerenderTrackForCurrentState();
    })
    .catch((err) => {
      markerMeshFailed = true;
      console.error("Failed to load the sailplane marker mesh:", err);
    });
}

// One SimpleMeshLayer per parsed part, all sharing the marker position and
// orientation. The model texture is intentionally not used: the GLB's
// baked-in colors are too dark against terrain imagery, and SimpleMeshLayer
// can only multiply the instance color into the texture (it cannot
// brighten). A solid bright color reads much better.
const MARKER_MESH_COLOR = [255, 255, 255, 255];
function getMarkerMeshLayers(marker, depthTest) {
  if (!markerMeshParts) {
    ensureMarkerMeshLoaded();
    return null;
  }
  return markerMeshParts.map((part, index) => new deck.SimpleMeshLayer({
    id: `flight-marker-mesh-${index}`,
    data: [marker],
    pickable: false,
    getPosition: (d) => d.position,
    getOrientation: (d) => d.orientation || [0, 0, 0],
    getColor: MARKER_MESH_COLOR,
    mesh: part.mesh,
    sizeScale: MESH_MARKER_SIZE_SCALE,
    parameters: { depthTest },
  }));
}

// Fetches and parses the glTF v2 binary (GLB) container: a 12-byte header
// followed by a JSON chunk and a binary chunk.
async function loadSailplaneMesh(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buffer.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkType === GLB_CHUNK_JSON) {
      json = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buffer, offset, chunkLength)),
      );
    } else if (chunkType === GLB_CHUNK_BIN) {
      bin = new Uint8Array(buffer, offset, chunkLength);
    }
    offset += chunkLength;
  }
  if (!json || !bin) {
    throw new Error("missing glTF JSON/BIN chunk");
  }

  // Merge all mesh primitives into one geometry per material (each of the
  // model's nodes is untransformed, so vertex positions share one space).
  const groups = new Map();
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const materialIndex = primitive.material || 0;
      let group = groups.get(materialIndex);
      if (!group) {
        group = { positions: [], normals: [], texels: [], indices: [], vertexCount: 0 };
        groups.set(materialIndex, group);
      }
      const positions = glbReadAccessor(json, bin, primitive.attributes.POSITION);
      group.positions.push(positions);
      group.normals.push(glbReadAccessor(json, bin, primitive.attributes.NORMAL));
      group.texels.push(glbReadAccessor(json, bin, primitive.attributes.TEXCOORD_0));
      const indexData = glbReadAccessor(json, bin, primitive.indices);
      const base = group.vertexCount;
      for (let i = 0; i < indexData.length; i++) {
        group.indices.push(indexData[i] + base);
      }
      group.vertexCount += positions.length / 3;
    }
  }

  const parts = [];
  for (const [materialIndex, group] of groups) {
    parts.push(buildMarkerMeshPart(json, bin, materialIndex, group));
  }
  return parts;
}

// Builds one SimpleMeshLayer mesh object + texture URL from a merged
// material group. The material's tiling transform (KHR_texture_transform)
// is baked into the texels so the texture can be sampled with repeat
// addressing.
function buildMarkerMeshPart(json, bin, materialIndex, group) {
  const material = json.materials[materialIndex];
  const textureInfo = material?.pbrMetallicRoughness?.baseColorTexture;
  const transform = textureInfo?.extensions?.KHR_texture_transform || {};
  const uvOffset = transform.offset || [0, 0];
  const uvScale = transform.scale || [1, 1];

  const positions = concatFloat32(group.positions);
  const normals = concatFloat32(group.normals);
  const texels = concatFloat32(group.texels);
  for (let i = 0; i < texels.length; i += 2) {
    texels[i] = texels[i] * uvScale[0] + uvOffset[0];
    texels[i + 1] = texels[i + 1] * uvScale[1] + uvOffset[1];
  }

  return {
    mesh: {
      topology: "triangle-list",
      attributes: {
        positions: { value: positions, size: 3 },
        normals: { value: normals, size: 3 },
        texCoords: { value: texels, size: 2 },
      },
      indices: { value: new Uint32Array(group.indices), size: 1 },
    },
    texture: glbTextureUrl(json, bin, textureInfo ? textureInfo.index : null),
  };
}

// Reads a glTF accessor as one flat typed array (the common tightly packed
// layout fast path; interleaved buffer views are copied component-wise).
function glbReadAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const bufferView = json.bufferViews[accessor.bufferView];
  const TypedArray = GLB_COMPONENT_ARRAYS[accessor.componentType];
  const componentCount = GLB_COMPONENT_COUNTS[accessor.type];
  const componentBytes = TypedArray.BYTES_PER_ELEMENT;
  const start =
    bin.byteOffset + (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const packedBytes = componentCount * componentBytes;
  const stride = bufferView.byteStride || packedBytes;
  if (
    stride === packedBytes &&
    start % componentBytes === 0 &&
    (bufferView.byteLength || 0) >= accessor.count * packedBytes
  ) {
    return new TypedArray(bin.buffer, start, accessor.count * componentCount);
  }
  const read = GLB_COMPONENT_READERS[accessor.componentType];
  const out = new TypedArray(accessor.count * componentCount);
  const dataView = new DataView(bin.buffer);
  for (let i = 0; i < accessor.count; i++) {
    const row = start + i * stride;
    for (let c = 0; c < componentCount; c++) {
      out[i * componentCount + c] = read(dataView, row + c * componentBytes);
    }
  }
  return out;
}

// Object URLs for the embedded texture images (one per material texture).
function glbTextureUrl(json, bin, textureIndex) {
  if (textureIndex == null) {
    return null;
  }
  const image = json.images[json.textures[textureIndex].source];
  const bufferView = json.bufferViews[image.bufferView];
  const start = bin.byteOffset + (bufferView.byteOffset || 0);
  const bytes = bin.buffer.slice(start, start + bufferView.byteLength);
  return URL.createObjectURL(
    new Blob([bytes], { type: image.mimeType || "image/png" }),
  );
}

function concatFloat32(chunks) {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Rendering style: "ground" (default; maplibre terrain, track clamped onto
// the terrain surface) or "deck" (experimental; maplibre terrain off, the
// terrain mesh rendered by deck.gl itself, track at true altitude).
const RENDER_STYLE_PARAM = new URLSearchParams(window.location.search).get(
  "style",
);
const RENDER_STYLE =
  RENDER_STYLE_PARAM === "deck" ? "deck" : "ground";

function markerFromDetail(detail) {
  if (!detail || !detail.position) {
    return null;
  }
  if (currentPath.length < 2) {
    return { position: detail.position, angle: 0, orientation: [0, 0, 0] };
  }
  const idx = Math.min(Math.max(detail.segIndex, 1), currentPath.length - 1);
  const a = currentPath[idx - 1];
  const b = currentPath[idx];
  const angle = bearingDegrees(a, b);
  const prevSample = currentSamples[idx - 1];
  const nextSample = currentSamples[idx];
  const tMs =
    prevSample && nextSample
      ? prevSample.timeMs + (nextSample.timeMs - prevSample.timeMs) * detail.segT
      : 0;
  return {
    position: detail.position,
    angle,
    orientation: meshMarkerOrientation(angle, tMs, idx),
  };
}

// 3D marker orientation as deck.gl's [pitch, yaw, roll] degrees: yaw from
// the track bearing (deck yaw is CCW around up and the GLB nose is +X, so
// yaw = 90 - bearing points the nose along the compass bearing), pitch
// from the climb angle (atan2 of vertical over horizontal speed in a
// window around the replay position) and a bank proportional to the turn
// rate on top of the constant +90 roll that converts the Y-up GLB to
// deck's Z-up world. Signs are derived from deck.gl's euler convention and
// verified with the four-bearing harness test (see the MESH_MARKER_*
// constants).
function meshMarkerOrientation(bearingDeg, centerTimeMs, segIndex) {
  const pitchDeg =
    MESH_MARKER_PITCH_SIGN *
    windowedClimbAngleDeg(centerTimeMs, segIndex, MESH_MARKER_WINDOW_MS);
  const bankDeg =
    windowedTurnRateDegPerSec(centerTimeMs, segIndex, MESH_MARKER_WINDOW_MS) *
    MESH_MARKER_BANK_GAIN;
  return [
    pitchDeg,
    90 - bearingDeg,
    MESH_MARKER_BANK_BASE_DEG +
      clamp(bankDeg, -MESH_MARKER_BANK_MAX_DEG, MESH_MARKER_BANK_MAX_DEG),
  ];
}

// Climb angle in degrees in a window around the replay position.
function windowedClimbAngleDeg(centerTimeMs, segIndex, windowMs) {
  const span = windowedSampleSpan(centerTimeMs, segIndex, windowMs);
  if (!span) {
    return 0;
  }
  const [a, b] = span;
  const dtSec = Math.max((b.timeMs - a.timeMs) / 1000, 0.001);
  const horizontalM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  const verticalM = b.altM - a.altM;
  return (Math.atan2(verticalM, Math.max(horizontalM, 1)) * 180) / Math.PI;
}

// Average turn rate in degrees per second in a window around the replay
// position (heading change from the window start to its middle vs from
// the middle to its end), used to bank the 3D marker in turns.
function windowedTurnRateDegPerSec(centerTimeMs, segIndex, windowMs) {
  const span = windowedSampleSpan(centerTimeMs, segIndex, windowMs);
  if (!span) {
    return 0;
  }
  const [a, b] = span;
  const mid = currentSamples[Math.min(Math.max(segIndex, 1), currentSamples.length - 1)];
  const dtSec = Math.max((b.timeMs - a.timeMs) / 1000, 0.001);
  const headingIn = bearingDegrees([a.lon, a.lat], [mid.lon, mid.lat]);
  const headingOut = bearingDegrees([mid.lon, mid.lat], [b.lon, b.lat]);
  return shortestAngleDeg(headingOut - headingIn) / dtSec;
}

// Samples around the replay position spanning windowMs (the same walk as
// computeWindowedClimbRateMs), as [start, end] or null when unavailable.
function windowedSampleSpan(centerTimeMs, segIndex, windowMs) {
  if (currentSamples.length < 2 || segIndex <= 0 || segIndex >= currentSamples.length) {
    return null;
  }
  const halfWindowMs = Math.max(windowMs, 1000) / 2;
  let left = Math.max(0, segIndex - 1);
  let right = Math.min(currentSamples.length - 1, segIndex);
  while (left > 0 && centerTimeMs - currentSamples[left].timeMs < halfWindowMs) {
    left -= 1;
  }
  while (
    right < currentSamples.length - 1 &&
    currentSamples[right].timeMs - centerTimeMs < halfWindowMs
  ) {
    right += 1;
  }
  if (left === right) {
    return null;
  }
  return [currentSamples[left], currentSamples[right]];
}

function shortestAngleDeg(deltaDeg) {
  return ((deltaDeg + 540) % 360) - 180;
}

function buildAdjustedPath(path) {
  // deck style: true altitudes (the deck terrain and the track share one
  // projection). ground style: clamp onto the terrain surface.
  if (RENDER_STYLE === "deck") {
    return path;
  }
  return path.map((c) => {
    const [lon, lat, alt] = c;
    let adjustedAlt = Number(alt) + ALTITUDE_VISUAL_OFFSET_M;

    const terrainAlt = map.queryTerrainElevation([lon, lat]);
    if (terrainAlt !== null && terrainAlt !== undefined) {
      adjustedAlt = Math.max(adjustedAlt, terrainAlt + MIN_TERRAIN_CLEARANCE_M);
    }
    return [lon, lat, adjustedAlt];
  });
}

function applyTerrain() {
  if (RENDER_STYLE === "deck") {
    return;
  }
  map.setTerrain(null);
  if (map.getSource("terrain-source")) {
    map.removeSource("terrain-source");
  }

  map.addSource("terrain-source", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    tileSize: 256,
    encoding: "terrarium",
    maxzoom: 13,
  });

  map.setTerrain({ source: "terrain-source", exaggeration: TERRAIN_EXAGGERATION });
}

function applyBaseView(mode) {
  if (RENDER_STYLE === "deck") {
    // The deck terrain layer provides the imagery; maplibre layers stay hidden.
    return;
  }
  const showSatellite = mode === "satellite";
  map.setLayoutProperty("osm-base", "visibility", showSatellite ? "none" : "visible");
  map.setLayoutProperty("satellite-base", "visibility", showSatellite ? "visible" : "none");
}

function startPlayback() {
  if (currentPath.length < 2 || totalDistanceM <= 0) {
    return;
  }
  isPlaying = true;
  playBtn.textContent = "Pause";
  playbackStartTs = performance.now() - playbackProgress * getPlaybackDurationMs();
  animationFrameId = requestAnimationFrame(tickPlayback);
}

function pausePlayback() {
  isPlaying = false;
  playBtn.textContent = playbackProgress >= 1 ? "Replay" : "Play";
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function stopPlayback() {
  isPlaying = false;
  playbackProgress = 0;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  playBtn.textContent = "Play";
}

function tickPlayback(ts) {
  if (!isPlaying) {
    return;
  }

  const elapsed = ts - playbackStartTs;
  playbackProgress = clamp(elapsed / getPlaybackDurationMs(), 0, 1);
  const detail = interpolatePathDetailed(currentPath, cumulativeDistances, totalDistanceM, playbackProgress);
  latestPlaybackDetail = detail;
  renderDeckLayers(currentPath, markerFromDetail(detail), detail);
  const stats = computePlaybackStats(detail);
  updateReplayStats(stats);
  updateProfileReplay(detail, stats);
  if (isFollowCamEnabled()) {
    updateFollowCamera(detail);
  }

  if (playbackProgress >= 1) {
    isPlaying = false;
    animationFrameId = null;
    if (followCamToggle) {
      followCamToggle.checked = false;
    }
    playBtn.textContent = "Replay";
    return;
  }

  animationFrameId = requestAnimationFrame(tickPlayback);
}

function buildRouteSegments(path, samples) {
  if (!Array.isArray(path) || path.length < 2) {
    return [];
  }

  const segMeta = [];
  const positiveClimbs = [];

  for (let i = 1; i < path.length; i++) {
    const start = path[i - 1];
    const end = path[i];
    let climbRateMs = 0;

    if (samples[i - 1] && samples[i]) {
      const dt = Math.max((samples[i].timeMs - samples[i - 1].timeMs) / 1000, 0.001);
      climbRateMs = (samples[i].altM - samples[i - 1].altM) / dt;
    }
    if (climbRateMs > 0) {
      positiveClimbs.push(climbRateMs);
    }

    segMeta.push({ path: [start, end], climbRateMs });
  }

  const highlightThreshold = quantile(positiveClimbs, 0.8);
  return segMeta.map((seg) => ({
    ...seg,
    color:
      Number.isFinite(highlightThreshold) && seg.climbRateMs >= highlightThreshold
        ? TRACK_COLOR_CLIMB
        : TRACK_COLOR_DEFAULT,
  }));
}

function quantile(values, q) {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function updateFollowCamera(detail) {
  if (!detail?.position) {
    return;
  }
  const [lon, lat] = detail.position;
  const zoom = Math.min(map.getZoom(), FOLLOW_CAM_MAX_ZOOM);
  const pitch = Math.min(map.getPitch(), FOLLOW_CAM_PITCH_SOFT_LIMIT);
  const offset = getFollowCamOffset();
  syncingFollowCamera = true;
  try {
    map.jumpTo({ center: [lon, lat], zoom, pitch, offset });
  } finally {
    syncingFollowCamera = false;
  }
}

function getFollowCamOffset() {
  const topbarHeight = topbar?.getBoundingClientRect?.().height || 0;
  // Keep the glider visually centered in the full viewport (including top menu area).
  return [0, -topbarHeight / 2];
}

function buildPathMetrics(path) {
  cumulativeDistances = [0];
  let total = 0;

  for (let i = 1; i < path.length; i++) {
    const seg = distance3D(path[i - 1], path[i]);
    total += seg;
    cumulativeDistances.push(total);
  }

  totalDistanceM = total;
}

function interpolatePathDetailed(path, cumulative, totalDistance, progress) {
  if (path.length === 0) {
    return { position: null, segIndex: 0, segT: 0 };
  }
  if (path.length === 1 || totalDistance <= 0) {
    return { position: path[0], segIndex: 0, segT: 0 };
  }

  const target = progress * totalDistance;
  let idx = 1;
  while (idx < cumulative.length && cumulative[idx] < target) {
    idx += 1;
  }

  if (idx >= path.length) {
    return { position: path[path.length - 1], segIndex: path.length - 1, segT: 1 };
  }

  const prevDist = cumulative[idx - 1];
  const nextDist = cumulative[idx];
  const segLen = Math.max(nextDist - prevDist, 1e-6);
  const t = (target - prevDist) / segLen;
  const a = path[idx - 1];
  const b = path[idx];

  return {
    position: [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)],
    segIndex: idx,
    segT: t,
  };
}

function computePlaybackStats(detail) {
  if (!currentSamples.length || detail.segIndex <= 0 || detail.segIndex >= currentSamples.length) {
    return { speedKmh: 0, climbRateMs: 0, progress: playbackProgress, elapsedSec: 0 };
  }

  const prev = currentSamples[detail.segIndex - 1];
  const next = currentSamples[detail.segIndex];
  const dt = Math.max((next.timeMs - prev.timeMs) / 1000, 0.001);
  const horizontalM = haversineMeters(prev.lat, prev.lon, next.lat, next.lon);
  const speedKmh = (horizontalM / dt) * 3.6;

  const tMs = prev.timeMs + (next.timeMs - prev.timeMs) * detail.segT;
  const climbRateMs = computeWindowedClimbRateMs(tMs, detail.segIndex, 8000);
  const elapsedSec = Math.max((tMs - currentSamples[0].timeMs) / 1000, 0);

  return { speedKmh, climbRateMs, progress: playbackProgress, elapsedSec };
}

/**
 * higher precision for climbing rates during replay, 8 seconds
 **/
function computeWindowedClimbRateMs(centerTimeMs, segIndex, windowMs) {
  if (currentSamples.length < 2) {
    return 0;
  }

  const halfWindowMs = Math.max(windowMs, 1000) / 2;
  let left = Math.max(0, segIndex - 1);
  let right = Math.min(currentSamples.length - 1, segIndex);

  while (left > 0 && centerTimeMs-currentSamples[left].timeMs < halfWindowMs) {
    left -= 1;
  }
  while (
    right < currentSamples.length - 1 &&
    currentSamples[right].timeMs-centerTimeMs < halfWindowMs
  ) {
    right += 1;
  }

  if (right <= left) {
    right = Math.min(left + 1, currentSamples.length - 1);
  }

  const dtSec = (currentSamples[right].timeMs - currentSamples[left].timeMs) / 1000;
  if (dtSec <= 0) {
    return 0;
  }

  return (currentSamples[right].altM - currentSamples[left].altM) / dtSec;
}

// ---------------------------------------------------------------------------
// Optional bottom panel: altitude (MSL) + ground profile chart, WeGlide-style.
// Drawn with the 2D canvas API; the static chart is rendered into an
// offscreen canvas once per flight/resize and blitted on every replay tick
// with the moving marker line overlayed.
// ---------------------------------------------------------------------------

function setProfileVisible(visible) {
  profileVisible = visible;
  profilePanel.hidden = !visible;
  profileToggleBtn.classList.toggle("active", visible);
  profileToggleBtn.setAttribute("aria-pressed", String(visible));
  try {
    localStorage.setItem(PROFILE_PANEL_STORAGE_KEY, visible ? "1" : "0");
  } catch {
    // localStorage may be unavailable (privacy mode); the toggle still works.
  }
  if (visible) {
    drawProfileChart();
    const detail = latestPlaybackDetail;
    updateProfileReplay(detail, detail ? computePlaybackStats(detail) : null);
  }
}

// Clear per-flight profile state and redraw with what is available right
// away (altitude line + thermal markers); the ground profile follows later,
// once the terrain elevation tiles have loaded.
function resetProfileForFlight() {
  profileGroundM = [];
  profileGroundAvailable = false;
  profileGroundAttempts = 0;
  computeProfileThermals();
  drawProfileChart();
  if (profileVisible) {
    const detail = latestPlaybackDetail;
    updateProfileReplay(detail, detail ? computePlaybackStats(detail) : null);
  }
}

// The ground profile is sampled once the map is idle after the flight
// rendered (that is when the terrain elevation tiles of the flight area are
// loaded); while the map is still moving, wait for the next idle.
function scheduleGroundProfileComputation() {
  map.once("idle", () => {
    if (map.isMoving()) {
      scheduleGroundProfileComputation();
      return;
    }
    computeGroundProfile();
  });
}

function profileDisplayDetail() {
  if (profileHoverTimeMs !== null) {
    const idx = sampleIndexAtTimeMs(profileHoverTimeMs);
    if (totalDistanceM > 0) {
      const progress = clamp(cumulativeDistances[idx] / totalDistanceM, 0, 1);
      return interpolatePathDetailed(currentPath, cumulativeDistances, totalDistanceM, progress);
    }
  }
  return latestPlaybackDetail;
}

function sampleIndexAtTimeMs(tMs) {
  if (!currentSamples.length) {
    return 0;
  }
  let lo = 0;
  let hi = currentSamples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (currentSamples[mid].timeMs < tMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function computeGroundProfile() {
  if (currentSamples.length < 2) {
    return;
  }

  const elevations = currentSamples.map((s) => {
    const elevation = map.queryTerrainElevation([s.lon, s.lat]);
    return typeof elevation === "number" && Number.isFinite(elevation) ? elevation : null;
  });

  const knownCount = elevations.filter((e) => e !== null).length;
  // Degrade gracefully: when the terrain data is (mostly) unavailable, show
  // the altitude line without the ground profile — but retry on later idle
  // events first, since the DEM tiles may still be loading.
  if (knownCount < elevations.length * 0.5) {
    profileGroundM = [];
    profileGroundAvailable = false;
    profileGroundAttempts += 1;
    if (profileGroundAttempts < PROFILE_GROUND_MAX_ATTEMPTS) {
      scheduleGroundProfileComputation();
    }
    return;
  }

  fillMissingElevations(elevations);
  profileGroundM = elevations;
  profileGroundAvailable = true;

  drawProfileChart();
  drawProfileMarker(currentProfileTimeMs());
}

// Linearly interpolate elevation gaps between known samples so the ground
// profile polygon has no holes.
function fillMissingElevations(elevations) {
  let i = 0;
  while (i < elevations.length) {
    if (elevations[i] !== null) {
      i += 1;
      continue;
    }
    const gapStart = i;
    while (i < elevations.length && elevations[i] === null) {
      i += 1;
    }
    const prevIdx = gapStart - 1;
    const nextIdx = i;
    const prevVal = prevIdx >= 0 ? elevations[prevIdx] : (nextIdx < elevations.length ? elevations[nextIdx] : null);
    const nextVal = nextIdx < elevations.length ? elevations[nextIdx] : prevVal;
    if (prevVal === null || nextVal === null) {
      continue;
    }
    const span = Math.max(nextIdx - prevIdx, 1);
    for (let j = gapStart; j < nextIdx; j++) {
      elevations[j] = lerp(prevVal, nextVal, (j - prevIdx) / span);
    }
  }
}

// Thermal segments: runs of samples whose windowed climb rate (the same
// smoothing the replay climb display uses) stays above a sustained threshold.
function computeProfileThermals() {
  profileThermals = [];
  if (currentSamples.length < 3) {
    return;
  }

  const climbing = currentSamples.map((s, i) =>
    i > 0 &&
    i < currentSamples.length - 1 &&
    computeWindowedClimbRateMs(s.timeMs, i, PROFILE_CLIMB_WINDOW_MS) > PROFILE_THERMAL_CLIMB_THRESHOLD_MS
  );

  let startIdx = -1;
  const runs = [];
  for (let i = 0; i <= climbing.length; i++) {
    const isClimbing = i < climbing.length && climbing[i];
    if (isClimbing && startIdx < 0) {
      startIdx = i;
    } else if (!isClimbing && startIdx >= 0) {
      runs.push({ startIdx, endIdx: i - 1 });
      startIdx = -1;
    }
  }

  // Merge runs separated by short gaps: lift that only dips below the
  // threshold briefly is one thermal, not several.
  const MERGE_GAP_MS = 90000;
  for (const run of runs) {
    const last = profileThermals[profileThermals.length - 1];
    const gapMs = last ? currentSamples[run.startIdx].timeMs - currentSamples[last.endIdx].timeMs : Infinity;
    if (last && gapMs < MERGE_GAP_MS) {
      last.endIdx = run.endIdx;
    } else {
      profileThermals.push({ ...run });
    }
  }

  // Only keep climbs that are sustained for a meaningful duration.
  profileThermals = profileThermals.filter(
    (th) => currentSamples[th.endIdx].timeMs - currentSamples[th.startIdx].timeMs >= PROFILE_THERMAL_MIN_DURATION_MS
  );
}

function drawProfileChart() {
  if (!profileVisible) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssW = profileCanvas.clientWidth;
  const cssH = profileCanvas.clientHeight;
  if (cssW < 40 || cssH < 40) {
    return;
  }
  profileCanvas.width = Math.round(cssW * dpr);
  profileCanvas.height = Math.round(cssH * dpr);

  profileStaticCanvas = document.createElement("canvas");
  profileStaticCanvas.width = profileCanvas.width;
  profileStaticCanvas.height = profileCanvas.height;
  const ctx = profileStaticCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  profileChartGeom = null;

  if (currentSamples.length < 2) {
    return;
  }

  const { left, right, top, bottom } = PROFILE_CHART_MARGIN;
  const plotW = cssW - left - right;
  const plotH = cssH - top - bottom;
  if (plotW < 40 || plotH < 40) {
    return;
  }

  const t0 = currentSamples[0].timeMs;
  const t1 = currentSamples[currentSamples.length - 1].timeMs;
  if (!(t1 > t0)) {
    return;
  }

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const s of currentSamples) {
    if (s.altM < dataMin) {
      dataMin = s.altM;
    }
    if (s.altM > dataMax) {
      dataMax = s.altM;
    }
  }
  if (profileGroundAvailable) {
    for (const g of profileGroundM) {
      if (g !== null && g < dataMin) {
        dataMin = g;
      }
    }
  }

  const pad = (dataMax - dataMin) * 0.08 || 50;
  const yStep = niceStep(dataMax - dataMin + 2 * pad, 5);
  // Anchor the axis bottom at the step containing the data minimum (not
  // below it): avoids a band of dead space under low-lying terrain.
  const yMin = Math.floor(dataMin / yStep) * yStep;
  const yMax = Math.ceil((dataMax + pad) / yStep) * yStep;

  // Display-unit conversion: the chart data stays in metres; the y-axis
  // labels are shown in the selected altitude unit (metres or feet).
  const altFactor = altitudeUnit() === "ft" ? M_TO_FT : 1;
  const altSuffix = altitudeUnit() === "ft" ? " ft" : " m";

  const xOf = (tMs) => left + ((tMs - t0) / (t1 - t0)) * plotW;
  const yOf = (alt) => top + (1 - (alt - yMin) / (yMax - yMin)) * plotH;

  profileChartGeom = { t0, t1, left, top, plotW, plotH };
  const colors = PROFILE_CHART_COLORS;

  // Horizontal grid + altitude axis labels.
  ctx.font = "10px sans-serif";
  ctx.lineWidth = 1;
  const yTickCount = Math.round((yMax - yMin) / yStep);
  for (let i = 0; i <= yTickCount; i++) {
    const alt = yMin + i * yStep;
    const y = Math.round(yOf(alt)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = colors.label;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText((alt * altFactor).toLocaleString("en-US") + altSuffix, left - 6, y);
  }

  // Time axis (HH:MM), ticks aligned to whole multiples of the step.
  const durationMin = (t1 - t0) / 60000;
  const minuteSteps = [5, 10, 15, 30, 60, 120, 240, 480];
  let tickMin = minuteSteps[minuteSteps.length - 1];
  for (const candidate of minuteSteps) {
    if (durationMin / candidate <= 8) {
      tickMin = candidate;
      break;
    }
  }
  const tickMs = tickMin * 60000;
  for (let t = Math.ceil(t0 / tickMs) * tickMs; t <= t1; t += tickMs) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + plotH);
    ctx.stroke();
    ctx.fillStyle = colors.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(formatHHMM(t), x, top + plotH + 4);
  }

  // Thermal markers: vertical magenta lines at the start of each climb
  // (like WeGlide's climb markers).
  for (const thermal of profileThermals) {
    const xLine = Math.round(xOf(currentSamples[thermal.startIdx].timeMs)) + 0.5;
    ctx.strokeStyle = colors.thermal;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xLine, top);
    ctx.lineTo(xLine, top + plotH);
    ctx.stroke();
  }

  // Ground profile under the track (brown filled area).
  if (profileGroundAvailable) {
    ctx.beginPath();
    ctx.moveTo(xOf(t0), top + plotH);
    for (let i = 0; i < currentSamples.length; i++) {
      const ground = profileGroundM[i];
      if (ground === null) {
        continue;
      }
      ctx.lineTo(xOf(currentSamples[i].timeMs), yOf(ground));
    }
    ctx.lineTo(xOf(t1), top + plotH);
    ctx.closePath();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = colors.ground;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Altitude (MSL) line over time.
  ctx.beginPath();
  for (let i = 0; i < currentSamples.length; i++) {
    const x = xOf(currentSamples[i].timeMs);
    const y = yOf(currentSamples[i].altM);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = colors.altitudeLine;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.stroke();
}

const SPEED_UNIT_STORAGE_KEY = "flugbuech-speed-unit";

// Speed display unit: "kmh" (default) or "kn" (knots), persisted per
// browser. Applies to the replay stats and the profile panel; climb rates
// stay in m/s.
function speedUnit() {
  return speedUnitSelect?.value === "kn" ? "kn" : "kmh";
}

function formatSpeedKmh(speedKmh) {
  return speedUnit() === "kn"
    ? `${(speedKmh / 1.852).toFixed(1)} kn`
    : `${speedKmh.toFixed(1)} km/h`;
}

const ALT_UNIT_STORAGE_KEY = "flugbuech-altitude-unit";
const M_TO_FT = 3.28084;

// Altitude display unit: "m" (default) or "ft", persisted per browser.
// Applies to the info panel, the replay stats and the profile panel chart;
// the 3D track geometry stays in metres.
function altitudeUnit() {
  return altUnitSelect?.value === "ft" ? "ft" : "m";
}

function formatAltitudeM(altM) {
  return altitudeUnit() === "ft"
    ? `${Math.round(altM * M_TO_FT).toLocaleString("en-US")} ft`
    : `${Math.round(altM).toLocaleString("en-US")} m`;
}

function initializeAltUnit() {
  if (!altUnitSelect) {
    return;
  }
  const urlUnit = new URLSearchParams(window.location.search).get("altunit");
  if (urlUnit === "ft" || urlUnit === "m") {
    altUnitSelect.value = urlUnit;
  } else {
    try {
      const stored = localStorage.getItem(ALT_UNIT_STORAGE_KEY);
      if (stored === "ft" || stored === "m") {
        altUnitSelect.value = stored;
      }
    } catch {
      // localStorage may be unavailable; the default stays in effect.
    }
  }
  altUnitSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(ALT_UNIT_STORAGE_KEY, altUnitSelect.value);
    } catch {
      // Same as above: the select still applies for this session.
    }
    const detail = latestPlaybackDetail;
    if (detail) {
      const stats = computePlaybackStats(detail);
      updateReplayStats(stats);
      updateProfileReplay(detail, stats);
    }
    drawProfileChart();
  });
}

function initializeSpeedUnit() {
  if (!speedUnitSelect) {
    return;
  }
  try {
    const stored = localStorage.getItem(SPEED_UNIT_STORAGE_KEY);
    if (stored === "kn" || stored === "kmh") {
      speedUnitSelect.value = stored;
    }
  } catch {
    // localStorage may be unavailable; the default stays in effect.
  }
  speedUnitSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(SPEED_UNIT_STORAGE_KEY, speedUnitSelect.value);
    } catch {
      // Same as above: the select still applies for this session.
    }
    const detail = latestPlaybackDetail;
    if (detail) {
      const stats = computePlaybackStats(detail);
      updateReplayStats(stats);
      updateProfileReplay(detail, stats);
    }
  });
}

// Replay time of the marker line, interpolated like computePlaybackStats.
// While the pointer hovers over the profile, the hovered time wins.
function currentProfileTimeMs() {
  if (profileHoverTimeMs !== null) {
    return profileHoverTimeMs;
  }
  if (!currentSamples.length) {
    return null;
  }
  const detail = latestPlaybackDetail;
  if (!detail || detail.segIndex <= 0 || detail.segIndex >= currentSamples.length) {
    return currentSamples[0].timeMs;
  }
  const prev = currentSamples[detail.segIndex - 1];
  const next = currentSamples[detail.segIndex];
  return prev.timeMs + (next.timeMs - prev.timeMs) * detail.segT;
}

// Hovering over the profile: the marker line and the panel stats follow the
// pointer (the replay itself is untouched). On mouseleave they return to the
// replay position.
profileCanvas.addEventListener("mousemove", (event) => {
  if (!profileChartGeom || !profileVisible || currentSamples.length < 2) {
    return;
  }
  const rect = profileCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { left, plotW, t0, t1 } = profileChartGeom;
  const frac = clamp((x - left) / plotW, 0, 1);
  profileHoverTimeMs = t0 + frac * (t1 - t0);

  const detail = profileDisplayDetail();
  updateProfileReplay(detail, computePlaybackStats(detail));
});

profileCanvas.addEventListener("mouseleave", () => {
  if (profileHoverTimeMs === null) {
    return;
  }
  profileHoverTimeMs = null;
  const detail = profileDisplayDetail();
  updateProfileReplay(detail, computePlaybackStats(detail));
});

// Click on the altitude profile: seek the replay to the clicked time. Works
// while playing (playback continues from there) and while paused.
profileCanvas.addEventListener("click", (event) => {
  if (!profileChartGeom || !profileVisible || currentSamples.length < 2) {
    return;
  }
  const rect = profileCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const { left, plotW, t0, t1 } = profileChartGeom;
  const frac = clamp((x - left) / plotW, 0, 1);
  const tMs = t0 + frac * (t1 - t0);
  profileHoverTimeMs = tMs;

  // Sample whose time is closest to the clicked position (binary search).
  let lo = 0;
  let hi = currentSamples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (currentSamples[mid].timeMs < tMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const progress =
    totalDistanceM > 0
      ? clamp(cumulativeDistances[lo] / totalDistanceM, 0, 1)
      : 0;
  seekToProgress(progress);
});

/**
 * Jump the replay to the given distance progress (0..1). While playing,
 * playback continues from the new position; while paused, the view and the
 * profile marker line move there.
 */
function seekToProgress(progress) {
  if (!currentPath.length || !totalDistanceM) {
    return;
  }
  playbackProgress = clamp(progress, 0, 1);
  const detail = interpolatePathDetailed(
    currentPath,
    cumulativeDistances,
    totalDistanceM,
    playbackProgress,
  );
  latestPlaybackDetail = detail;

  if (isPlaying) {
    // Keep playing from the new position.
    playbackStartTs = performance.now() - playbackProgress * getPlaybackDurationMs();
  } else if (playBtn) {
    playBtn.textContent = playbackProgress >= 1 ? "Replay" : "Play";
  }

  renderDeckLayers(currentPath, markerFromDetail(detail), detail);
  const stats = computePlaybackStats(detail);
  updateReplayStats(stats);
  updateProfileReplay(detail, stats);
}

function drawProfileMarker(tMs) {
  if (!profileVisible || !profileChartGeom || !profileStaticCanvas || tMs === null) {
    return;
  }

  const ctx = profileCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, profileCanvas.width, profileCanvas.height);
  ctx.drawImage(profileStaticCanvas, 0, 0);

  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const geom = profileChartGeom;
  const x = geom.left + clamp((tMs - geom.t0) / (geom.t1 - geom.t0), 0, 1) * geom.plotW;
  ctx.strokeStyle = PROFILE_CHART_COLORS.marker;
  ctx.fillStyle = PROFILE_CHART_COLORS.marker;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, geom.top);
  ctx.lineTo(x, geom.top + geom.plotH);
  ctx.stroke();
  // Small cap triangle at the top, like WeGlide's replay cursor.
  ctx.beginPath();
  ctx.moveTo(x - 4, geom.top);
  ctx.lineTo(x + 4, geom.top);
  ctx.lineTo(x, geom.top + 6);
  ctx.closePath();
  ctx.fill();
}

// Stats row at the replay position: altitude MSL, height AGL (altitude minus
// ground elevation under that point), climb rate and speed.
function updateProfileReplay(detail, stats) {
  if (!profileVisible) {
    return;
  }

  const altMsl = sampleAltitudeAtDetail(detail);
  const groundM = groundElevationAtDetail(detail);
  profileAltMslEl.textContent = altMsl === null ? "–" : formatAltitudeM(altMsl);
  profileAglEl.textContent = altMsl === null || groundM === null ? "–" : formatAltitudeM(altMsl - groundM);
  profileClimbEl.textContent = stats ? formatClimbRate(stats.climbRateMs) : "–";
  profileSpeedEl.textContent = stats ? formatSpeedKmh(stats.speedKmh) : "–";

  drawProfileMarker(currentProfileTimeMs());
}

function sampleAltitudeAtDetail(detail) {
  if (!currentSamples.length) {
    return null;
  }
  if (!detail || detail.segIndex <= 0 || detail.segIndex >= currentSamples.length) {
    return currentSamples[0].altM;
  }
  const prev = currentSamples[detail.segIndex - 1];
  const next = currentSamples[detail.segIndex];
  return lerp(prev.altM, next.altM, detail.segT);
}

function groundElevationAtDetail(detail) {
  if (!profileGroundAvailable || !currentSamples.length) {
    return null;
  }
  if (!detail || detail.segIndex <= 0 || detail.segIndex >= currentSamples.length) {
    return profileGroundM[0];
  }
  const prev = profileGroundM[detail.segIndex - 1];
  const next = profileGroundM[detail.segIndex];
  if (prev === null || next === null) {
    return null;
  }
  return lerp(prev, next, detail.segT);
}

function niceStep(range, targetTicks) {
  const rough = Math.max(range / targetTicks, 1e-6);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const mantissa of [1, 2, 2.5, 5, 10]) {
    if (mantissa * pow >= rough) {
      return mantissa * pow;
    }
  }
  return 10 * pow;
}

function formatHHMM(tMs) {
  const d = new Date(tMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function updateReplayStats(stats) {
  const speedEl = document.getElementById("speedValue");
  const climbEl = document.getElementById("climbValue");
  const progressEl = document.getElementById("progressValue");
  const elapsedEl = document.getElementById("elapsedValue");
  if (!speedEl || !climbEl || !progressEl || !elapsedEl) {
    return;
  }

  speedEl.textContent = formatSpeedKmh(stats.speedKmh);
  climbEl.textContent = formatClimbRate(stats.climbRateMs);
  progressEl.textContent = `${(stats.progress * 100).toFixed(1)}%`;
  elapsedEl.textContent = formatDuration(stats.elapsedSec);
}

function formatClimbRate(climbRateMs) {
  const rateMs = Number(climbRateMs || 0);
  return `${rateMs.toFixed(1)} m/s`;
}

function distance3D(a, b) {
  const horizontal = haversineMeters(a[1], a[0], b[1], b[0]);
  const dz = (b[2] || 0) - (a[2] || 0);
  return Math.hypot(horizontal, dz);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const p1 = lat1 * toRad;
  const p2 = lat2 * toRad;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingDegrees(a, b) {
  const lon1 = a[0] * (Math.PI / 180);
  const lat1 = a[1] * (Math.PI / 180);
  const lon2 = b[0] * (Math.PI / 180);
  const lat2 = b[1] * (Math.PI / 180);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return (brng + 360) % 360;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function renderInfo(flight) {
  const headers = flight.headers || {};
  const pilot = headers["FPLTPILOT"] || headers["OPLTPILOT"] || "Unknown";
  const glider = headers["FGTYGLIDERTYPE"] || headers["OGTYGLIDERTYPE"]|| "Unknown";
  const start = formatDate(flight.startTime);
  const end = formatDate(flight.endTime);
  const maxRate = Number(flight.MaxClimb || 0);
  const maxAlt = flight.MaxAlt;

  info.innerHTML = `
    <div><span class="k">File:</span> <span class="v">${escapeHtml(flight.file)}</span></div>
    <div><span class="k">Pilot:</span> <span class="v">${escapeHtml(pilot)}</span></div>
    <div><span class="k">Glider:</span> <span class="v">${escapeHtml(glider)}</span></div>
    <div><span class="k">Start:</span> <span class="v">${escapeHtml(start)}</span></div>
    <div><span class="k">End:</span> <span class="v">${escapeHtml(end)}</span></div>
    <div><span class="k">Max Climb Rate:</span> <span class="v">${escapeHtml(formatClimbRate(maxRate))}</span></div>
    <div><span class="k">Max. altitude (MSL):</span> <span class="v">${escapeHtml(formatAltitudeM(maxAlt))}</span></div>
    <hr />
    <div><span class="k">Replay progress:</span> <span class="v" id="progressValue">0.0%</span></div>
    <div><span class="k">Replay elapsed:</span> <span class="v" id="elapsedValue">00:00:00</span></div>
    <div><span class="k">Speed:</span> <span class="v" id="speedValue">0.0 km/h</span></div>
    <div><span class="k">Climb rate:</span> <span class="v" id="climbValue">0.0 m/s</span></div>
  `;
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getPlaybackDurationMs() {
  const speed = Number(playbackSpeedSelect?.value || "1");
  const clampedSpeed = Math.max(0.1, speed);
  return BASE_PLAYBACK_DURATION_MS / clampedSpeed;
}

function isFollowCamEnabled() {
  return followCamToggle?.checked ?? false;
}

function formatDate(v) {
  if (!v) {
    return "N/A";
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    return "N/A";
  }
  return d.toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
