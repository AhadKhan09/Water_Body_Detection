/**
 * AquaSense — app.js
 * Frontend logic: Mapbox GL map, date pickers, API calls, tile rendering
 */

// ═══════════════════════════════
// Config
// ═══════════════════════════════
const API_BASE     = 'http://localhost:8000';

// ═══════════════════════════════
// DOM refs
// ═══════════════════════════════
const $ = id => document.getElementById(id);

const sidebar        = $('sidebar');
const sidebarToggle  = $('sidebarToggle');
const fetchBtn       = $('fetchBtn');
const downloadBtn    = $('downloadBtn');
const mapLoading     = $('mapLoading');
const loadingSub     = $('loadingSub');
const progressBar    = $('progressBar');
const statusPill     = $('statusPill');
const statusText     = $('statusText');
const coordsDisplay  = $('coordsDisplay');
const thresholdInput = $('threshold');
const thresholdVal   = $('thresholdVal');
const opacityInput   = $('opacity');
const opacityVal     = $('opacityVal');
const areaModeGrid   = $('areaModeGrid');
const startAreaBtn   = $('startAreaBtn');
const finishAreaBtn  = $('finishAreaBtn');
const clearAreaBtn   = $('clearAreaBtn');
const areaHint       = $('areaHint');
const mapEl          = $('map');

// ═══════════════════════════════
// State
// ═══════════════════════════════
let currentTileUrl = null;
let currentLayer   = null;
let sidebarOpen    = true;
let selectedAoiFeature = null;
let selectedBounds = null;
let drawMode = 'rectangle';
let drawingActive = false;
let anchorPoint = null;
let polygonPoints = [];
let freeformDrawing = false;
let lastDragPoint = null;
let draftFeature = null;

const AOI_SOURCE_ID       = 'aoi-source';
const AOI_FILL_ID         = 'aoi-fill';
const AOI_LINE_ID         = 'aoi-line';
const AOI_DRAFT_SOURCE_ID = 'aoi-draft-source';
const AOI_DRAFT_LINE_ID   = 'aoi-draft-line';
const AOI_DRAFT_FILL_ID   = 'aoi-draft-fill';

// ═══════════════════════════════
// Initialize Mapbox
// ═══════════════════════════════
mapboxgl.accessToken = MAPBOX_TOKEN;

const map = new mapboxgl.Map({
  container: 'map',
  style:     'mapbox://styles/mapbox/dark-v11',
  center:    [67.0, 30.0],   // Pakistan — good default for Sentinel-1 water analysis
  zoom:      5.5,
  pitch:     0,
  bearing:   0,
  antialias: true,
});

// Navigation controls
map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

// Coordinates display on mouse move
map.on('mousemove', e => {
  const { lng, lat } = e.lngLat;
  coordsDisplay.textContent =
    `${lat >= 0 ? 'N' : 'S'} ${Math.abs(lat).toFixed(5)}°  ${lng >= 0 ? 'E' : 'W'} ${Math.abs(lng).toFixed(5)}°`;
});

map.on('mouseleave', () => {
  coordsDisplay.textContent = 'Hover map for coordinates';
});

// ═══════════════════════════════
// Date Pickers (Flatpickr)
// ═══════════════════════════════
const today    = new Date();
const thirtyAgo = new Date(today); thirtyAgo.setDate(today.getDate() - 30);

const fmt = d => d.toISOString().slice(0, 10);

const fpStart = flatpickr('#startDate', {
  dateFormat: 'Y-m-d',
  defaultDate: fmt(thirtyAgo),
  maxDate: 'today',
  onChange: ([date]) => fpEnd.set('minDate', date),
});

const fpEnd = flatpickr('#endDate', {
  dateFormat: 'Y-m-d',
  defaultDate: fmt(today),
  maxDate: 'today',
  onChange: ([date]) => fpStart.set('maxDate', date),
});

// ═══════════════════════════════
// Preset date buttons
// ═══════════════════════════════
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const days = parseInt(btn.dataset.days, 10);
    const end  = new Date();
    const start = new Date(); start.setDate(end.getDate() - days);
    fpStart.setDate(fmt(start));
    fpEnd.setDate(fmt(end));
  });
});

// ═══════════════════════════════
// Slider listeners
// ═══════════════════════════════
thresholdInput.addEventListener('input', () => {
  const v = parseFloat(thresholdInput.value);
  thresholdVal.textContent = `${v > 0 ? '+' : ''}${v} dB`;
  // live update if layer exists
  if (currentTileUrl) updateTileOpacity();
});

opacityInput.addEventListener('input', () => {
  const v = parseInt(opacityInput.value, 10);
  opacityVal.textContent = `${v}%`;
  updateTileOpacity();
});

function updateTileOpacity() {
  const opacity = parseInt(opacityInput.value, 10) / 100;
  if (map.getLayer('sentinel-tiles')) {
    map.setPaintProperty('sentinel-tiles', 'raster-opacity', opacity);
  }
}

function normalizeBbox([lng1, lat1], [lng2, lat2]) {
  const minLng = Math.max(-180, Math.min(lng1, lng2));
  const maxLng = Math.min(180, Math.max(lng1, lng2));
  const minLat = Math.max(-85, Math.min(lat1, lat2));
  const maxLat = Math.min(85, Math.max(lat1, lat2));
  return [minLng, minLat, maxLng, maxLat];
}

function bboxToFeature(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [minLng, minLat],
        [maxLng, minLat],
        [maxLng, maxLat],
        [minLng, maxLat],
        [minLng, minLat],
      ]],
    },
  };
}

function clampPoint([lng, lat]) {
  const clampedLng = Math.max(-180, Math.min(180, lng));
  const clampedLat = Math.max(-85, Math.min(85, lat));
  return [clampedLng, clampedLat];
}

function closeRing(points) {
  if (!points.length) return [];
  const ring = points.map(clampPoint);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

function ringToFeature(points) {
  const ring = closeRing(points);
  if (ring.length < 4) return null;
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };
}

function featureBounds(feature) {
  const coords = feature.geometry.coordinates[0];
  const lngs = coords.map(p => p[0]);
  const lats = coords.map(p => p[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function validateBounds(bounds) {
  const width = Math.abs(bounds[2] - bounds[0]);
  const height = Math.abs(bounds[3] - bounds[1]);
  return width >= 0.02 && height >= 0.02;
}

function destinationPoint([lng, lat], bearingDeg, distanceMeters) {
  const radius = 6378137;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const angularDistance = distanceMeters / radius;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAd = Math.sin(angularDistance);
  const cosAd = Math.cos(angularDistance);

  const lat2 = Math.asin(sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * sinAd * cosLat1,
    cosAd - sinLat1 * Math.sin(lat2),
  );

  return clampPoint([lng2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
}

function circleToFeature(center, edgePoint, segments = 72) {
  const centerLngLat = new mapboxgl.LngLat(center[0], center[1]);
  const edgeLngLat = new mapboxgl.LngLat(edgePoint[0], edgePoint[1]);
  const radiusMeters = centerLngLat.distanceTo(edgeLngLat);
  if (!Number.isFinite(radiusMeters) || radiusMeters < 200) return null;

  const ring = [];
  for (let i = 0; i <= segments; i += 1) {
    const bearing = (i / segments) * 360;
    ring.push(destinationPoint(center, bearing, radiusMeters));
  }

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };
}

function ensureAoiLayers() {
  if (map.getSource(AOI_SOURCE_ID)) return;

  map.addSource(AOI_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: AOI_FILL_ID,
    type: 'fill',
    source: AOI_SOURCE_ID,
    paint: {
      'fill-color': '#00c8dc',
      'fill-opacity': 0.14,
    },
  });

  map.addLayer({
    id: AOI_LINE_ID,
    type: 'line',
    source: AOI_SOURCE_ID,
    paint: {
      'line-color': '#00c8dc',
      'line-width': 2,
      'line-opacity': 0.9,
    },
  });

  map.addSource(AOI_DRAFT_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: AOI_DRAFT_FILL_ID,
    type: 'fill',
    source: AOI_DRAFT_SOURCE_ID,
    paint: {
      'fill-color': '#4eb3ff',
      'fill-opacity': 0.1,
    },
  });

  map.addLayer({
    id: AOI_DRAFT_LINE_ID,
    type: 'line',
    source: AOI_DRAFT_SOURCE_ID,
    paint: {
      'line-color': '#4eb3ff',
      'line-width': 2,
      'line-dasharray': [2, 1],
      'line-opacity': 0.95,
    },
  });
}

function renderAoiOverlay() {
  if (!map.isStyleLoaded()) {
    map.once('load', renderAoiOverlay);
    return;
  }

  ensureAoiLayers();
  const selectedSource = map.getSource(AOI_SOURCE_ID);
  const draftSource = map.getSource(AOI_DRAFT_SOURCE_ID);
  if (!selectedSource || !draftSource) return;

  selectedSource.setData({
    type: 'FeatureCollection',
    features: selectedAoiFeature ? [selectedAoiFeature] : [],
  });

  draftSource.setData({
    type: 'FeatureCollection',
    features: draftFeature ? [draftFeature] : [],
  });
}

function updateAreaHint() {
  if (drawingActive) {
    if (drawMode === 'rectangle') {
      areaHint.textContent = anchorPoint ? 'Click opposite corner to finish rectangle.' : 'Click first corner to start rectangle.';
      return;
    }
    if (drawMode === 'circle') {
      areaHint.textContent = anchorPoint ? 'Click edge point to finish circle.' : 'Click center point to start circle.';
      return;
    }
    if (drawMode === 'polygon') {
      areaHint.textContent = 'Click to add vertices. Double-click or Finish to complete polygon.';
      return;
    }
    areaHint.textContent = 'Press and drag on map to draw freeform area, then release.';
    return;
  }

  if (!selectedAoiFeature) {
    areaHint.textContent = 'No area selected. Choose a mode and click Start.';
    return;
  }

  const [minLng, minLat, maxLng, maxLat] = selectedBounds;
  areaHint.textContent = `BBox: ${minLng.toFixed(2)}, ${minLat.toFixed(2)} -> ${maxLng.toFixed(2)}, ${maxLat.toFixed(2)}`;
}

function setModeButtons() {
  areaModeGrid.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === drawMode);
  });
}

function resetDrawingState() {
  anchorPoint = null;
  polygonPoints = [];
  freeformDrawing = false;
  lastDragPoint = null;
  draftFeature = null;
  renderAoiOverlay();
}

function stopAreaDrawing() {
  drawingActive = false;
  resetDrawingState();
  startAreaBtn.classList.remove('active');
  finishAreaBtn.disabled = true;
  mapEl.classList.remove('selecting-area');
  map.doubleClickZoom.enable();
  updateAreaHint();
}

function startAreaDrawing() {
  drawingActive = true;
  resetDrawingState();
  startAreaBtn.classList.add('active');
  finishAreaBtn.disabled = !(drawMode === 'polygon');
  mapEl.classList.add('selecting-area');
  map.doubleClickZoom.disable();
  updateAreaHint();
  showToast(`Drawing mode: ${drawMode}. Select area on map.`, 'info');
}

function applySelectedFeature(feature) {
  if (!feature) {
    showToast('Could not build area geometry. Try again.', 'error');
    return;
  }

  const bounds = featureBounds(feature);
  if (!validateBounds(bounds)) {
    showToast('Selected area is too small. Please choose a larger area.', 'error');
    return;
  }

  selectedAoiFeature = feature;
  selectedBounds = bounds;
  stopAreaDrawing();
  renderAoiOverlay();
  showToast('Study area selected successfully.', 'success');
}

function clearAreaSelection() {
  selectedAoiFeature = null;
  selectedBounds = null;
  if (drawingActive) stopAreaDrawing();
  draftFeature = null;
  updateAreaHint();
  renderAoiOverlay();
  showToast('Study area cleared.', 'info');
}

areaModeGrid.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    drawMode = btn.dataset.mode;
    setModeButtons();
    if (drawingActive) {
      startAreaDrawing();
    } else {
      updateAreaHint();
    }
  });
});

startAreaBtn.addEventListener('click', () => {
  if (drawingActive) {
    stopAreaDrawing();
    showToast('Drawing stopped.', 'info');
    return;
  }
  startAreaDrawing();
});

finishAreaBtn.addEventListener('click', () => {
  if (!drawingActive || drawMode !== 'polygon') return;
  const feature = ringToFeature(polygonPoints);
  if (!feature) {
    showToast('Add at least 3 points to complete polygon.', 'error');
    return;
  }
  applySelectedFeature(feature);
});

clearAreaBtn.addEventListener('click', clearAreaSelection);

// ═══════════════════════════════
// Sidebar toggle
// ═══════════════════════════════
sidebarToggle.addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('open', sidebarOpen);
  } else {
    sidebar.classList.toggle('collapsed', !sidebarOpen);
  }
  setTimeout(() => map.resize(), 300);
});

// ═══════════════════════════════
// Fullscreen
// ═══════════════════════════════
$('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
});

// ═══════════════════════════════
// Reset View
// ═══════════════════════════════
$('resetViewBtn').addEventListener('click', () => {
  map.flyTo({ center: [67.0, 30.0], zoom: 5.5, pitch: 0, bearing: 0, duration: 1200 });
});

// ═══════════════════════════════
// Toast Notifications
// ═══════════════════════════════
function showToast(message, type = 'info', duration = 4000) {
  const icons = { success: '✦', error: '✕', info: '◎' };
  const container = $('toastContainer');

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

// ═══════════════════════════════
// Status helpers
// ═══════════════════════════════
function setStatus(text, state = 'idle') {
  statusText.textContent = text;
  statusPill.className = `status-pill ${state}`;
}

// ═══════════════════════════════
// Loading overlay helpers
// ═══════════════════════════════
const loadingSteps = [
  'Authenticating with Earth Engine…',
  'Querying Sentinel-1 GRD archive…',
  'Filtering by orbit & polarization…',
  'Applying speckle filter…',
  'Computing water mask…',
  'Generating tile URL…',
  'Almost done…',
];

let loadingInterval = null;

function showLoading() {
  mapLoading.classList.add('active');
  fetchBtn.disabled = true;
  setStatus('Processing…', 'loading');

  let step = 0;
  progressBar.style.width = '0%';
  loadingSub.textContent = loadingSteps[0];

  loadingInterval = setInterval(() => {
    step = Math.min(step + 1, loadingSteps.length - 1);
    loadingSub.textContent = loadingSteps[step];
    const pct = Math.round((step / (loadingSteps.length - 1)) * 85);
    progressBar.style.width = `${pct}%`;
  }, 1400);
}

function hideLoading(success = true) {
  clearInterval(loadingInterval);
  progressBar.style.width = success ? '100%' : '0%';
  setTimeout(() => {
    mapLoading.classList.remove('active');
    fetchBtn.disabled = false;
    progressBar.style.width = '0%';
  }, 400);
  setStatus(success ? 'Layer Active' : 'Error', success ? 'idle' : 'error');
}

// ═══════════════════════════════
// Add / replace tile layer on map
// ═══════════════════════════════
function addSentinelLayer(tileUrl, opacity) {
  // Remove existing
  if (map.getLayer('sentinel-tiles'))  map.removeLayer('sentinel-tiles');
  if (map.getSource('sentinel-source')) map.removeSource('sentinel-source');

  map.addSource('sentinel-source', {
    type: 'raster',
    tiles: [tileUrl],
    tileSize: 256,
    attribution: 'Copernicus Sentinel-1 GRD via Google Earth Engine',
  });

  map.addLayer({
    id:   'sentinel-tiles',
    type: 'raster',
    source: 'sentinel-source',
    paint: {
      'raster-opacity':     opacity,
      'raster-fade-duration': 400,
    },
  });

  currentTileUrl = tileUrl;
  currentLayer   = 'sentinel-tiles';
}

// ═══════════════════════════════
// Update Stats Panel
// ═══════════════════════════════
function updateStats(data) {
  const animate = (el, val) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => {
      el.textContent = val;
      el.style.transition = 'opacity 0.4s, transform 0.4s';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    }, 80);
  };

  animate($('statImages'), data.image_count ?? '—');
  animate($('statArea'),   data.water_area_km2 != null ? `${data.water_area_km2} km²` : '—');
  animate($('statMin'),    data.backscatter_min != null ? `${data.backscatter_min}` : '—');
  animate($('statMax'),    data.backscatter_max != null ? `${data.backscatter_max}` : '—');
}

function buildAnalysisParams() {
  const startDate    = $('startDate').value;
  const endDate      = $('endDate').value;
  const polarization = $('polarization').value;
  const threshold    = parseFloat(thresholdInput.value);

  if (!startDate || !endDate) {
    showToast('Please select both start and end dates.', 'error');
    return null;
  }
  if (new Date(startDate) >= new Date(endDate)) {
    showToast('Start date must be before end date.', 'error');
    return null;
  }
  if (!selectedAoiFeature || !selectedBounds) {
    showToast('Please select an area on the map first.', 'error');
    return null;
  }

  return new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    polarization,
    threshold,
    bbox: selectedBounds.join(','),
    aoi_geojson: JSON.stringify(selectedAoiFeature.geometry),
  });
}

// ═══════════════════════════════
// Main Fetch Handler
// ═══════════════════════════════
fetchBtn.addEventListener('click', async () => {
  const opacity      = parseInt(opacityInput.value, 10) / 100;
  const params = buildAnalysisParams();
  if (!params) return;

  showLoading();

  try {
    const response = await fetch(`${API_BASE}/api/sentinel?${params}`, {
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.tile_url) throw new Error('No tile URL returned from server.');

    // Add to map
    addSentinelLayer(data.tile_url, opacity);

    // Fly to bounds if provided
    if (data.bounds) {
      map.fitBounds(data.bounds, { padding: 60, duration: 1200 });
    }

    // Update stats
    updateStats(data);

    hideLoading(true);
    showToast(`Analysis complete — ${data.image_count ?? '?'} images processed`, 'success');

  } catch (err) {
    console.error('[AquaSense] Fetch error:', err);
    hideLoading(false);
    showToast(`Error: ${err.message}`, 'error', 6000);
  }
});

downloadBtn.addEventListener('click', async () => {
  const params = buildAnalysisParams();
  if (!params) return;

  downloadBtn.disabled = true;
  setStatus('Exporting Shapefile…', 'loading');

  try {
    const response = await fetch(`${API_BASE}/api/sentinel/shapefile?${params}`, {
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(err.detail || `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const contentDisposition = response.headers.get('content-disposition') || '';
    const match = contentDisposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || 'water_bodies.zip';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast('Shapefile export complete.', 'success');
  } catch (err) {
    console.error('[AquaSense] Shapefile export error:', err);
    showToast(`Export failed: ${err.message}`, 'error', 6000);
  } finally {
    downloadBtn.disabled = false;
    setStatus(currentLayer ? 'Layer Active' : 'Ready', currentLayer ? 'idle' : 'idle');
  }
});

// ═══════════════════════════════
// Health check on load
// ═══════════════════════════════
async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      setStatus('Ready', 'idle');
    } else {
      setStatus('Backend Error', 'error');
      showToast('Backend is unreachable. Start the FastAPI server.', 'error', 8000);
    }
  } catch {
    setStatus('Offline', 'error');
    showToast('Cannot connect to backend (localhost:8000). Make sure the server is running.', 'error', 8000);
  }
}

// Run health check after a short delay
setTimeout(checkHealth, 1200);

// ═══════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    if (!fetchBtn.disabled) fetchBtn.click();
  }
  if (e.key === 'Escape') {
    if (drawingActive) {
      stopAreaDrawing();
      showToast('Area drawing cancelled.', 'info');
      return;
    }
    if (mapLoading.classList.contains('active')) {
      hideLoading(false);
      showToast('Analysis cancelled.', 'info');
    }
  }
});

// ═══════════════════════════════
// Map click info
// ═══════════════════════════════
map.on('click', e => {
  if (drawingActive) {
    const point = [e.lngLat.lng, e.lngLat.lat];

    if (drawMode === 'rectangle') {
      if (!anchorPoint) {
        anchorPoint = point;
        updateAreaHint();
        return;
      }
      applySelectedFeature(bboxToFeature(normalizeBbox(anchorPoint, point)));
      return;
    }

    if (drawMode === 'circle') {
      if (!anchorPoint) {
        anchorPoint = point;
        updateAreaHint();
        return;
      }
      applySelectedFeature(circleToFeature(anchorPoint, point));
      return;
    }

    if (drawMode === 'polygon') {
      polygonPoints.push(clampPoint(point));
      draftFeature = ringToFeature(polygonPoints);
      renderAoiOverlay();
      return;
    }

    return;
  }

  if (!currentLayer) return;
  const { lng, lat } = e.lngLat;
  new mapboxgl.Popup({
    closeButton: true,
    className: 'aq-popup',
    maxWidth: '240px',
  })
    .setLngLat([lng, lat])
    .setHTML(`
      <div style="font-family:'Space Mono',monospace;font-size:11px;color:#7a99aa;padding:4px 0 0;">
        <div style="color:#e2eaf0;font-family:'Syne',sans-serif;font-weight:700;margin-bottom:6px;">Location Info</div>
        <div>Lat: <span style="color:#00c8dc">${lat.toFixed(6)}°</span></div>
        <div>Lng: <span style="color:#00c8dc">${lng.toFixed(6)}°</span></div>
        <div style="margin-top:6px;font-size:10px;color:#445566;">Click Analyze to load SAR data</div>
      </div>
    `)
    .addTo(map);
});

map.on('dblclick', e => {
  if (!drawingActive || drawMode !== 'polygon') return;
  e.preventDefault();

  const point = [e.lngLat.lng, e.lngLat.lat];
  const last = polygonPoints[polygonPoints.length - 1];
  if (!last || Math.abs(last[0] - point[0]) > 1e-8 || Math.abs(last[1] - point[1]) > 1e-8) {
    polygonPoints.push(clampPoint(point));
  }

  const feature = ringToFeature(polygonPoints);
  if (!feature) {
    showToast('Add at least 3 points to complete polygon.', 'error');
    return;
  }
  applySelectedFeature(feature);
});

map.on('mousedown', e => {
  if (!drawingActive || drawMode !== 'freeform') return;
  freeformDrawing = true;
  const point = clampPoint([e.lngLat.lng, e.lngLat.lat]);
  polygonPoints = [point];
  lastDragPoint = e.point;
  draftFeature = ringToFeature(polygonPoints);
  renderAoiOverlay();
});

map.on('mousemove', e => {
  if (!drawingActive) return;

  const point = clampPoint([e.lngLat.lng, e.lngLat.lat]);
  if ((drawMode === 'rectangle' || drawMode === 'circle') && anchorPoint) {
    draftFeature = drawMode === 'rectangle'
      ? bboxToFeature(normalizeBbox(anchorPoint, point))
      : circleToFeature(anchorPoint, point);
    renderAoiOverlay();
    return;
  }

  if (drawMode === 'freeform' && freeformDrawing) {
    const dx = e.point.x - (lastDragPoint?.x ?? e.point.x);
    const dy = e.point.y - (lastDragPoint?.y ?? e.point.y);
    if (Math.sqrt(dx * dx + dy * dy) < 4) return;
    polygonPoints.push(point);
    lastDragPoint = e.point;
    draftFeature = ringToFeature(polygonPoints);
    renderAoiOverlay();
  }
});

map.on('mouseup', () => {
  if (!drawingActive || drawMode !== 'freeform' || !freeformDrawing) return;
  freeformDrawing = false;

  const feature = ringToFeature(polygonPoints);
  if (!feature) {
    showToast('Freeform area too small. Try drawing a larger shape.', 'error');
    resetDrawingState();
    updateAreaHint();
    return;
  }
  applySelectedFeature(feature);
});

// ═══════════════════════════════
// Popup styles injected
// ═══════════════════════════════
const popupStyle = document.createElement('style');
popupStyle.textContent = `
  .aq-popup .mapboxgl-popup-content {
    background: #0d1318;
    border: 1px solid rgba(0,200,220,0.25);
    border-radius: 10px;
    padding: 14px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .aq-popup .mapboxgl-popup-tip {
    border-top-color: #0d1318 !important;
  }
  .aq-popup .mapboxgl-popup-close-button {
    color: #7a99aa;
    font-size: 16px;
    right: 8px; top: 6px;
  }
`;
document.head.appendChild(popupStyle);

setModeButtons();
updateAreaHint();
