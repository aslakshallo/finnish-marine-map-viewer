
/* global L */

const INITIAL_CENTER = [60.135, 24.96];
const INITIAL_ZOOM = 11;

const map = L.map('map', {
  center: INITIAL_CENTER,
  zoom: INITIAL_ZOOM,
  zoomControl: true,
});

L.control.scale({ metric: true, imperial: false, position: 'bottomright' }).addTo(map);

// ---------------------------------------------------------------------------
// 1. Base Maps (Maanmittauslaitos via Kapsi WMS + OpenStreetMap)
// ---------------------------------------------------------------------------
const baseLayers = {
  'mml-tausta': L.tileLayer.wms('https://tiles.kartat.kapsi.fi/taustakartta', {
    layers: 'taustakartta',
    format: 'image/jpeg',
    version: '1.1.1',
    transparent: false,
    maxZoom: 18,
    attribution: '© Maanmittauslaitos (CC BY 4.0)',
  }),
  'mml-perus': L.tileLayer.wms('https://tiles.kartat.kapsi.fi/peruskartta', {
    layers: 'peruskartta',
    format: 'image/jpeg',
    version: '1.1.1',
    transparent: false,
    maxZoom: 18,
    attribution: '© Maanmittauslaitos (CC BY 4.0)',
  }),
  'mml-orto': L.tileLayer.wms('https://tiles.kartat.kapsi.fi/ortokuva', {
    layers: 'ortokuva',
    format: 'image/jpeg',
    version: '1.1.1',
    transparent: false,
    maxZoom: 18,
    attribution: '© Maanmittauslaitos (CC BY 4.0)',
  }),
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors (ODbL)',
  }),
};

let activeBaseKey = 'mml-tausta';

// ---------------------------------------------------------------------------
// 2. Government & Nautical WMS / WMTS Overlays
// ---------------------------------------------------------------------------
function makeTraficomWmts(layerName, opacity = 1.0) {
  const encoded = encodeURIComponent(layerName);
  return L.tileLayer(
    `https://julkinen.traficom.fi/rasteripalvelu/wmts?service=WMTS&request=GetTile&version=1.0.0&layer=${encoded}&style=&format=image/png&TileMatrixSet=WGS84_Pseudo-Mercator&TileMatrix=WGS84_Pseudo-Mercator:{z}&TileRow={y}&TileCol={x}`,
    {
      maxZoom: 18,
      opacity,
      attribution: '© Traficom (CC BY 4.0)',
    }
  );
}

const traficomChartLayers = {
  merikarttasarjat: makeTraficomWmts('Traficom:Merikarttasarjat public', 1.0),
  veneilykartat: makeTraficomWmts('Traficom:Veneilykartat public', 1.0),
  rannikkokartat: makeTraficomWmts('Traficom:Rannikkokartat public', 1.0),
  s57: L.tileLayer.wms('https://julkinen.traficom.fi/s57/wms', {
    layers: 'cells',
    format: 'image/png',
    transparent: true,
    version: '1.3.0',
    opacity: 1.0,
    attribution: '© Traficom S-57 (CC BY 4.0)',
  }),
};

let activeTraficomSeries = 'merikarttasarjat';
let activeTraficomLayer = traficomChartLayers[activeTraficomSeries];

/**
 * Synchronize base map visibility to ensure that when a full topmost chart
 * (e.g. Traficom Nautical Chart) is active, the underlying base map layer is
 * completely detached from Leaflet and does NOT load redundant tiles.
 */
function updateBaseMapVisibility() {
  const chartToggle = document.getElementById('toggleTraficomChart');
  const chartEnabled = chartToggle ? chartToggle.checked : false;
  const opacityVal = Number(document.getElementById('traficomOpacity')?.value ?? 100) / 100;
  // When nautical chart is enabled and opacity is at or near full (>= 90%),
  // it completely covers the map. In that state, loading the underlying base map
  // is pure waste of bandwidth and rendering resources.
  const chartCovering = chartEnabled && opacityVal >= 0.90;

  const baseStatusBadge = document.getElementById('baseMapStatusBadge');
  if (baseStatusBadge) {
    if (activeBaseKey === 'none') {
      baseStatusBadge.textContent = 'None';
      baseStatusBadge.className = 'count-pill status-pill';
      baseStatusBadge.style.display = 'inline-block';
    } else if (chartCovering) {
      baseStatusBadge.textContent = 'Paused (under chart)';
      baseStatusBadge.className = 'count-pill status-pill paused';
      baseStatusBadge.style.display = 'inline-block';
    } else {
      baseStatusBadge.style.display = 'none';
    }
  }

  // Remove any base layer that is not activeBaseKey
  for (const [key, layer] of Object.entries(baseLayers)) {
    if (key !== activeBaseKey && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }

  const activeLayer = baseLayers[activeBaseKey];
  if (!activeLayer || activeBaseKey === 'none' || chartCovering) {
    // When covered by topmost chart or set to none, detach from map so 0 tiles are requested
    if (activeLayer && map.hasLayer(activeLayer)) {
      map.removeLayer(activeLayer);
    }
  } else {
    // Chart is off or user explicitly lowered opacity < 90% for intentional blending
    if (!map.hasLayer(activeLayer)) {
      activeLayer.addTo(map);
      activeLayer.bringToBack();
    }
  }
}

// Initial display of active base map
updateBaseMapVisibility();

const traficomDepthWmsLayer = L.tileLayer.wms('https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wms', {
  layers: 'DepthArea_A,DepthContour_L,Sounding_P',
  format: 'image/png',
  transparent: true,
  version: '1.3.0',
  opacity: 0.8,
  attribution: '© Traficom depth data (CC BY 4.0)',
});

const VAYLA_SUBLAYERS = [
  { id: 'toggleVaylaFairwayAreas', layer: 'vesivaylatiedot:vaylaalueet_uusi' },
  { id: 'toggleVaylaSpeedLimits', layer: 'vesivaylatiedot:vesivaylien_nopeusrajoitusalueet' },
  { id: 'toggleVaylaRestrictions', layer: 'vesivaylatiedot:vesivaylien_muut_rajoitusalueet' },
  { id: 'toggleVaylaFairways', layer: 'vesivaylatiedot:vaylat_uusi' },
  { id: 'toggleVaylaNavLines', layer: 'vesivaylatiedot:navigointilinjat_uusi' },
  { id: 'toggleVaylaMarks', layer: 'vesivaylatiedot:turvalaitteet_uusi' },
  { id: 'toggleVaylaLights', layer: 'vesivaylatiedot:loistot_uusi' },
];

const vaylaLayer = L.tileLayer.wms('https://avoinapi.vaylapilvi.fi/vaylatiedot/ows', {
  layers: VAYLA_SUBLAYERS.map((s) => s.layer).join(','),
  format: 'image/png',
  transparent: true,
  version: '1.3.0',
  attribution: '© Väylävirasto (CC BY 4.0)',
});

const propertyLinesLayer = L.tileLayer.wms('https://tiles.kartat.kapsi.fi/kiinteistorajat', {
  layers: 'kiinteistorajat',
  format: 'image/png',
  transparent: true,
  version: '1.1.1',
  attribution: '© Maanmittauslaitos (CC BY 4.0)',
});

const openSeaMapLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  maxZoom: 18,
  opacity: 0.9,
  attribution: '© OpenSeaMap contributors (CC BY-SA 2.0)',
});

const traficomWarningsWms = L.tileLayer.wms('https://julkinen.traficom.fi/inspirepalvelu/avoin/wms', {
  layers: 'navigational_warnings',
  format: 'image/png',
  transparent: true,
  version: '1.3.0',
  attribution: '© Traficom (CC BY 4.0)',
});

// ---------------------------------------------------------------------------
// 3. Vector / Live Point Layer Groups
// ---------------------------------------------------------------------------
const depthCanvas = L.canvas({ padding: 0.4 });
const depthAreaLayer = L.layerGroup().addTo(map);
const depthContourLayer = L.layerGroup().addTo(map);
const depthSoundingLayer = L.layerGroup().addTo(map);
const aisLayer = L.layerGroup();
const warningsLayer = L.layerGroup();
const mareographLayer = L.layerGroup();
const fmiLayer = L.layerGroup();
const septitLayer = L.layerGroup();
const lipasHarbourLayer = L.layerGroup();
const lipasShelterLayer = L.layerGroup();
const lipasHutLayer = L.layerGroup();
const lipasCampfireLayer = L.layerGroup();
const osmLayer = L.layerGroup();
const routeSearchRenderer = L.canvas({ padding: 0.5 });
const routeSearchLayer = L.layerGroup().addTo(map);
const routeAlternativesLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const routeMarksLayer = L.layerGroup().addTo(map);
const routeEndpointsLayer = L.layerGroup().addTo(map);

let cachedAisGeoJson = null;
let cachedMareographs = [];
let nearestMareographItem = null;
let cachedDepthData = null;
let currentDepthThreshold = 3.0;

// ---------------------------------------------------------------------------
// 4. Utilities
// ---------------------------------------------------------------------------
function escapeHtml(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDdm(deg, posHem, negHem) {
  const hem = deg >= 0 ? posHem : negHem;
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = ((abs - d) * 60).toFixed(3).padStart(6, '0');
  return `${d}° ${m}' ${hem}`;
}

function compassDir(deg) {
  if (deg === null || deg === undefined || Number.isNaN(Number(deg))) return '--';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((Number(deg) % 360) + 360) % 360) / 22.5) % 16];
}

function setCountBadge(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function popupRow(key, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span>`;
}

function makePoiIcon(cls, glyph) {
  return L.divIcon({
    className: 'poi-icon-wrap',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
    html: `<div class="poi-marker ${cls}">${glyph}</div>`,
  });
}

// ---------------------------------------------------------------------------
// 5. Fetch & Render: Fintraffic AIS Vessel Traffic
// ---------------------------------------------------------------------------
const NAV_STAT_LABELS = {
  0: 'Under way (engine)',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Engaged in fishing',
  8: 'Under way sailing',
  15: 'Undefined',
};

function makeVesselIcon(headingDeg, sog) {
  const rot = headingDeg ?? 0;
  const moving = sog !== null && sog >= 0.5;
  const fill = moving ? '#0d6e8a' : '#6b7280';
  return L.divIcon({
    className: 'ais-icon-wrap',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -11],
    html: `<svg viewBox="0 0 24 24" width="22" height="22" style="transform: rotate(${rot}deg); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));">
      <path d="M12 2L18 19L12 15.5L6 19L12 2Z" fill="${fill}" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`,
  });
}

function renderAisViewport() {
  aisLayer.clearLayers();
  if (!cachedAisGeoJson || !document.getElementById('toggleAis').checked) return;

  const bounds = map.getBounds().pad(0.25);
  const allFeatures = cachedAisGeoJson.features || [];
  let visibleCount = 0;

  for (const f of allFeatures) {
    const [lon, lat] = f.geometry.coordinates;
    if (!bounds.contains([lat, lon])) continue;
    if (visibleCount >= 450) break;

    visibleCount++;
    const p = f.properties;
    const dir = p.heading ?? p.cog ?? 0;
    const marker = L.marker([lat, lon], { icon: makeVesselIcon(dir, p.sog) });

    const speedText = p.sog !== null ? `${p.sog} kn` : '--';
    const courseText = p.cog !== null ? `${Math.round(p.cog)}°` : '--';
    const headingText = p.heading !== null ? `${p.heading}°` : '--';
    const navText = NAV_STAT_LABELS[p.navStat] || (p.navStat != null ? `Code ${p.navStat}` : null);
    const updated = p.timestampExternal ? new Date(p.timestampExternal).toLocaleTimeString('fi-FI') : null;

    marker.bindPopup(
      `<div class="popup-card">
        <div class="popup-kicker">Fintraffic AIS Vessel</div>
        <h4 class="popup-title">${escapeHtml(p.name)}</h4>
        <div class="popup-grid">
          ${popupRow('MMSI', p.mmsi)}
          ${popupRow('Call Sign', p.callSign)}
          ${popupRow('Speed (SOG)', speedText)}
          ${popupRow('Course (COG)', courseText)}
          ${popupRow('Heading', headingText)}
          ${popupRow('Destination', p.destination)}
          ${popupRow('Draught', p.draught ? `${p.draught} m` : null)}
          ${popupRow('Status', navText)}
          ${popupRow('Updated', updated)}
        </div>
      </div>`
    );
    aisLayer.addLayer(marker);
  }

  setCountBadge('countAis', allFeatures.length);
}

async function loadAis() {
  try {
    const res = await fetch('/api/ais');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedAisGeoJson = await res.json();
    setCountBadge('countAis', (cachedAisGeoJson.features || []).length);
    renderAisViewport();
  } catch (err) {
    console.error('AIS load error:', err);
    setCountBadge('countAis', 'err');
  }
}

// ---------------------------------------------------------------------------
// 6. Fetch & Render: Ilmatieteen laitos (FMI) Weather Stations
// ---------------------------------------------------------------------------
async function loadFmi() {
  try {
    const res = await fetch('/api/fmi');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    fmiLayer.clearLayers();

    const features = data.features || [];
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties;
      const tempLabel = p.t2m !== null ? `${p.t2m.toFixed(1)}°` : '--';
      const windLabel = p.ws !== null ? `${p.ws.toFixed(1)}m/s` : '';

      const icon = L.divIcon({
        className: 'fmi-icon-wrap',
        iconSize: [84, 22],
        iconAnchor: [42, 11],
        popupAnchor: [0, -11],
        html: `<div class="fmi-badge">${escapeHtml(tempLabel)}${windLabel ? `<span class="wind-chip">${escapeHtml(windLabel)} ${compassDir(p.wd)}</span>` : ''
          }</div>`,
      });

      const marker = L.marker([lat, lon], { icon });
      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">Ilmatieteen laitos (FMI)</div>
          <h4 class="popup-title">${escapeHtml(p.name)}</h4>
          <div class="popup-grid">
            ${popupRow('Air Temp', p.t2m !== null ? `${p.t2m.toFixed(1)} °C` : null)}
            ${popupRow('Wind (10 min)', p.ws !== null ? `${p.ws.toFixed(1)} m/s (${compassDir(p.wd)})` : null)}
            ${popupRow('Wind Gust', p.wg !== null ? `${p.wg.toFixed(1)} m/s` : null)}
            ${popupRow('Wind Dir', p.wd !== null ? `${Math.round(p.wd)}°` : null)}
            ${popupRow('Sea Pressure', p.pressure !== null ? `${p.pressure.toFixed(1)} hPa` : null)}
            ${popupRow('Observed', new Date(p.timestamp).toLocaleTimeString('fi-FI'))}
          </div>
        </div>`
      );
      fmiLayer.addLayer(marker);
    }
    setCountBadge('countFmi', features.length);
  } catch (err) {
    console.error('FMI load error:', err);
    setCountBadge('countFmi', 'err');
  }
}

// ---------------------------------------------------------------------------
// 6b. Fetch & Render: Digitraffic Nautical Warnings (ATON Faults)
// ---------------------------------------------------------------------------
async function loadWarnings() {
  try {
    const res = await fetch('/api/warnings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    warningsLayer.clearLayers();

    const icon = makePoiIcon('poi-warning', '⚠');
    const features = data.features || [];

    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const marker = L.marker([lat, lon], { icon });
      const reportedDate = p.timestamp ? new Date(p.timestamp).toLocaleDateString('fi-FI') : null;

      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">Digitraffic Nautical Warning (ATON)</div>
          <h4 class="popup-title">${escapeHtml(p.name)}</h4>
          <div class="popup-grid">
            ${popupRow('Fault Type', p.type)}
            ${popupRow('State', p.state)}
            ${popupRow('Seamark Type', p.atonType)}
            ${popupRow('Fairway', p.fairway)}
            ${popupRow('Sea Area', p.area)}
            ${popupRow('Reported', reportedDate)}
          </div>
        </div>`
      );
      warningsLayer.addLayer(marker);
    }
    setCountBadge('countWarnings', features.length);
  } catch (err) {
    console.error('Warnings load error:', err);
    setCountBadge('countWarnings', 'err');
  }
}

// ---------------------------------------------------------------------------
// 6c. Fetch & Render: FMI Mareograph Sea Level Gauges
// ---------------------------------------------------------------------------
function formatSignedCm(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '--';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(1)} cm`;
}

function updateNearestMareographPill() {
  const el = document.getElementById('seaLevelSummary');
  if (!el || cachedMareographs.length === 0) return;

  const center = map.getCenter();
  let best = null;
  let bestDist = Infinity;

  for (const item of cachedMareographs) {
    const dist = center.distanceTo([item.lat, item.lon]);
    if (dist < bestDist) {
      bestDist = dist;
      best = item;
    }
  }

  nearestMareographItem = best;
  if (!best) return;

  const shortName = best.name.split(' ')[0];
  const mw = formatSignedCm(best.watlevCm);
  const n2k = best.n2000Cm !== null ? ` (${formatSignedCm(best.n2000Cm)} N2000)` : '';
  el.textContent = `Sea: ${mw} MW${n2k} · ${shortName}`;
  if (typeof updateRouteSafeDepthBadge === 'function') {
    updateRouteSafeDepthBadge();
  }
}

async function loadMareographs() {
  try {
    const res = await fetch('/api/mareograph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    mareographLayer.clearLayers();
    cachedMareographs = [];

    const features = data.features || [];
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const levelText = formatSignedCm(p.watlevCm);
      const waterTempText = p.waterTemp !== null ? `${p.waterTemp.toFixed(1)}°C` : '';

      const icon = L.divIcon({
        className: 'fmi-icon-wrap',
        iconSize: [96, 22],
        iconAnchor: [48, 11],
        popupAnchor: [0, -11],
        html: `<div class="mareo-badge">${escapeHtml(levelText)}${waterTempText ? `<span class="temp-chip">${escapeHtml(waterTempText)}</span>` : ''
          }</div>`,
      });

      const marker = L.marker([lat, lon], { icon });
      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">FMI Mareograph (Sea Level)</div>
          <h4 class="popup-title">${escapeHtml(p.name)}</h4>
          <div class="popup-grid">
            ${popupRow('Sea Level (MW)', formatSignedCm(p.watlevCm))}
            ${popupRow('Sea Level (N2000)', formatSignedCm(p.n2000Cm))}
            ${popupRow('Water Temp', p.waterTemp !== null ? `${p.waterTemp.toFixed(1)} °C` : null)}
            ${popupRow('Observed', new Date(p.timestamp).toLocaleTimeString('fi-FI'))}
          </div>
        </div>`
      );
      mareographLayer.addLayer(marker);
      cachedMareographs.push({
        name: p.name,
        lat,
        lon,
        watlevCm: p.watlevCm,
        n2000Cm: p.n2000Cm,
        marker,
      });
    }

    setCountBadge('countMareograph', features.length);
    updateNearestMareographPill();
  } catch (err) {
    console.error('Mareograph load error:', err);
    setCountBadge('countMareograph', 'err');
    const el = document.getElementById('seaLevelSummary');
    if (el) el.textContent = 'Sea Level unavailable';
  }
}

// ---------------------------------------------------------------------------
// 7. Fetch & Render: Septit.net Pump-Out Stations
// ---------------------------------------------------------------------------
async function loadSeptit() {
  try {
    const res = await fetch('/api/septit');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    septitLayer.clearLayers();

    const icon = makePoiIcon('poi-septit', 'S');
    const features = data.features || [];

    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const marker = L.marker([lat, lon], { icon });
      const stationUrl = p.url || (p.septicId ? `https://septit.net/${p.septicId}` : 'https://septit.net');
      const statusText = p.temporarilyClosed ? 'Temporarily closed' : 'Operational (check Septit.net)';

      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">Septit.net Pump-out Station</div>
          <h4 class="popup-title">${escapeHtml(p.stationName || 'Pump-out station')}</h4>
          <div class="popup-grid">
            ${popupRow('Status', statusText)}
            ${popupRow('Details', p.stationDescription)}
            ${popupRow('Station ID', p.septicId)}
          </div>
          <a class="popup-link" href="${escapeHtml(stationUrl)}" target="_blank" rel="noopener">Open on septit.net &rarr;</a>
        </div>`
      );
      septitLayer.addLayer(marker);
    }
    setCountBadge('countSeptit', features.length);
  } catch (err) {
    console.error('Septit load error:', err);
    setCountBadge('countSeptit', 'err');
  }
}

// ---------------------------------------------------------------------------
// 8. Fetch & Render: Lipas (JYU) & Turku Harbours / Shelters / Huts / Campfires
// ---------------------------------------------------------------------------
async function loadLipas() {
  try {
    const res = await fetch('/api/lipas');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    lipasHarbourLayer.clearLayers();
    lipasShelterLayer.clearLayers();
    lipasHutLayer.clearLayers();
    lipasCampfireLayer.clearLayers();

    const icons = {
      harbour: makePoiIcon('poi-harbour', '⚓'),
      shelter: makePoiIcon('poi-shelter', '⌂'),
      hut: makePoiIcon('poi-hut', '⛺'),
      campfire: makePoiIcon('poi-campfire', '🔥'),
    };

    const labels = {
      harbour: 'Harbour / Boating Service',
      shelter: 'Shelter / Lean-to (Laavu / Kota)',
      hut: 'Wilderness / Day Hut (Tupa)',
      campfire: 'Campfire Site (Tulipaikka)',
    };

    const counts = { harbour: 0, shelter: 0, hut: 0, campfire: 0 };

    for (const f of data.features || []) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const cat = p.category;
      if (!counts.hasOwnProperty(cat)) continue;
      counts[cat]++;

      const marker = L.marker([lat, lon], { icon: icons[cat] });
      const wwwHtml = p.www
        ? `<a class="popup-link" href="${escapeHtml(p.www)}" target="_blank" rel="noopener">Website &rarr;</a>`
        : '';

      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">${escapeHtml(p.source || 'Lipas (JYU)')}</div>
          <h4 class="popup-title">${escapeHtml(p.name)}</h4>
          <div class="popup-grid">
            ${popupRow('Category', labels[cat])}
            ${popupRow('City / Area', p.city)}
            ${popupRow('Address', p.address)}
            ${popupRow('Notes', p.comment)}
          </div>
          ${wwwHtml}
        </div>`
      );

      if (cat === 'harbour') lipasHarbourLayer.addLayer(marker);
      else if (cat === 'shelter') lipasShelterLayer.addLayer(marker);
      else if (cat === 'hut') lipasHutLayer.addLayer(marker);
      else if (cat === 'campfire') lipasCampfireLayer.addLayer(marker);
    }

    setCountBadge('countHarbour', counts.harbour);
    setCountBadge('countShelter', counts.shelter);
    setCountBadge('countHut', counts.hut);
    setCountBadge('countCampfire', counts.campfire);
  } catch (err) {
    console.error('Lipas load error:', err);
    setCountBadge('countHarbour', 'err');
  }
}

// ---------------------------------------------------------------------------
// 9. Fetch & Render: OpenStreetMap Boating POIs (Overpass via /api/osm)
// ---------------------------------------------------------------------------
let osmTimer = null;

function scheduleOsmLoad() {
  clearTimeout(osmTimer);
  osmTimer = setTimeout(loadOsmInView, 500);
}

async function loadOsmInView() {
  const toggle = document.getElementById('toggleOsm');
  const hint = document.getElementById('osmHint');
  if (!toggle.checked) return;

  if (map.getZoom() < 9) {
    hint.textContent = 'Zoom in (z ≥ 9) to fetch OSM boating POIs in view.';
    setCountBadge('countOsm', 'z<9');
    return;
  }

  hint.textContent = 'Loading OpenStreetMap ramps, marinas & services...';
  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`;

  try {
    const res = await fetch(`/api/osm?bbox=${encodeURIComponent(bbox)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    osmLayer.clearLayers();

    const icons = {
      ramp: makePoiIcon('poi-osm-ramp', 'R'),
      marina: makePoiIcon('poi-osm-marina', 'M'),
      service: makePoiIcon('poi-osm-service', 'F'),
    };

    const features = data.features || [];
    for (const f of features) {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const marker = L.marker([lat, lon], { icon: icons[p.category] || icons.service });
      const osmLink = `https://www.openstreetmap.org/${p.id}`;

      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">OpenStreetMap (ODbL)</div>
          <h4 class="popup-title">${escapeHtml(p.name)}</h4>
          <div class="popup-grid">
            ${popupRow('Type', p.kindLabel)}
            ${popupRow('Operator', p.operator)}
            ${popupRow('Access', p.access)}
            ${popupRow('Fee', p.fee)}
            ${popupRow('Fuel', p.fuel)}
          </div>
          <a class="popup-link" href="${escapeHtml(osmLink)}" target="_blank" rel="noopener">View on OpenStreetMap &rarr;</a>
        </div>`
      );
      osmLayer.addLayer(marker);
    }

    setCountBadge('countOsm', features.length);
    hint.textContent = `Showing ${features.length} OSM boating POIs in current view.`;
  } catch (err) {
    console.error('OSM load error:', err);
    setCountBadge('countOsm', 'err');
    hint.textContent = 'Overpass temporarily busy; pan or zoom to retry.';
  }
}

// ---------------------------------------------------------------------------
// 10. Fetch & Render: Open-Meteo Marine Weather & 24h Forecast Drawer
// ---------------------------------------------------------------------------
let lastWeatherCoords = { lat: INITIAL_CENTER[0], lon: INITIAL_CENTER[1] };

async function loadWeather(lat, lon, openDrawer = false) {
  lastWeatherCoords = { lat, lon };
  try {
    const res = await fetch(`/api/weather?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const cur = data.current || {};
    const temp = cur.temperature_2m != null ? `${cur.temperature_2m.toFixed(1)} °C` : '--';
    const wind = cur.wind_speed_10m != null ? `${cur.wind_speed_10m.toFixed(1)} m/s` : '--';
    const gusts = cur.wind_gusts_10m != null ? `${cur.wind_gusts_10m.toFixed(1)} m/s` : '--';
    const dir = compassDir(cur.wind_direction_10m);
    const press = cur.surface_pressure != null ? `${Math.round(cur.surface_pressure)} hPa` : '--';

    document.getElementById('weatherSummary').textContent = `${temp} · Wind ${wind} ${dir} (gust ${gusts})`;

    document.getElementById('forecastCoords').textContent = `${lat.toFixed(3)}° N, ${lon.toFixed(3)}° E`;
    document.getElementById('forecastCurrent').innerHTML = `
      <div class="forecast-stat"><span class="label">Air Temp</span><span class="val">${escapeHtml(temp)}</span></div>
      <div class="forecast-stat"><span class="label">Wind / Gust</span><span class="val">${escapeHtml(wind)} / ${escapeHtml(gusts)}</span></div>
      <div class="forecast-stat"><span class="label">Dir / Pressure</span><span class="val">${escapeHtml(dir)} · ${escapeHtml(press)}</span></div>
    `;

    const hourly = data.hourly || {};
    const times = hourly.time || [];
    const nowIsoPrefix = new Date().toISOString().slice(0, 13);
    let startIndex = times.findIndex((t) => t.slice(0, 13) >= nowIsoPrefix);
    if (startIndex < 0) startIndex = 0;

    let rowsHtml = '';
    for (let i = startIndex; i < Math.min(startIndex + 24, times.length); i++) {
      const hhmm = times[i].slice(11, 16);
      const tVal = hourly.temperature_2m?.[i];
      const wVal = hourly.wind_speed_10m?.[i];
      const gVal = hourly.wind_gusts_10m?.[i];
      const dVal = hourly.wind_direction_10m?.[i];
      const pVal = hourly.precipitation_probability?.[i];
      rowsHtml += `
        <div class="hour-row">
          <span class="mono">${escapeHtml(hhmm)}</span>
          <span>${tVal != null ? `${tVal.toFixed(1)}°` : '--'}</span>
          <span>${wVal != null ? `${wVal.toFixed(1)}` : '--'} (${gVal != null ? `${gVal.toFixed(1)}` : '--'}) m/s ${compassDir(dVal)}</span>
          <span class="muted-sm">${pVal != null ? `${pVal}%` : '--'}</span>
        </div>
      `;
    }
    document.getElementById('forecastHourly').innerHTML = rowsHtml;

    if (openDrawer) {
      document.getElementById('forecastDrawer').classList.remove('hidden');
    }
  } catch (err) {
    console.error('Open-Meteo error:', err);
    document.getElementById('weatherSummary').textContent = 'Open-Meteo unavailable';
  }
}

// ---------------------------------------------------------------------------
// 10b. Fetch & Render: Traficom Vector Depth Rings & Threshold Adjuster
// ---------------------------------------------------------------------------
let depthTimer = null;

function scheduleDepthLoad() {
  clearTimeout(depthTimer);
  depthTimer = setTimeout(loadDepthInView, 400);
}

// Leaflet's built-in bindPopup() stops the click event, so a depth area / contour /
// sounding under the cursor would swallow the click before map.on('click') could
// place a Start / Via / Dest point (or run a weather inspect). Bind the popup
// ourselves and let the click through to the map while a pick mode is active.
function bindDepthPopup(layer, html) {
  layer.on('click', (e) => {
    if (routePickMode || weatherInspectMode) return; // bubbles on to the map click handler
    L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
  });
}

function renderDepthVectors() {
  depthAreaLayer.clearLayers();
  depthContourLayer.clearLayers();
  depthSoundingLayer.clearLayers();

  if (!cachedDepthData || !document.getElementById('toggleTraficomDepth').checked) return;

  const threshold = currentDepthThreshold;
  const showAreas = document.getElementById('toggleDepthAreas').checked;
  const showSoundings = document.getElementById('toggleDepthSoundings').checked;

  if (showAreas && cachedDepthData.areas.length > 0) {
    const areaLayer = L.geoJSON(
      { type: 'FeatureCollection', features: cachedDepthData.areas },
      {
        renderer: depthCanvas,
        style: (feature) => {
          const p = feature.properties || {};
          const drval1 = Number(p.DRVAL1 ?? 0);
          const drval2 = Number(p.DRVAL2 ?? 999);
          if (drval2 <= threshold) {
            return { fillColor: '#ef4444', fillOpacity: 0.24, stroke: false };
          }
          if (drval1 < threshold) {
            return { fillColor: '#f59e0b', fillOpacity: 0.15, stroke: false };
          }
          return { fillColor: '#0284c7', fillOpacity: 0.05, stroke: false };
        },
        onEachFeature: (feature, layer) => {
          const p = feature.properties || {};
          const drval1 = p.DRVAL1 ?? '?';
          const drval2 = p.DRVAL2 ?? '?';
          bindDepthPopup(
            layer,
            `<div class="popup-card">
              <div class="popup-kicker">Traficom Depth Area</div>
              <h4 class="popup-title">${escapeHtml(drval1)}–${escapeHtml(drval2)} m</h4>
              <div class="popup-grid">
                ${popupRow('Safety Threshold', `${threshold.toFixed(1)} m`)}
                ${popupRow('Status', Number(drval2) <= threshold ? 'Shallow (≤ threshold)' : Number(drval1) < threshold ? 'Caution (straddles threshold)' : 'Deeper than threshold')}
              </div>
            </div>`
          );
        },
      }
    );
    depthAreaLayer.addLayer(areaLayer);
  }

  if (cachedDepthData.contours.length > 0) {
    const contourLayer = L.geoJSON(
      { type: 'FeatureCollection', features: cachedDepthData.contours },
      {
        renderer: depthCanvas,
        style: (feature) => {
          const depth = Number(feature.properties?.VALDCO ?? 0);
          if (depth <= threshold) {
            const isNearEdge = Math.abs(depth - threshold) < 0.6;
            return {
              color: isNearEdge ? '#ea580c' : '#dc2626',
              weight: isNearEdge ? 2.8 : 2.2,
              opacity: 0.95,
            };
          }
          return {
            color: '#0284c7',
            weight: 1.5,
            opacity: 0.8,
          };
        },
        onEachFeature: (feature, layer) => {
          const depth = Number(feature.properties?.VALDCO ?? 0);
          const status = depth <= threshold ? `SHALLOW ≤ ${threshold.toFixed(1)} m` : `Safe > ${threshold.toFixed(1)} m`;
          layer.bindTooltip(`${depth} m contour · ${status}`, { sticky: true });
          bindDepthPopup(
            layer,
            `<div class="popup-card">
              <div class="popup-kicker">Traficom Depth Contour</div>
              <h4 class="popup-title">${escapeHtml(depth)} m ring</h4>
              <div class="popup-grid">
                ${popupRow('Contour Depth', `${depth} m`)}
                ${popupRow('Safety Threshold', `${threshold.toFixed(1)} m`)}
                ${popupRow('Assessment', status)}
              </div>
            </div>`
          );
        },
      }
    );
    depthContourLayer.addLayer(contourLayer);
  }

  if (showSoundings && map.getZoom() >= 12 && cachedDepthData.soundings.length > 0) {
    const bounds = map.getBounds();
    let count = 0;
    for (const f of cachedDepthData.soundings) {
      const coords = f.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const [lon, lat] = coords;
      if (!bounds.contains([lat, lon])) continue;
      if (count >= 180) break;
      count++;

      const depth = Number(f.properties?.DEPTH);
      if (!Number.isFinite(depth)) continue;
      const isShallow = depth <= threshold;
      const label = Number.isInteger(depth) ? String(depth) : depth.toFixed(1);

      const icon = L.divIcon({
        className: 'fmi-icon-wrap',
        iconSize: [28, 14],
        iconAnchor: [14, 7],
        html: `<div class="sounding-label ${isShallow ? 'shallow' : 'safe'}">${escapeHtml(label)}</div>`,
      });
      // bubblingMouseEvents: markers default to false, which would also block the map click
      const marker = L.marker([lat, lon], { icon, bubblingMouseEvents: true });
      bindDepthPopup(
        marker,
        `<div class="popup-card">
          <div class="popup-kicker">Traficom Spot Sounding</div>
          <h4 class="popup-title">${escapeHtml(label)} m</h4>
          <div class="popup-grid">
            ${popupRow('Depth', `${label} m`)}
            ${popupRow('Threshold', `${threshold.toFixed(1)} m`)}
            ${popupRow('Status', isShallow ? 'Shallow (≤ threshold)' : 'Safe (> threshold)')}
          </div>
        </div>`
      );
      depthSoundingLayer.addLayer(marker);
    }
  }
}

async function loadDepthInView() {
  const toggle = document.getElementById('toggleTraficomDepth');
  if (!toggle.checked) {
    depthAreaLayer.clearLayers();
    depthContourLayer.clearLayers();
    depthSoundingLayer.clearLayers();
    if (map.hasLayer(traficomDepthWmsLayer)) map.removeLayer(traficomDepthWmsLayer);
    return;
  }

  if (map.getZoom() < 10) {
    depthAreaLayer.clearLayers();
    depthContourLayer.clearLayers();
    depthSoundingLayer.clearLayers();
    const chartEnabled = document.getElementById('toggleTraficomChart')?.checked ?? false;
    // If nautical chart is active, it already provides depth charts at low zoom;
    // do not load redundant WMS depth tiles underneath or over it!
    if (!chartEnabled && !map.hasLayer(traficomDepthWmsLayer)) {
      traficomDepthWmsLayer.addTo(map);
    } else if (chartEnabled && map.hasLayer(traficomDepthWmsLayer)) {
      map.removeLayer(traficomDepthWmsLayer);
    }
    setCountBadge('countDepth', chartEnabled ? 'on chart' : 'WMS');
    return;
  }

  if (map.hasLayer(traficomDepthWmsLayer)) {
    map.removeLayer(traficomDepthWmsLayer);
  }

  const b = map.getBounds();
  const bbox = `${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`;

  try {
    const res = await fetch(`/api/depth?bbox=${encodeURIComponent(bbox)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedDepthData = await res.json();
    setCountBadge('countDepth', cachedDepthData.contours?.length ?? 0);
    renderDepthVectors();
  } catch (err) {
    console.error('Depth WFS load error:', err);
    setCountBadge('countDepth', 'err');
  }
}

// ---------------------------------------------------------------------------
// 10c. Marine Route Planner (Auto + Manual by Hand)
// ---------------------------------------------------------------------------
let routePickMode = null; // 'start' | 'end' | 'via' | 'manual_draw' | null
let routeStart = null; // { lat, lon }
let routeEnd = null; // { lat, lon }
let routeVias = []; // Array of { lat, lon }
let manualWaypoints = null; // Array of { lat, lon } when manually edited/imported
let currentRouteType = 'auto'; // 'auto' | 'manual'
let isDrawingManual = false;
let manualRubberbandLine = null;
let editHistoryStack = []; // Undo stack of snapshots
let routeStartMarker = null;
let routeEndMarker = null;
let lastComputedRoute = null;
let routeRecalcTimer = null;
let routeAbortController = null;
let activeLegHighlight = null;
let routeSearchAnimFrame = null;
let routeSearchAnimToken = 0;

function stopRouteSearchAnimation(clearLayer = true) {
  routeSearchAnimToken++;
  if (routeSearchAnimFrame !== null) {
    cancelAnimationFrame(routeSearchAnimFrame);
    routeSearchAnimFrame = null;
  }
  if (clearLayer) {
    routeSearchLayer.clearLayers();
  }
}

function routeHasTrace(data) {
  return Boolean(data?.debug?.segments?.some((s) => s.stageAttempts?.some((st) => st.trace?.edges?.length)));
}

function cloneLatLon(pt) {
  return pt ? { lat: pt.lat, lon: pt.lon } : null;
}

function pushRouteEditSnapshot() {
  editHistoryStack.push({
    start: cloneLatLon(routeStart),
    end: cloneLatLon(routeEnd),
    vias: routeVias.map(cloneLatLon),
    manualWaypoints: manualWaypoints ? manualWaypoints.map(cloneLatLon) : null,
  });
  if (editHistoryStack.length > 30) {
    editHistoryStack.shift();
  }
  updateRouteButtons();
}

function restoreRouteSnapshot(snap) {
  if (!snap) return;
  routeVias = (snap.vias || []).map(cloneLatLon);
  manualWaypoints = snap.manualWaypoints ? snap.manualWaypoints.map(cloneLatLon) : null;
  if (snap.start) {
    setRouteEndpoint('start', snap.start.lat, snap.start.lon);
  } else {
    routeStart = null;
    if (routeStartMarker) {
      routeEndpointsLayer.removeLayer(routeStartMarker);
      routeStartMarker = null;
    }
  }
  if (snap.end) {
    setRouteEndpoint('end', snap.end.lat, snap.end.lon);
  } else {
    routeEnd = null;
    if (routeEndMarker) {
      routeEndpointsLayer.removeLayer(routeEndMarker);
      routeEndMarker = null;
    }
  }
  updateRouteButtons();
  if (routeStart && routeEnd) {
    calculateRoute({ useManualWaypoints: Boolean(manualWaypoints && manualWaypoints.length >= 2) });
  }
}

function getEffectiveSeaLevelCm() {
  const useEl = document.getElementById('routeUseSeaLevel');
  if (!useEl || !useEl.checked || cachedMareographs.length === 0) return 0;

  let refLat = map.getCenter().lat;
  let refLon = map.getCenter().lng;
  if (routeStart && routeEnd) {
    refLat = (routeStart.lat + routeEnd.lat) / 2;
    refLon = (routeStart.lon + routeEnd.lon) / 2;
  } else if (routeStart) {
    refLat = routeStart.lat;
    refLon = routeStart.lon;
  }

  let best = nearestMareographItem;
  let bestDist = Infinity;
  for (const m of cachedMareographs) {
    const d = map.distance([refLat, refLon], [m.lat, m.lon]);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best && Number.isFinite(best.watlevCm) ? best.watlevCm : 0;
}

function getEffectiveSafeDepth() {
  const seaLevelCm = getEffectiveSeaLevelCm();
  return Math.max(0.5, Number((currentDepthThreshold - seaLevelCm / 100).toFixed(2)));
}

function updateRouteSafeDepthBadge() {
  const badge = document.getElementById('routeSafeDepthBadge');
  if (!badge) return;
  const seaCm = getEffectiveSeaLevelCm();
  const dSafe = getEffectiveSafeDepth();
  badge.textContent = `D_safe = ${dSafe.toFixed(1)} m`;
  badge.title = `Draft+UKC ${currentDepthThreshold.toFixed(1)} m − sea level (${formatSignedCm(seaCm)})`;
}

function syncThresholdFromDraftAndUkc() {
  const draftEl = document.getElementById('routeDraftM');
  const ukcEl = document.getElementById('routeUkcM');
  if (!draftEl || !ukcEl) return;
  const draftVal = Number.isFinite(Number(draftEl.value)) ? Math.max(0.3, Math.min(18, Number(draftEl.value))) : 2.5;
  const ukcVal = Number.isFinite(Number(ukcEl.value)) ? Math.max(0, Math.min(5, Number(ukcEl.value))) : 0.5;
  currentDepthThreshold = Math.max(0.5, Math.min(20, Number((draftVal + ukcVal).toFixed(1))));
  const slider = document.getElementById('depthThreshold');
  const label = document.getElementById('depthThresholdVal');
  if (slider) slider.value = String(currentDepthThreshold);
  if (label) label.textContent = `${currentDepthThreshold.toFixed(1)} m`;
  renderDepthVectors();
  updateRouteSafeDepthBadge();
  scheduleRouteRecalc(350);
}

function updateRouteButtons() {
  const calcBtn = document.getElementById('calcRouteBtn');
  const clearBtn = document.getElementById('clearRouteBtn');
  const revBtn = document.getElementById('reverseRouteBtn');
  const undoBtn = document.getElementById('undoRouteEditBtn');
  const resetBtn = document.getElementById('resetRouteEditsBtn');
  const gpxBtn = document.getElementById('exportGpxBtn');
  const geoBtn = document.getElementById('exportGeoJsonBtn');
  const replayBtn = document.getElementById('replayRouteSearchBtn');
  const copyDebugBtn = document.getElementById('copyRouteDebugBtn');
  const finishManualBtn = document.getElementById('finishManualBtn');
  const undoManualPtBtn = document.getElementById('undoManualPtBtn');
  const revManualBtn = document.getElementById('reverseManualBtn');
  const drawManualBtn = document.getElementById('drawManualBtn');

  const hasManualRoute = Boolean(manualWaypoints && manualWaypoints.length >= 2);
  const hasBoth = Boolean(routeStart && routeEnd) || hasManualRoute;
  const hasRouteData = Boolean(lastComputedRoute && (lastComputedRoute.waypoints || []).length >= 2);

  if (calcBtn) {
    calcBtn.disabled = !hasBoth;
    calcBtn.textContent = currentRouteType === 'manual' ? 'Evaluate Safe Route' : 'Calculate Safe Route';
  }
  if (clearBtn) clearBtn.disabled = !(routeStart || routeEnd || lastComputedRoute || routeVias.length > 0 || manualWaypoints);
  if (revBtn) revBtn.disabled = !Boolean(routeStart && routeEnd);
  if (undoBtn) undoBtn.disabled = editHistoryStack.length === 0;
  if (resetBtn) resetBtn.disabled = !(routeVias.length > 0 || (manualWaypoints && manualWaypoints.length >= 2));
  if (gpxBtn) gpxBtn.disabled = !hasRouteData;
  if (geoBtn) geoBtn.disabled = !hasRouteData;
  if (replayBtn) replayBtn.disabled = !routeHasTrace(lastComputedRoute);
  if (copyDebugBtn) copyDebugBtn.disabled = !lastComputedRoute;

  if (drawManualBtn) {
    drawManualBtn.classList.toggle('active', isDrawingManual);
    drawManualBtn.textContent = isDrawingManual
      ? 'Adding Points...'
      : (manualWaypoints && manualWaypoints.length > 0 ? '+ Add Points' : '✏️ Add Points');
  }
  if (finishManualBtn) finishManualBtn.disabled = !isDrawingManual && !hasManualRoute;
  if (undoManualPtBtn) undoManualPtBtn.disabled = !manualWaypoints || manualWaypoints.length === 0;
  if (revManualBtn) revManualBtn.disabled = !hasManualRoute;
}

function setRouteStatus(text, isError = false, isSearching = false) {
  const el = document.getElementById('routeStatusText');
  if (!el) return;
  if (!text) {
    el.classList.add('hidden');
    el.classList.remove('error', 'searching');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  el.classList.toggle('searching', isSearching && !isError);
}

function setRoutePickMode(mode) {
  routePickMode = mode;
  if (mode && weatherInspectMode) {
    weatherInspectMode = false;
    weatherInspectBtn.classList.remove('active');
  }
  if (mode && typeof switchSidebarTab === 'function') {
    switchSidebarTab('route');
  }
  document.getElementById('setRouteStartBtn')?.classList.toggle('active', mode === 'start');
  document.getElementById('setRouteViaBtn')?.classList.toggle('active', mode === 'via');
  document.getElementById('setRouteEndBtn')?.classList.toggle('active', mode === 'end');
  document.getElementById('drawManualBtn')?.classList.toggle('active', mode === 'manual_draw');
  document.getElementById('routeModeBtn')?.classList.toggle('active', Boolean(mode));
  document.getElementById('map').classList.toggle('inspect-cursor', Boolean(mode) || weatherInspectMode);
}

function removeManualGuide() {
  if (manualRubberbandLine) {
    map.removeLayer(manualRubberbandLine);
    manualRubberbandLine = null;
  }
}

function startDrawingManual() {
  isDrawingManual = true;
  setRoutePickMode('manual_draw');
  map.doubleClickZoom.disable();
  const count = manualWaypoints ? manualWaypoints.length : 0;
  if (count === 0) {
    setRouteStatus('✏️ Draw by Hand: Click anywhere on the map to place Waypoint 1 (Start A)...');
  } else {
    setRouteStatus(`✏️ Continue Drawing: Click on the map to add waypoint ${count + 1}. Double-click or click "Done" when finished.`);
  }
  updateRouteButtons();
}

function stopDrawingManual(recalcIfReady = true) {
  isDrawingManual = false;
  removeManualGuide();
  map.doubleClickZoom.enable();
  if (routePickMode === 'manual_draw') {
    setRoutePickMode(null);
  }
  if (manualWaypoints && manualWaypoints.length >= 2) {
    setRouteStatus('✓ Manual route complete. Drag any waypoint to adjust, or click "+" on legs to insert vertices.');
    if (recalcIfReady && (!lastComputedRoute || lastComputedRoute.failed)) {
      calculateRoute({ useManualWaypoints: true });
    }
  } else if (manualWaypoints && manualWaypoints.length === 1) {
    setRouteStatus('Waypoint 1 placed. Click "Add Points" to continue adding waypoints.');
  } else {
    setRouteStatus('');
  }
  updateRouteButtons();
}

function createEndpointIcon(kind) {
  const cls = kind === 'start' ? 'start' : 'end';
  const letter = kind === 'start' ? 'A' : 'B';
  return L.divIcon({
    className: 'poi-icon-wrap',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -13],
    html: `<div class="route-endpoint-marker ${cls}">${letter}</div>`,
  });
}

function setRouteEndpoint(kind, lat, lon) {
  const pos = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
  if (kind === 'start') {
    routeStart = pos;
    if (routeStartMarker) routeEndpointsLayer.removeLayer(routeStartMarker);
    routeStartMarker = L.marker([pos.lat, pos.lon], {
      icon: createEndpointIcon('start'),
      draggable: true,
      zIndexOffset: 900,
    });
    routeStartMarker.bindPopup(`<b>Route Start (A)</b><br><span class="mono">${pos.lat.toFixed(4)}° N, ${pos.lon.toFixed(4)}° E</span>`);
    routeStartMarker.on('dragend', (ev) => {
      pushRouteEditSnapshot();
      const ll = ev.target.getLatLng();
      routeStart = { lat: Number(ll.lat.toFixed(6)), lon: Number(ll.lng.toFixed(6)) };
      if (manualWaypoints && manualWaypoints.length >= 2) {
        manualWaypoints[0] = { ...routeStart };
      }
      updateRouteSafeDepthBadge();
      if (routeStart && routeEnd) {
        calculateRoute({ useManualWaypoints: Boolean(manualWaypoints && manualWaypoints.length >= 2) });
      }
    });
    routeEndpointsLayer.addLayer(routeStartMarker);
  } else {
    routeEnd = pos;
    if (routeEndMarker) routeEndpointsLayer.removeLayer(routeEndMarker);
    routeEndMarker = L.marker([pos.lat, pos.lon], {
      icon: createEndpointIcon('end'),
      draggable: true,
      zIndexOffset: 900,
    });
    routeEndMarker.bindPopup(`<b>Destination (B)</b><br><span class="mono">${pos.lat.toFixed(4)}° N, ${pos.lon.toFixed(4)}° E</span>`);
    routeEndMarker.on('dragend', (ev) => {
      pushRouteEditSnapshot();
      const ll = ev.target.getLatLng();
      routeEnd = { lat: Number(ll.lat.toFixed(6)), lon: Number(ll.lng.toFixed(6)) };
      if (manualWaypoints && manualWaypoints.length >= 2) {
        manualWaypoints[manualWaypoints.length - 1] = { ...routeEnd };
      }
      updateRouteSafeDepthBadge();
      if (routeStart && routeEnd) {
        calculateRoute({ useManualWaypoints: Boolean(manualWaypoints && manualWaypoints.length >= 2) });
      }
    });
    routeEndpointsLayer.addLayer(routeEndMarker);
  }
  updateRouteSafeDepthBadge();
  updateRouteButtons();
}

function clearRoute() {
  if (routeAbortController) {
    routeAbortController.abort();
    routeAbortController = null;
  }
  stopRouteSearchAnimation(true);
  clearTimeout(routeRecalcTimer);
  stopDrawingManual(false);
  routeStart = null;
  routeEnd = null;
  routeVias = [];
  manualWaypoints = null;
  editHistoryStack = [];
  routeStartMarker = null;
  routeEndMarker = null;
  lastComputedRoute = null;
  activeLegHighlight = null;
  routeLayer.clearLayers();
  routeMarksLayer.clearLayers();
  routeEndpointsLayer.clearLayers();
  routeAlternativesLayer.clearLayers();
  map.doubleClickZoom.enable();
  setRoutePickMode(null);
  setRouteStatus('');
  document.getElementById('routeActiveIndicator')?.classList.add('hidden');
  document.getElementById('routeSummaryBox').classList.add('hidden');
  const altsBar = document.getElementById('routeAlternativesBar');
  if (altsBar) {
    altsBar.classList.add('hidden');
    altsBar.innerHTML = '';
  }
  document.getElementById('routeStatGrid').innerHTML = '';
  document.getElementById('routeWarningsList').innerHTML = '';
  document.getElementById('routeLegsList').innerHTML = '';
  const debugDetails = document.getElementById('routeDebugDetails');
  if (debugDetails) {
    debugDetails.classList.add('hidden');
    debugDetails.classList.remove('is-failed', 'is-fallback');
    debugDetails.open = false;
  }
  const debugBody = document.getElementById('routeDebugBody');
  if (debugBody) debugBody.innerHTML = '';
  updateRouteSafeDepthBadge();
  updateRouteButtons();
}

function buildRouteDebugReproUrl(data) {
  const p = data?.params || {};
  const q = new URLSearchParams({
    startLat: p.startLat,
    startLon: p.startLon,
    endLat: p.endLat,
    endLon: p.endLon,
    draft: p.draft ?? p.effectiveSafeDepth ?? 3.0,
    seaLevelCm: p.seaLevelCm ?? 0,
    speedKn: p.speedKn ?? 12,
    routingMode: p.routingMode || 'balanced',
    clearanceMode: p.clearanceMode || 'normal',
    avoidFaulty: p.avoidFaulty === false ? '0' : '1',
    avoidRocks: p.avoidRocks === false ? '0' : '1',
    fairwayOffsetSide: p.fairwayOffsetSide || 'center',
    fairwayOffsetM: p.fairwayOffsetM ?? 0,
    shoreMarginM: p.shoreMarginM ?? 0,
    turnRadiusM: p.turnRadiusM ?? 100,
  });
  if (p.vesselDraft != null) q.set('vesselDraft', p.vesselDraft);
  if (p.ukc != null) q.set('ukc', p.ukc);
  if (Array.isArray(p.vias) && p.vias.length > 0) {
    q.set('vias', p.vias.map((v) => `${v.lat},${v.lon}`).join(';'));
  }
  return `/api/route?${q.toString()}`;
}

function buildRouteDebugReportText(data) {
  if (!data) return '';
  const d = data.debug || data.summary?.debug || {};
  const p = data.params || {};
  const s = data.summary || {};
  const report = {
    status: d.status || (s.routeFailed ? 'FAILED' : s.usedFallback ? 'FALLBACK' : 'OK'),
    computeMs: d.computeMs ?? null,
    fetchMs: d.fetchMs ?? null,
    timestamp: new Date().toISOString(),
    route: {
      start: [p.startLat, p.startLon],
      end: [p.endLat, p.endLon],
      vias: p.vias || [],
      isManual: Boolean(p.isManual),
    },
    params: {
      effectiveSafeDepth: p.effectiveSafeDepth,
      vesselDraft: p.vesselDraft,
      ukc: p.ukc,
      seaLevelCm: p.seaLevelCm,
      routingMode: p.routingMode,
      clearanceMode: p.clearanceMode,
      avoidFaulty: p.avoidFaulty,
      avoidRocks: p.avoidRocks,
      fairwayOffsetSide: p.fairwayOffsetSide,
      fairwayOffsetM: p.fairwayOffsetM,
      shoreMarginM: p.shoreMarginM ?? 0,
    },
    wfsCounts: d.wfsCounts || null,
    indexCounts: d.indexCounts || s.stats || null,
    segments: (d.segments || []).map((seg) => ({
      segIdx: seg.segIdx,
      distNm: seg.distNm,
      outcome: seg.outcome,
      stageUsed: seg.stageUsed,
      failureCode: seg.failureCode,
      failureExplanation: seg.failureExplanation,
      startPointBlocked: seg.startPointBlocked,
      endPointBlocked: seg.endPointBlocked,
      startAnchorInfo: seg.startAnchorInfo,
      endAnchorInfo: seg.endAnchorInfo,
      farthestReached: seg.farthestReached,
      remainingDistToGoalM: seg.remainingDistToGoalM,
      primaryObstruction: seg.primaryObstruction,
      directLineObstructions: seg.directLineObstructions,
      directLineReasonCounts: seg.directLineReasonCounts,
      stageAttempts: (seg.stageAttempts || []).map(({ trace, ...rest }) => rest),
    })),
    reproUrl: buildRouteDebugReproUrl(data),
  };
  return JSON.stringify(report, null, 2);
}

async function copyRouteDebugReport(triggerBtn) {
  if (!lastComputedRoute) return;
  const text = buildRouteDebugReportText(lastComputedRoute);
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    document.body.removeChild(ta);
  }
  if (copied && triggerBtn) {
    const prevHtml = triggerBtn.innerHTML;
    triggerBtn.textContent = '✓ Copied!';
    setTimeout(() => {
      triggerBtn.innerHTML = prevHtml;
    }, 1600);
  }
}

function renderStaticSearchTree(data) {
  routeSearchLayer.clearLayers();
  const segments = data?.debug?.segments || [];
  for (const seg of segments) {
    for (const st of seg.stageAttempts || []) {
      const edges = st.trace?.edges;
      if (!edges || edges.length === 0) continue;
      const fwSegs = [];
      const openSegs = [];
      for (const e of edges) {
        const pair = [
          [e[0], e[1]],
          [e[2], e[3]],
        ];
        if (e[4] === 1) fwSegs.push(pair);
        else openSegs.push(pair);
      }
      if (openSegs.length > 0) {
        L.polyline(openSegs, {
          renderer: routeSearchRenderer,
          color: st.outcome === 'failed' ? '#f97316' : '#3b82f6',
          weight: 1.4,
          opacity: 0.35,
          interactive: false,
        }).addTo(routeSearchLayer);
      }
      if (fwSegs.length > 0) {
        L.polyline(fwSegs, {
          renderer: routeSearchRenderer,
          color: '#0d9488',
          weight: 2.0,
          opacity: 0.45,
          interactive: false,
        }).addTo(routeSearchLayer);
      }
    }
  }
}

function playRouteSearchAnimation(data, onDone) {
  stopRouteSearchAnimation(true);
  const myToken = routeSearchAnimToken;

  const animStages = [];
  for (const seg of data?.debug?.segments || []) {
    for (const st of seg.stageAttempts || []) {
      if (st.trace?.edges?.length > 0) {
        animStages.push({ segIdx: seg.segIdx, st });
      }
    }
  }

  if (animStages.length === 0) {
    onDone?.();
    return;
  }

  routeLayer.clearLayers();
  routeMarksLayer.clearLayers();

  const probePoly = L.polyline([], {
    renderer: routeSearchRenderer,
    color: '#facc15',
    weight: 3.5,
    opacity: 0.95,
    interactive: false,
  }).addTo(routeSearchLayer);

  const frontierDot = L.circleMarker([0, 0], {
    renderer: routeSearchRenderer,
    radius: 5,
    color: '#ffffff',
    weight: 2,
    fillColor: '#facc15',
    fillOpacity: 1,
    interactive: false,
  });

  let stageCursor = 0;

  const finishAll = () => {
    if (myToken !== routeSearchAnimToken) return;
    routeSearchAnimFrame = null;
    probePoly.remove();
    frontierDot.remove();
    onDone?.();
    const keepTree = Boolean(document.getElementById('routeKeepSearchTree')?.checked);
    if (keepTree || data.summary?.routeFailed) {
      renderStaticSearchTree(data);
    } else {
      routeSearchLayer.clearLayers();
    }
    setRouteStatus('');
  };

  const runNextStage = () => {
    if (myToken !== routeSearchAnimToken) return;
    if (stageCursor >= animStages.length) {
      finishAll();
      return;
    }

    const { segIdx, st } = animStages[stageCursor];
    const edges = st.trace.edges;
    const totalEdges = edges.length;
    const probes = st.trace.probePaths || [];
    const totalVisited = st.visitedNodes || totalEdges;
    const edgesPerFrame = Math.max(4, Math.ceil(totalEdges / 45));

    const fwSegs = [];
    const openSegs = [];
    const fwPoly = L.polyline([], {
      renderer: routeSearchRenderer,
      color: '#14b8a6',
      weight: 2.2,
      opacity: 0.72,
      interactive: false,
    }).addTo(routeSearchLayer);
    const openPoly = L.polyline([], {
      renderer: routeSearchRenderer,
      color: st.outcome === 'failed' ? '#f97316' : '#3b82f6',
      weight: 1.5,
      opacity: 0.52,
      interactive: false,
    }).addTo(routeSearchLayer);

    let edgeIdx = 0;
    let dotAdded = false;

    const stepFrame = () => {
      if (myToken !== routeSearchAnimToken) return;

      const limit = Math.min(totalEdges, edgeIdx + edgesPerFrame);
      let fwDirty = false;
      let openDirty = false;
      for (; edgeIdx < limit; edgeIdx++) {
        const e = edges[edgeIdx];
        const pair = [
          [e[0], e[1]],
          [e[2], e[3]],
        ];
        if (e[4] === 1) {
          fwSegs.push(pair);
          fwDirty = true;
        } else {
          openSegs.push(pair);
          openDirty = true;
        }
      }
      if (openDirty) openPoly.setLatLngs(openSegs);
      if (fwDirty) fwPoly.setLatLngs(fwSegs);

      const frac = totalEdges > 0 ? edgeIdx / totalEdges : 1;
      if (probes.length > 0) {
        const mIdx = Math.min(probes.length - 1, Math.floor(frac * probes.length));
        const probeCoords = probes[mIdx];
        if (probeCoords && probeCoords.length >= 1) {
          probePoly.setLatLngs(probeCoords);
          probePoly.bringToFront();
          const headPt = probeCoords[probeCoords.length - 1];
          frontierDot.setLatLng(headPt);
          if (!dotAdded) {
            frontierDot.addTo(routeSearchLayer);
            dotAdded = true;
          }
          frontierDot.bringToFront();
        }
      }

      const scaledVisited = Math.max(1, Math.round(frac * totalVisited));
      setRouteStatus(
        `🔎 Seg ${segIdx + 1} · Stage ${st.stage} (${st.label}): exploring ${scaledVisited} / ${totalVisited} nodes...`,
        false,
        true
      );

      if (edgeIdx < totalEdges) {
        routeSearchAnimFrame = requestAnimationFrame(stepFrame);
      } else {
        routeSearchAnimFrame = null;
        if (st.outcome === 'ok' && st.trace.rawWinningPath && st.trace.rawWinningPath.length >= 2) {
          const winPoly = L.polyline(st.trace.rawWinningPath, {
            renderer: routeSearchRenderer,
            color: '#10b981',
            weight: 4.5,
            opacity: 0.95,
            interactive: false,
          }).addTo(routeSearchLayer);
          winPoly.bringToFront();
          setRouteStatus(
            `✓ Seg ${segIdx + 1} found path (${st.trace.rawWinningPath.length} raw nodes) — simplifying...`,
            false,
            true
          );
          setTimeout(() => {
            if (myToken !== routeSearchAnimToken) return;
            winPoly.remove();
            stageCursor++;
            runNextStage();
          }, 220);
        } else if (st.outcome === 'failed') {
          setRouteStatus(
            `⚠ Seg ${segIdx + 1} · Stage ${st.stage} stopped (${st.failureCode || 'blocked'}) after ${totalVisited} nodes...`,
            false,
            true
          );
          setTimeout(() => {
            if (myToken !== routeSearchAnimToken) return;
            stageCursor++;
            runNextStage();
          }, 220);
        } else {
          stageCursor++;
          runNextStage();
        }
      }
    };

    routeSearchAnimFrame = requestAnimationFrame(stepFrame);
  };

  runNextStage();
}

function renderRouteDiagnostics(data) {
  const s = data?.summary || {};
  const d = data?.debug || s.debug;
  const debugDetails = document.getElementById('routeDebugDetails');
  const summaryLabel = document.getElementById('routeDebugSummaryLabel');
  const debugBody = document.getElementById('routeDebugBody');
  if (!debugDetails || !debugBody || !d) return;

  // Plot visual diagnostic markers on map for failed / anchor-blocked segments
  for (const mk of d.mapMarkers || []) {
    if (mk.kind === 'farthest-reached') {
      if (Number.isFinite(mk.toLat) && Number.isFinite(mk.toLon)) {
        L.polyline(
          [
            [mk.lat, mk.lon],
            [mk.toLat, mk.toLon],
          ],
          { color: '#d97706', weight: 2.5, dashArray: '5, 5', opacity: 0.85, interactive: false }
        ).addTo(routeMarksLayer);
      }
      const frontierIcon = L.divIcon({
        className: 'poi-icon-wrap',
        iconSize: [94, 20],
        iconAnchor: [47, 10],
        popupAnchor: [0, -10],
        html: '<div class="route-debug-map-badge farthest">&#8677; A* Frontier</div>',
      });
      const marker = L.marker([mk.lat, mk.lon], { icon: frontierIcon, zIndexOffset: 790 });
      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">Route Diagnostic · Segment ${mk.segIdx + 1}</div>
          <h4 class="popup-title">Farthest Reachable Node</h4>
          <div class="popup-grid">
            ${popupRow('Position', `${mk.lat.toFixed(5)}° N, ${mk.lon.toFixed(5)}° E`)}
            ${popupRow('Failure', mk.reason)}
            ${popupRow('Detail', mk.detail)}
          </div>
        </div>`
      );
      marker.addTo(routeMarksLayer);
    } else {
      L.circle([mk.lat, mk.lon], {
        radius: 45,
        color: '#dc2626',
        weight: 2,
        dashArray: '4, 3',
        fillColor: '#ef4444',
        fillOpacity: 0.18,
        interactive: false,
      }).addTo(routeMarksLayer);

      const obsIcon = L.divIcon({
        className: 'poi-icon-wrap',
        iconSize: [140, 20],
        iconAnchor: [70, 10],
        popupAnchor: [0, -10],
        html: `<div class="route-debug-map-badge ${escapeHtml(mk.kind || 'obstruction')}">&#10005; ${escapeHtml(
          mk.label || mk.reason || 'Blocked'
        )}</div>`,
      });
      const marker = L.marker([mk.lat, mk.lon], { icon: obsIcon, zIndexOffset: 800 });
      marker.bindPopup(
        `<div class="popup-card">
          <div class="popup-kicker">Route Obstruction · Segment ${mk.segIdx + 1}</div>
          <h4 class="popup-title">${escapeHtml(mk.label || 'Blocked Passage')}</h4>
          <div class="popup-grid">
            ${popupRow('Reason', mk.reason)}
            ${popupRow('Position', `${mk.lat.toFixed(5)}° N, ${mk.lon.toFixed(5)}° E`)}
            ${popupRow('Dist from Start', mk.distFromStartM != null ? `${mk.distFromStartM} m` : null)}
            ${popupRow('Detail', mk.detail)}
          </div>
        </div>`
      );
      marker.addTo(routeMarksLayer);
    }
  }

  const statusText = d.status || (s.routeFailed ? 'FAILED' : s.usedFallback ? 'FALLBACK' : 'OK');
  debugDetails.classList.remove('is-failed', 'is-fallback', 'hidden');
  if (s.routeFailed) debugDetails.classList.add('is-failed');
  else if (s.usedFallback) debugDetails.classList.add('is-fallback');

  if (summaryLabel) {
    const timing = d.computeMs != null ? `${d.computeMs} ms` : '';
    summaryLabel.textContent = `Route Diagnostics · ${statusText}${timing ? ` (${timing})` : ''}`;
  }

  const wc = d.wfsCounts || {};
  const ic = d.indexCounts || {};
  const wfsSummaryHtml = `
    <div class="route-debug-item">
      <b>Corridor WFS &amp; Index</b> (${escapeHtml(d.fetchMs ?? '?')} ms fetch):
      Contours ${escapeHtml(wc.contours ?? '?')} (${escapeHtml(ic.shallowContours ?? '?')} shallow) ·
      Areas ${escapeHtml(wc.depthAreas ?? '?')} ·
      Shoreline ${escapeHtml(ic.shorelineSegments ?? '?')} ·
      Soundings ${escapeHtml(wc.soundings ?? '?')} ·
      Fairways ${escapeHtml((wc.navLines || 0) + (wc.fairways || 0))} ·
      Marks ${escapeHtml(wc.seamarks ?? '?')}${wc.rocks != null ? ` · Rocks ${escapeHtml(wc.rocks)} (${escapeHtml(ic.rocks ?? 0)})` : ''}
    </div>
  `;

  const segHtml = (d.segments || [])
    .map((seg) => {
      const locBtns = [];
      if (seg.primaryObstruction) {
        const po = seg.primaryObstruction;
        locBtns.push(
          `<button type="button" class="route-debug-loc-btn" data-debug-lat="${po.lat}" data-debug-lon="${po.lon}" title="${escapeHtml(
            po.detail || po.reason
          )}">&#10005; ${escapeHtml(po.reason)} (${po.lat.toFixed(4)}, ${po.lon.toFixed(4)})</button>`
        );
      }
      if (seg.farthestReached) {
        const fr = seg.farthestReached;
        locBtns.push(
          `<button type="button" class="route-debug-loc-btn is-frontier" data-debug-lat="${fr.lat}" data-debug-lon="${fr.lon}">&#8677; Frontier (${fr.lat.toFixed(
            4
          )}, ${fr.lon.toFixed(4)})</button>`
        );
      }
      for (const obs of (seg.directLineObstructions || []).slice(0, 3)) {
        if (
          seg.primaryObstruction &&
          obs.lat === seg.primaryObstruction.lat &&
          obs.lon === seg.primaryObstruction.lon
        ) {
          continue;
        }
        locBtns.push(
          `<button type="button" class="route-debug-loc-btn" data-debug-lat="${obs.lat}" data-debug-lon="${obs.lon}" title="${escapeHtml(
            obs.detail || obs.reason
          )}">&#10005; ${escapeHtml(obs.reason)} (${obs.lat.toFixed(4)}, ${obs.lon.toFixed(4)})</button>`
        );
      }

      const stageLines = (seg.stageAttempts || [])
        .map((st) => {
          const g = st.grid || {};
          const topReasons = Object.entries(g.blockedReasonCounts || {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ');
          const gridInfo = g.cols
            ? `${g.cols}x${g.rows} @${g.stepM}m, open ${g.openGridNodes}/blk ${g.blockedGridNodes}`
            : '';
          return `Stage ${st.stage} (${st.outcome}${st.failureCode ? `:${st.failureCode}` : ''}): ${gridInfo}${topReasons ? ` [${topReasons}]` : ''
            } · visited ${st.visitedNodes ?? 0} (${st.elapsedMs ?? 0} ms)`;
        })
        .join('<br>');

      return `
        <div class="route-debug-item">
          <b>Seg ${seg.segIdx + 1}</b> (${escapeHtml(seg.distNm)} NM): <b>${escapeHtml(seg.outcome)}</b>${seg.failureCode ? ` · <span class="mono">${escapeHtml(seg.failureCode)}</span>` : ''
        }
          ${seg.failureExplanation ? `<div style="margin-top:2px;">${escapeHtml(seg.failureExplanation)}</div>` : ''}
          ${locBtns.length > 0 ? `<div style="margin-top:3px;">${locBtns.join('')}</div>` : ''}
          ${stageLines ? `<div class="muted-sm mono" style="margin-top:3px;">${stageLines}</div>` : ''}
        </div>
      `;
    })
    .join('');

  const reportText = buildRouteDebugReportText(data);
  debugBody.innerHTML = `
    ${wfsSummaryHtml}
    ${segHtml}
    <pre class="route-debug-pre">${escapeHtml(reportText)}</pre>
  `;

  debugBody.querySelectorAll('.route-debug-loc-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lat = Number(btn.dataset.debugLat);
      const lon = Number(btn.dataset.debugLon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        map.flyTo([lat, lon], Math.max(map.getZoom(), 14));
      }
    });
  });

  debugDetails.open = Boolean(s.routeFailed || s.usedFallback);
}

function getSeamarkBadgeMeta(mark) {
  switch (mark.role) {
    case 'cardinal-N':
      return { glyph: '▲N', cls: 'role-cardinal' };
    case 'cardinal-S':
      return { glyph: '▼S', cls: 'role-cardinal' };
    case 'cardinal-W':
      return { glyph: '◀W', cls: 'role-cardinal' };
    case 'cardinal-E':
      return { glyph: '▶E', cls: 'role-cardinal' };
    case 'lateral-port':
      return { glyph: '■Port', cls: 'role-lateral-port' };
    case 'lateral-starboard':
      return { glyph: '▲Stbd', cls: 'role-lateral-starboard' };
    case 'danger':
      return { glyph: '⚠Danger', cls: 'role-danger' };
    default:
      return { glyph: mark.short || 'MARK', cls: 'role-other' };
  }
}

function drawCardinalKeepOutOverlay(mark) {
  const dirAngles = { N: 180, S: 0, W: 90, E: 270 };
  const centerBearing = dirAngles[mark.safeDir];
  if (centerBearing === undefined) return;

  const rMeters = mark.isFaulty ? 42 : 26;
  const mPerDegLat = 111132;
  const mPerDegLon = 111320 * Math.cos((mark.lat * Math.PI) / 180);
  const halfAngle = 32;

  const polygonCoords = [[mark.lat, mark.lon]];
  for (let step = -3; step <= 3; step++) {
    const rad = ((centerBearing + (step / 3) * halfAngle) * Math.PI) / 180;
    polygonCoords.push([
      mark.lat + (rMeters * Math.cos(rad)) / mPerDegLat,
      mark.lon + (rMeters * Math.sin(rad)) / mPerDegLon,
    ]);
  }

  L.polygon(polygonCoords, {
    color: '#ca8a04',
    weight: 1.2,
    dashArray: '3, 3',
    fillColor: '#facc15',
    fillOpacity: 0.16,
    interactive: false,
  }).addTo(routeMarksLayer);
}

function renderComputedRoute(data) {
  routeLayer.clearLayers();
  routeMarksLayer.clearLayers();
  activeLegHighlight = null;

  const coordsLatLon = (data.waypoints || []).map((w) => [w.lat, w.lon]);
  if (coordsLatLon.length >= 2) {
    L.polyline(coordsLatLon, {
      color: '#ffffff',
      weight: 8,
      opacity: 0.88,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(routeLayer);
  }

  const legPolylines = new Map();
  for (const leg of data.legs || []) {
    const pts = [
      [leg.from.lat, leg.from.lon],
      [leg.to.lat, leg.to.lon],
    ];
    let style;
    if (leg.legType === 'fairway') {
      style = { color: '#0d9488', weight: 4.5, opacity: 0.96 };
    } else if (leg.legType === 'approach') {
      style = { color: '#ea580c', weight: 3.5, opacity: 0.92, dashArray: '4, 6' };
    } else {
      style = { color: '#2563eb', weight: 4, opacity: 0.92, dashArray: '8, 5' };
    }

    const poly = L.polyline(pts, style);
    const typeLabel =
      leg.legType === 'fairway'
        ? 'Official Fairway'
        : leg.legType === 'approach'
          ? 'Shore Approach (Caution)'
          : 'Deep Open Water';
    const marksHtml =
      leg.instructions && leg.instructions.length > 0
        ? `<div class="popup-grid" style="margin-top:6px;">${leg.instructions
          .map((ins, idx) => popupRow(`Mark ${idx + 1}`, ins))
          .join('')}</div>`
        : '';

    poly.bindTooltip(`Leg ${leg.index} · ${leg.bearingDeg}° · ${leg.distNm} NM (${typeLabel})`, {
      sticky: true,
    });
    poly.bindPopup(
      `<div class="popup-card">
        <div class="popup-kicker">Route Leg ${leg.index}</div>
        <h4 class="popup-title">${escapeHtml(typeLabel)}</h4>
        <div class="popup-grid">
          ${popupRow('Bearing (COG)', `${String(leg.bearingDeg).padStart(3, '0')}°`)}
          ${popupRow('Distance', `${leg.distNm} NM (${leg.distM} m)`)}
          ${popupRow('Fairway', leg.fairwayName)}
          ${popupRow('Swept Depth', leg.fairwayDepth != null ? `${leg.fairwayDepth} m` : null)}
          ${popupRow('Channel Offset', leg.fairwayOffsetM > 0 ? `${leg.fairwayOffsetM} m ${leg.fairwayOffsetSide === 'port' ? 'Port (P)' : 'Starboard (S)'}` : null)}
        </div>
        ${marksHtml}
      </div>`
    );
    poly.addTo(routeLayer);
    legPolylines.set(leg.index, poly);
  }

  // Intermediate Waypoints (draggable, clickable, deletable)
  const wps = data.waypoints || [];
  const deleteWaypointAtIndex = (idx, wp) => {
    pushRouteEditSnapshot();
    if (wp.role === 'via' && wp.viaIndex != null && routeVias[wp.viaIndex]) {
      routeVias.splice(wp.viaIndex, 1);
      manualWaypoints = null;
      calculateRoute({ useManualWaypoints: false });
      return;
    }
    const list = wps.map((w) => ({ lat: w.lat, lon: w.lon }));
    if (list.length <= 2) return;
    list.splice(idx, 1);
    manualWaypoints = list;
    calculateRoute({ useManualWaypoints: true });
  };

  const pinWaypointAsVia = (wp) => {
    pushRouteEditSnapshot();
    manualWaypoints = null;
    const insertIdx = Math.min(routeVias.length, Math.max(0, Number(wp.segIdx) || 0));
    routeVias.splice(insertIdx, 0, { lat: wp.lat, lon: wp.lon });
    calculateRoute({ useManualWaypoints: false });
  };

  for (let i = 1; i < wps.length - 1; i++) {
    const wp = wps[i];
    const nextLeg = data.legs?.[i];
    const isVia = wp.role === 'via';
    const isManualWp = wp.role === 'manual' || Boolean(manualWaypoints && manualWaypoints.length >= 2);
    const viaLabel = isVia ? `V${(wp.viaIndex ?? 0) + 1}` : `WP ${i}`;
    const isFillet = Boolean(wp.isFillet);
    const icon = isVia
      ? L.divIcon({
        className: 'poi-icon-wrap',
        iconSize: [24, 20],
        iconAnchor: [12, 10],
        html: `<div class="route-via-marker">${escapeHtml(viaLabel)}</div>`,
      })
      : L.divIcon({
        className: 'poi-icon-wrap',
        iconSize: isFillet ? [10, 10] : [14, 14],
        iconAnchor: isFillet ? [5, 5] : [7, 7],
        html: `<div class="route-wp-marker${isManualWp ? ' manual' : ''}${isFillet ? ' fillet' : ''}"></div>`,
      });

    const m = L.marker([wp.lat, wp.lon], {
      icon,
      draggable: true,
      zIndexOffset: isVia ? 760 : 650,
    });
    const roleLabel = isVia
      ? `Pinned Via-Point (${viaLabel})`
      : isManualWp
        ? 'Manual Vertex'
        : 'Auto Waypoint';
    m.bindPopup(
      `<div class="popup-card">
        <div class="popup-kicker">${escapeHtml(roleLabel)}</div>
        <h4 class="popup-title">${escapeHtml(viaLabel)}</h4>
        <div class="popup-grid">
          ${popupRow('Position', `${wp.lat.toFixed(4)}° N, ${wp.lon.toFixed(4)}° E`)}
          ${popupRow('Next Bearing', nextLeg ? `${String(nextLeg.bearingDeg).padStart(3, '0')}°` : null)}
          ${popupRow('Next Leg', nextLeg ? `${nextLeg.distNm} NM` : null)}
        </div>
        <div class="popup-actions-row">
          ${!isVia ? '<button type="button" class="popup-mini-btn" data-wp-action="pin-via">Pin as Via</button>' : ''}
          <button type="button" class="popup-mini-btn danger" data-wp-action="delete">${isVia ? 'Remove Via' : 'Delete WP'
      }</button>
        </div>
      </div>`
    );

    m.on('popupopen', () => {
      const popEl = m.getPopup()?.getElement();
      if (!popEl) return;
      const pinBtn = popEl.querySelector('[data-wp-action="pin-via"]');
      if (pinBtn) {
        pinBtn.addEventListener('click', () => {
          m.closePopup();
          pinWaypointAsVia(wp);
        });
      }
      const delBtn = popEl.querySelector('[data-wp-action="delete"]');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          m.closePopup();
          deleteWaypointAtIndex(i, wp);
        });
      }
    });

    m.on('dragend', (ev) => {
      const ll = ev.target.getLatLng();
      const newPos = { lat: Number(ll.lat.toFixed(6)), lon: Number(ll.lng.toFixed(6)) };
      pushRouteEditSnapshot();
      const isManualEdit =
        document.getElementById('routeEditMode')?.value === 'manual' || Boolean(ev.originalEvent?.shiftKey);
      if (!isManualEdit) {
        manualWaypoints = null;
        if (isVia && wp.viaIndex != null && routeVias[wp.viaIndex]) {
          routeVias[wp.viaIndex] = newPos;
        } else {
          const insertIdx = Math.min(routeVias.length, Math.max(0, Number(wp.segIdx) || 0));
          routeVias.splice(insertIdx, 0, newPos);
        }
        calculateRoute({ useManualWaypoints: false });
      } else {
        manualWaypoints = wps.map((w) => ({ lat: w.lat, lon: w.lon }));
        manualWaypoints[i] = newPos;
        calculateRoute({ useManualWaypoints: true });
      }
    });

    m.on('contextmenu', (ev) => {
      L.DomEvent.stopPropagation(ev);
      deleteWaypointAtIndex(i, wp);
    });

    m.addTo(routeLayer);
  }

  // Leg midpoint handles (+) to click or drag to insert a Via-Point / manual vertex
  for (let legIdx = 0; legIdx < (data.legs || []).length; legIdx++) {
    const leg = data.legs[legIdx];
    if (leg.distM < 80) continue;
    const midLat = Number(((leg.from.lat + leg.to.lat) / 2).toFixed(6));
    const midLon = Number(((leg.from.lon + leg.to.lon) / 2).toFixed(6));
    const midIcon = L.divIcon({
      className: 'poi-icon-wrap',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
      html: '<div class="route-midpoint-handle" title="Click or drag to insert waypoint">+</div>',
    });
    const midMarker = L.marker([midLat, midLon], {
      icon: midIcon,
      draggable: true,
      zIndexOffset: 620,
    });
    let draggingMid = false;
    const insertAtLeg = (pos, shiftHeld) => {
      pushRouteEditSnapshot();
      const isManualEdit =
        document.getElementById('routeEditMode')?.value === 'manual' || Boolean(shiftHeld);
      if (!isManualEdit) {
        manualWaypoints = null;
        const insertIdx = Math.min(routeVias.length, Math.max(0, Number(leg.from?.segIdx) || 0));
        routeVias.splice(insertIdx, 0, pos);
        calculateRoute({ useManualWaypoints: false });
      } else {
        const list = wps.map((w) => ({ lat: w.lat, lon: w.lon }));
        list.splice(legIdx + 1, 0, pos);
        manualWaypoints = list;
        calculateRoute({ useManualWaypoints: true });
      }
    };
    midMarker.on('dragstart', () => {
      draggingMid = true;
    });
    midMarker.on('dragend', (ev) => {
      const ll = ev.target.getLatLng();
      insertAtLeg(
        { lat: Number(ll.lat.toFixed(6)), lon: Number(ll.lng.toFixed(6)) },
        ev.originalEvent?.shiftKey
      );
    });
    midMarker.on('click', (ev) => {
      if (draggingMid) {
        draggingMid = false;
        return;
      }
      L.DomEvent.stopPropagation(ev);
      insertAtLeg({ lat: midLat, lon: midLon }, ev.originalEvent?.shiftKey);
    });
    midMarker.addTo(routeLayer);
  }

  // Seamarks near the route + keep-out overlays
  for (const mk of data.marksNearRoute || []) {
    if (mk.safeDir) {
      if (mk.distM <= 110) {
        drawCardinalKeepOutOverlay(mk);
      }
    } else if (mk.role === 'danger') {
      L.circle([mk.lat, mk.lon], {
        radius: mk.isFaulty ? 70 : 40,
        color: '#dc2626',
        weight: 1.5,
        dashArray: '4, 4',
        fillColor: '#ef4444',
        fillOpacity: 0.14,
        interactive: false,
      }).addTo(routeMarksLayer);
    }

    const meta = getSeamarkBadgeMeta(mk);
    const faultSuffix = mk.isFaulty ? ' !' : '';
    const icon = L.divIcon({
      className: 'fmi-icon-wrap',
      iconSize: [64, 18],
      iconAnchor: [32, 9],
      popupAnchor: [0, -9],
      html: `<div class="route-seamark-badge ${meta.cls}${mk.isFaulty ? ' is-faulty' : ''}">${escapeHtml(
        meta.glyph + faultSuffix
      )}</div>`,
    });

    const marker = L.marker([mk.lat, mk.lon], { icon, zIndexOffset: 550 });
    marker.bindPopup(
      `<div class="popup-card">
        <div class="popup-kicker">Väylävirasto Seamark</div>
        <h4 class="popup-title">${escapeHtml(mk.name)}</h4>
        <div class="popup-grid">
          ${popupRow('Classification', mk.label)}
          ${popupRow('Closest Pass', `${mk.distM} m`)}
          ${popupRow('ATON Status', mk.isFaulty ? `FAULT (${mk.faultType || 'Open'})` : 'Nominal')}
        </div>
      </div>`
    );
    marker.addTo(routeMarksLayer);
  }

  // Render Sidebar Summary
  const summaryBox = document.getElementById('routeSummaryBox');
  const s = data.summary || {};
  document.getElementById('routeStatGrid').innerHTML = `
    <div class="route-stat-card">
      <span class="label">Distance</span>
      <span class="val mono">${escapeHtml(s.totalDistNm.toFixed(2))} NM <span class="muted-sm">(${escapeHtml((s.totalDistM / 1000).toFixed(2))} km)</span></span>
    </div>
    <div class="route-stat-card">
      <span class="label">ETA (${escapeHtml(data.params.speedKn)} kn)</span>
      <span class="val mono">${escapeHtml(s.etaMinutes)} min</span>
    </div>
    <div class="route-stat-card">
      <span class="label">Fairway Share</span>
      <span class="val mono">${escapeHtml(s.fairwayPct)}% <span class="muted-sm">(${escapeHtml((data.legs || []).length)} legs)</span></span>
    </div>
    <div class="route-stat-card">
      <span class="label">D_safe / Marks</span>
      <span class="val mono">${escapeHtml(s.effectiveSafeDepth.toFixed(1))} m · ${escapeHtml(s.marksRespectedCount)}</span>
    </div>
  `;

  document.getElementById('routeWarningsList').innerHTML = (s.warnings || [])
    .map((w, idx) => {
      const severe = idx > 0 && (s.cautionLegs > 0 || s.faultyMarksNearby > 0 || s.routeFailed);
      return `<div class="route-warning-chip${severe ? ' severe' : ''}">${escapeHtml(w)}</div>`;
    })
    .join('');

  renderRouteDiagnostics(data);

  const legsHtml = (data.legs || [])
    .map((leg) => {
      const cls =
        leg.legType === 'fairway' ? 'leg-fairway' : leg.legType === 'approach' ? 'leg-approach' : '';
      const typeShort =
        leg.legType === 'fairway' ? 'Fairway' : leg.legType === 'approach' ? 'Approach' : 'Open Water';
      const markChips = (leg.instructions || [])
        .map((ins) => `<span class="route-mark-chip">${escapeHtml(ins)}</span>`)
        .join('');
      return `
        <div class="route-leg-item ${cls}" data-leg-idx="${leg.index}">
          <div class="route-leg-top">
            <span>Leg ${leg.index} · ${String(leg.bearingDeg).padStart(3, '0')}°</span>
            <span class="mono">${leg.distNm} NM</span>
          </div>
          <div class="route-leg-meta">
            ${escapeHtml(typeShort)}${leg.fairwayName ? ` · ${escapeHtml(leg.fairwayName)}` : ''}${leg.fairwayDepth != null ? ` (${leg.fairwayDepth} m)` : ''
        }
          </div>
          ${markChips ? `<div class="route-leg-marks">${markChips}</div>` : ''}
        </div>
      `;
    })
    .join('');

  const legsListEl = document.getElementById('routeLegsList');
  legsListEl.innerHTML = legsHtml;

  legsListEl.querySelectorAll('.route-leg-item').forEach((item) => {
    item.addEventListener('click', () => {
      const idx = Number(item.dataset.legIdx);
      const leg = (data.legs || []).find((l) => l.index === idx);
      if (!leg) return;
      if (activeLegHighlight) {
        routeLayer.removeLayer(activeLegHighlight);
      }
      activeLegHighlight = L.polyline(
        [
          [leg.from.lat, leg.from.lon],
          [leg.to.lat, leg.to.lon],
        ],
        { color: '#facc15', weight: 9, opacity: 0.65, interactive: false }
      ).addTo(routeLayer);
      map.fitBounds(
        [
          [leg.from.lat, leg.from.lon],
          [leg.to.lat, leg.to.lon],
        ],
        { padding: [60, 60], maxZoom: 15 }
      );
      const poly = legPolylines.get(idx);
      if (poly) poly.openPopup();
    });
  });

  renderRouteAlternatives(data);
  summaryBox.classList.remove('hidden');
  document.getElementById('routeActiveIndicator')?.classList.remove('hidden');
}

function selectRouteAlternative(targetObjective) {
  if (!routeStart || !routeEnd) return;
  const prefEl = document.getElementById('routePrefMode');
  const clrEl = document.getElementById('routeClearanceMode');
  if (targetObjective === 'fast') {
    if (prefEl) prefEl.value = 'open_water';
    if (clrEl) clrEl.value = 'tight';
  } else if (targetObjective === 'safe') {
    if (prefEl) prefEl.value = 'balanced';
    if (clrEl) clrEl.value = 'wide';
  } else if (targetObjective === 'fairway') {
    if (prefEl) prefEl.value = 'strict_fairway';
  } else if (targetObjective === 'balanced') {
    if (prefEl) prefEl.value = 'balanced';
    if (clrEl) clrEl.value = 'normal';
  }
  setRouteStatus(`Switching to ${targetObjective} route...`);
  calculateRoute({ targetObjective });
}

function renderRouteAlternatives(data) {
  routeAlternativesLayer.clearLayers();
  const altsBar = document.getElementById('routeAlternativesBar');
  const alts = data.alternatives || [];
  const useManual = Boolean(manualWaypoints && manualWaypoints.length >= 2);

  if (!altsBar) return;

  if (useManual || alts.length <= 1) {
    altsBar.classList.add('hidden');
    altsBar.innerHTML = '';
    return;
  }

  altsBar.classList.remove('hidden');

  const profileMeta = {
    balanced: { label: 'Balanced', icon: '⚖️', color: '#0891b2' },
    fast: { label: 'Fast / Direct', icon: '⚡', color: '#d97706' },
    safe: { label: 'Maximum Safety', icon: '🛡️', color: '#059669' },
    fairway: { label: 'Official Fairways', icon: '⚓', color: '#7c3aed' },
  };

  const primaryObjId = data.objective || 'balanced';
  const allCards = [];

  const primMeta = profileMeta[primaryObjId] || { label: primaryObjId, icon: '🧭', color: '#0d9488' };
  allCards.push({
    objective: primaryObjId,
    label: primMeta.label,
    icon: primMeta.icon,
    color: primMeta.color,
    distanceNm: data.summary?.totalDistNm ?? 0,
    fairwayPct: data.summary?.fairwayPct ?? 0,
    safetyScore: data.scores?.safetyScore ?? null,
    riskScore: data.scores?.riskScore ?? null,
    isActive: true,
  });

  for (const alt of alts) {
    if (alt.objective === primaryObjId) continue;
    const meta = profileMeta[alt.objective] || {
      label: alt.label || alt.objective,
      icon: '🧭',
      color: '#64748b',
    };

    const altDistNm = alt.scores?.distanceNm ?? alt.summary?.totalDistNm ?? 0;
    const altFairwayPct = alt.scores?.fairwayPct ?? alt.summary?.fairwayPct ?? 0;

    allCards.push({
      objective: alt.objective,
      label: meta.label,
      icon: meta.icon,
      color: meta.color,
      distanceNm: altDistNm,
      fairwayPct: altFairwayPct,
      safetyScore: alt.scores?.safetyScore ?? null,
      riskScore: alt.scores?.riskScore ?? null,
      isActive: false,
    });

    const altCoords = (alt.waypoints || []).map((w) => [w.lat, w.lon]);
    if (altCoords.length >= 2) {
      L.polyline(altCoords, {
        color: '#ffffff',
        weight: 6,
        opacity: 0.6,
        lineCap: 'round',
        interactive: false,
      }).addTo(routeAlternativesLayer);

      const altPoly = L.polyline(altCoords, {
        color: meta.color,
        weight: 4,
        opacity: 0.85,
        dashArray: '7, 8',
        lineCap: 'round',
      });

      altPoly.bindTooltip(
        `<div style="font-size:11px;"><strong>${meta.icon} ${escapeHtml(meta.label)}</strong><br/>${altDistNm.toFixed(2)} NM · ${altFairwayPct}% fairway<br/><span style="color:#0d9488;font-weight:600;">Click to select this route</span></div>`,
        { sticky: true }
      );

      altPoly.on('mouseover', () => {
        altPoly.setStyle({ weight: 6, opacity: 1.0 });
      });
      altPoly.on('mouseout', () => {
        altPoly.setStyle({ weight: 4, opacity: 0.85 });
      });
      altPoly.on('click', () => {
        selectRouteAlternative(alt.objective);
      });

      altPoly.addTo(routeAlternativesLayer);
    }
  }

  altsBar.innerHTML = `
    <div class="alternatives-header">
      <span class="alt-title">Route Alternatives</span>
      <span class="alt-subtitle">Click to switch</span>
    </div>
    <div class="alternatives-list">
      ${allCards
        .map(
          (c) => `
        <button type="button" class="alt-chip ${c.isActive ? 'active' : ''}" data-obj="${escapeHtml(c.objective)}">
          <div class="alt-chip-top">
            <div class="alt-chip-label-wrap">
              <span class="alt-icon">${c.icon}</span>
              <span class="alt-label">${escapeHtml(c.label)}</span>
              ${c.isActive ? '<span class="alt-meta-tag active-badge">ACTIVE</span>' : ''}
            </div>
            <span class="alt-dist mono">${c.distanceNm.toFixed(2)} NM</span>
          </div>
          <div class="alt-chip-meta">
            <span class="alt-meta-tag">${c.fairwayPct}% fairway</span>
            ${c.safetyScore != null ? `<span class="alt-meta-tag ${c.safetyScore >= 80 ? 'safety-high' : ''}">Safety ${Math.round(c.safetyScore)}/100</span>` : ''}
          </div>
        </button>
      `
        )
        .join('')}
    </div>
  `;

  altsBar.querySelectorAll('.alt-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const obj = btn.getAttribute('data-obj');
      if (obj && obj !== primaryObjId) {
        selectRouteAlternative(obj);
      }
    });
  });
}

async function calculateRoute(opts = {}) {
  if (!routeStart || !routeEnd) return;
  stopRouteSearchAnimation(true);
  if (routeAbortController) {
    routeAbortController.abort();
  }
  routeAbortController = new AbortController();

  if (opts.useManualWaypoints === false) {
    manualWaypoints = null;
  }
  const useManual = opts.useManualWaypoints ?? Boolean(manualWaypoints && manualWaypoints.length >= 2);
  const animateSearch = Boolean(document.getElementById('routeAnimateSearch')?.checked) && !useManual;
  const keepSearchTree = Boolean(document.getElementById('routeKeepSearchTree')?.checked);

  const speedKn = Math.max(3, Math.min(35, Number(document.getElementById('routeSpeedKn')?.value) || 12));
  const rawDraft = Number(document.getElementById('routeDraftM')?.value);
  const vesselDraft = Number.isFinite(rawDraft) ? Math.max(0.2, Math.min(25, rawDraft)) : 2.5;
  const rawUkc = Number(document.getElementById('routeUkcM')?.value);
  const ukc = Number.isFinite(rawUkc) ? Math.max(0, Math.min(10, rawUkc)) : 0.5;
  const routingMode = document.getElementById('routePrefMode')?.value || 'balanced';
  const clearanceMode = document.getElementById('routeClearanceMode')?.value || 'normal';
  const avoidFaulty = document.getElementById('routeAvoidFaulty')?.checked !== false ? '1' : '0';
  const avoidRocks = document.getElementById('routeAvoidRocks')?.checked !== false ? '1' : '0';
  const fairwayOffsetSide = document.getElementById('routeFairwayOffsetSide')?.value || 'center';
  const rawOffsetM = Number(document.getElementById('routeFairwayOffsetM')?.value);
  const fairwayOffsetM =
    fairwayOffsetSide === 'center'
      ? 0
      : Number.isFinite(rawOffsetM)
        ? Math.max(0, Math.min(100, rawOffsetM))
        : 0;
  const rawShoreMargin = Number(document.getElementById('routeShoreMarginM')?.value);
  const shoreMarginM = Number.isFinite(rawShoreMargin) ? Math.max(0, Math.min(150, rawShoreMargin)) : 15;
  const rawTurnRadius = Number(document.getElementById('routeTurnRadiusM')?.value);
  const turnRadiusM = Number.isFinite(rawTurnRadius) ? Math.max(0, Math.min(500, rawTurnRadius)) : 100;
  const seaLevelCm = getEffectiveSeaLevelCm();
  updateRouteSafeDepthBadge();

  setRouteStatus(
    useManual
      ? 'Validating edited waypoints against Traficom depths & Väylävirasto seamarks...'
      : animateSearch
        ? 'Fetching chart depths & running live A* pathfinder...'
        : 'Computing safe route from Traficom depth & Väylävirasto fairways/marks...',
    false,
    animateSearch
  );

  if (animateSearch) {
    const corridorPts = [routeStart, ...routeVias, routeEnd].filter(Boolean).map((p) => [p.lat, p.lon]);
    if (corridorPts.length >= 2) {
      L.polyline(corridorPts, {
        renderer: routeSearchRenderer,
        color: '#0d9488',
        weight: 2,
        dashArray: '6, 6',
        opacity: 0.58,
        interactive: false,
      }).addTo(routeSearchLayer);
    }
  }

  const query = new URLSearchParams({
    startLat: routeStart.lat,
    startLon: routeStart.lon,
    endLat: routeEnd.lat,
    endLon: routeEnd.lon,
    draft: currentDepthThreshold,
    vesselDraft,
    ukc,
    seaLevelCm,
    speedKn,
    routingMode,
    clearanceMode,
    avoidFaulty,
    avoidRocks,
    fairwayOffsetSide,
    fairwayOffsetM,
    shoreMarginM,
    turnRadiusM,
    trace: animateSearch || keepSearchTree ? '1' : '0',
  });
  if (routeVias.length > 0 && !useManual) {
    query.set('vias', routeVias.map((v) => `${v.lat},${v.lon}`).join(';'));
  }
  if (useManual && manualWaypoints && manualWaypoints.length >= 2) {
    query.set('manualWaypoints', manualWaypoints.map((w) => `${w.lat},${w.lon}`).join(';'));
  }
  if (opts.targetObjective) {
    query.set('objectives', `${opts.targetObjective},balanced,fast,safe,fairway`);
  } else if (Boolean(document.getElementById('routeMultiObjective')?.checked) && !useManual) {
    query.set('alternatives', '3');
  }

  try {
    const res = await fetch(`/api/route?${query.toString()}`, { signal: routeAbortController.signal });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    lastComputedRoute = data;
    updateRouteButtons();
    renderComputedRoute(data);
    if (animateSearch && routeHasTrace(data)) {
      playRouteSearchAnimation(data, () => renderComputedRoute(data));
    } else {
      setRouteStatus('');
      if (keepSearchTree || data.summary?.routeFailed) {
        renderStaticSearchTree(data);
      } else {
        routeSearchLayer.clearLayers();
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    routeSearchLayer.clearLayers();
    console.error('Route calculation error:', err);
    setRouteStatus(`Route calculation failed: ${err.message}`, true);
  }
}

function scheduleRouteRecalc(delayMs = 450) {
  if (!lastComputedRoute || !routeStart || !routeEnd) return;
  clearTimeout(routeRecalcTimer);
  routeRecalcTimer = setTimeout(() => calculateRoute(), delayMs);
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function downloadBlobFile(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportRouteAsGpx() {
  if (!lastComputedRoute || !lastComputedRoute.waypoints || lastComputedRoute.waypoints.length < 2) return;
  const wps = lastComputedRoute.waypoints;
  const dSafe = lastComputedRoute.summary?.effectiveSafeDepth ?? getEffectiveSafeDepth();
  const timestamp = new Date().toISOString();
  const rteName = `Luotsi Route (D_safe ${dSafe.toFixed(1)} m)`;

  const rtePts = wps
    .map((w, idx) => {
      const name = idx === 0 ? 'START A' : idx === wps.length - 1 ? 'DEST B' : w.role === 'via' ? `V${(w.viaIndex ?? 0) + 1}` : `WP ${idx}`;
      return `    <rtept lat="${w.lat}" lon="${w.lon}"><name>${escapeXml(name)}</name></rtept>`;
    })
    .join('\n');

  const trkPts = wps
    .map((w) => `      <trkpt lat="${w.lat}" lon="${w.lon}"></trkpt>`)
    .join('\n');

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Luotsi Open Map Viewer" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(rteName)}</name>
    <time>${timestamp}</time>
  </metadata>
  <rte>
    <name>${escapeXml(rteName)}</name>
${rtePts}
  </rte>
  <trk>
    <name>${escapeXml(rteName)} Track</name>
    <trkseg>
${trkPts}
    </trkseg>
  </trk>
</gpx>`;

  downloadBlobFile(`luotsi-route-${timestamp.slice(0, 10)}.gpx`, 'application/gpx+xml', gpx);
}

function exportRouteAsGeoJson() {
  if (!lastComputedRoute || !lastComputedRoute.waypoints || lastComputedRoute.waypoints.length < 2) return;
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Luotsi Marine Route',
          ...(lastComputedRoute.summary || {}),
          params: lastComputedRoute.params || {},
        },
        geometry: lastComputedRoute.route?.geometry || {
          type: 'LineString',
          coordinates: lastComputedRoute.waypoints.map((w) => [w.lon, w.lat]),
        },
      },
      ...lastComputedRoute.waypoints.map((w) => ({
        type: 'Feature',
        properties: {
          index: w.index,
          role: w.role || 'auto',
          viaIndex: w.viaIndex ?? null,
        },
        geometry: {
          type: 'Point',
          coordinates: [w.lon, w.lat],
        },
      })),
    ],
  };
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadBlobFile(`luotsi-route-${dateStr}.geojson`, 'application/geo+json', JSON.stringify(fc, null, 2));
}

async function handleImportedRouteFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const pts = [];
    const lowerName = (file.name || '').toLowerCase();

    if (lowerName.endsWith('.gpx') || text.trimStart().startsWith('<')) {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      let elems = Array.from(doc.querySelectorAll('rtept'));
      if (elems.length < 2) elems = Array.from(doc.querySelectorAll('trkpt'));
      if (elems.length < 2) elems = Array.from(doc.querySelectorAll('wpt'));
      for (const el of elems) {
        const lat = Number(el.getAttribute('lat'));
        const lon = Number(el.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          pts.push({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) });
        }
      }
    } else {
      const json = JSON.parse(text);
      const extractFromGeom = (geom) => {
        if (!geom) return;
        if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
          for (const c of geom.coordinates) {
            if (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[1]) && Number.isFinite(c[0])) {
              pts.push({ lat: Number(c[1].toFixed(6)), lon: Number(c[0].toFixed(6)) });
            }
          }
        } else if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates[0])) {
          for (const c of geom.coordinates[0]) {
            if (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[1]) && Number.isFinite(c[0])) {
              pts.push({ lat: Number(c[1].toFixed(6)), lon: Number(c[0].toFixed(6)) });
            }
          }
        }
      };

      if (json.type === 'FeatureCollection' && Array.isArray(json.features)) {
        for (const f of json.features) {
          if (f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString') {
            extractFromGeom(f.geometry);
            break;
          }
        }
        if (pts.length < 2) {
          for (const f of json.features) {
            const c = f.geometry?.coordinates;
            if (f.geometry?.type === 'Point' && Array.isArray(c) && c.length >= 2) {
              pts.push({ lat: Number(c[1].toFixed(6)), lon: Number(c[0].toFixed(6)) });
            }
          }
        }
      } else if (json.type === 'Feature') {
        extractFromGeom(json.geometry);
      } else {
        extractFromGeom(json);
      }
    }

    if (pts.length < 2) {
      setRouteStatus('Imported file needs at least 2 valid route coordinates.', true);
      return;
    }

    pushRouteEditSnapshot();
    routeVias = [];
    manualWaypoints = pts.slice(0, 250);
    setRouteEndpoint('start', manualWaypoints[0].lat, manualWaypoints[0].lon);
    setRouteEndpoint('end', manualWaypoints[manualWaypoints.length - 1].lat, manualWaypoints[manualWaypoints.length - 1].lon);
    map.fitBounds(
      manualWaypoints.map((p) => [p.lat, p.lon]),
      { padding: [50, 50], maxZoom: 14 }
    );
    calculateRoute({ useManualWaypoints: true });
  } catch (err) {
    console.error('Import error:', err);
    setRouteStatus(`Failed to import route: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// 11. UI Event Wiring
// ---------------------------------------------------------------------------
document.querySelectorAll('input[name="basemap"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    const nextKey = e.target.value;
    if (nextKey === activeBaseKey) return;
    activeBaseKey = nextKey;
    updateBaseMapVisibility();
  });
});

document.getElementById('toggleTraficomChart').addEventListener('change', (e) => {
  if (e.target.checked) {
    const opacity = Number(document.getElementById('traficomOpacity')?.value ?? 100) / 100;
    activeTraficomLayer.setOpacity(opacity);
    activeTraficomLayer.addTo(map);
  } else {
    map.removeLayer(activeTraficomLayer);
  }
  updateBaseMapVisibility();
  if (document.getElementById('toggleTraficomDepth')?.checked && map.getZoom() < 10) {
    loadDepthInView();
  }
});

document.getElementById('traficomSeriesSelect').addEventListener('change', (e) => {
  const nextSeries = e.target.value;
  const wasOn = map.hasLayer(activeTraficomLayer);
  if (wasOn) map.removeLayer(activeTraficomLayer);
  activeTraficomSeries = nextSeries;
  activeTraficomLayer = traficomChartLayers[activeTraficomSeries];
  const opacity = Number(document.getElementById('traficomOpacity')?.value ?? 100) / 100;
  activeTraficomLayer.setOpacity(opacity);
  if (wasOn) activeTraficomLayer.addTo(map);
  updateBaseMapVisibility();
});

document.getElementById('traficomOpacity').addEventListener('input', (e) => {
  const pct = Number(e.target.value);
  document.getElementById('traficomOpacityVal').textContent = `${pct}%`;
  activeTraficomLayer.setOpacity(pct / 100);
  updateBaseMapVisibility();
});

function bindSimpleOverlay(checkboxId, layer) {
  document.getElementById(checkboxId).addEventListener('change', (e) => {
    if (e.target.checked) layer.addTo(map);
    else map.removeLayer(layer);
  });
}

document.getElementById('toggleTraficomDepth').addEventListener('change', (e) => {
  if (e.target.checked) {
    loadDepthInView();
  } else {
    depthAreaLayer.clearLayers();
    depthContourLayer.clearLayers();
    depthSoundingLayer.clearLayers();
    if (map.hasLayer(traficomDepthWmsLayer)) map.removeLayer(traficomDepthWmsLayer);
  }
});

document.getElementById('depthThreshold').addEventListener('input', (e) => {
  currentDepthThreshold = Number(e.target.value);
  document.getElementById('depthThresholdVal').textContent = `${currentDepthThreshold.toFixed(1)} m`;
  const draftEl = document.getElementById('routeDraftM');
  const ukcEl = document.getElementById('routeUkcM');
  if (draftEl && ukcEl) {
    const ukcVal = Number.isFinite(Number(ukcEl.value)) ? Number(ukcEl.value) : 0.5;
    draftEl.value = Math.max(0.3, Number((currentDepthThreshold - ukcVal).toFixed(1))).toFixed(1);
  }
  renderDepthVectors();
  updateRouteSafeDepthBadge();
  scheduleRouteRecalc(450);
});

// Route Planner UI Wiring
document.getElementById('routeModeBtn').addEventListener('click', () => {
  if (routePickMode) {
    setRoutePickMode(null);
    return;
  }
  sidebar.classList.remove('hidden');
  sidebarExpandBtn.classList.add('hidden');
  setTimeout(() => map.invalidateSize(), 150);
  setRoutePickMode(routeStart && !routeEnd ? 'end' : 'start');
});

document.getElementById('routeModeAutoBtn')?.addEventListener('click', () => {
  currentRouteType = 'auto';
  document.getElementById('routeModeAutoBtn').classList.add('active');
  document.getElementById('routeModeManualBtn').classList.remove('active');
  document.getElementById('autoRouteControls').classList.remove('hidden');
  document.getElementById('manualRouteControls').classList.add('hidden');
  if (isDrawingManual) stopDrawingManual(false);
  updateRouteButtons();
});

document.getElementById('routeModeManualBtn')?.addEventListener('click', () => {
  currentRouteType = 'manual';
  document.getElementById('routeModeManualBtn').classList.add('active');
  document.getElementById('routeModeAutoBtn').classList.remove('active');
  document.getElementById('manualRouteControls').classList.remove('hidden');
  document.getElementById('autoRouteControls').classList.add('hidden');
  startDrawingManual();
});

document.getElementById('drawManualBtn')?.addEventListener('click', () => {
  if (isDrawingManual) {
    stopDrawingManual(true);
  } else {
    startDrawingManual();
  }
});

document.getElementById('finishManualBtn')?.addEventListener('click', () => {
  stopDrawingManual(true);
});

document.getElementById('undoManualPtBtn')?.addEventListener('click', () => {
  if (!manualWaypoints || manualWaypoints.length === 0) return;
  pushRouteEditSnapshot();
  manualWaypoints.pop();
  if (manualWaypoints.length === 0) {
    clearRoute();
    if (currentRouteType === 'manual') startDrawingManual();
  } else if (manualWaypoints.length === 1) {
    routeEnd = null;
    if (routeEndMarker) {
      routeEndpointsLayer.removeLayer(routeEndMarker);
      routeEndMarker = null;
    }
    routeLayer.clearLayers();
    setRouteStatus('Waypoint 1 placed. Click on map to add Waypoint 2...');
    updateRouteButtons();
  } else {
    routeEnd = { ...manualWaypoints[manualWaypoints.length - 1] };
    setRouteEndpoint('end', routeEnd.lat, routeEnd.lon);
    calculateRoute({ useManualWaypoints: true });
  }
});

document.getElementById('reverseManualBtn')?.addEventListener('click', () => {
  if (!manualWaypoints || manualWaypoints.length < 2) return;
  pushRouteEditSnapshot();
  manualWaypoints.reverse();
  routeStart = { ...manualWaypoints[0] };
  routeEnd = { ...manualWaypoints[manualWaypoints.length - 1] };
  setRouteEndpoint('start', routeStart.lat, routeStart.lon);
  setRouteEndpoint('end', routeEnd.lat, routeEnd.lon);
  calculateRoute({ useManualWaypoints: true });
});

document.getElementById('setRouteStartBtn').addEventListener('click', () => {
  setRoutePickMode(routePickMode === 'start' ? null : 'start');
});

document.getElementById('setRouteViaBtn').addEventListener('click', () => {
  setRoutePickMode(routePickMode === 'via' ? null : 'via');
});

document.getElementById('setRouteEndBtn').addEventListener('click', () => {
  setRoutePickMode(routePickMode === 'end' ? null : 'end');
});

document.getElementById('reverseRouteBtn').addEventListener('click', () => {
  if (!routeStart || !routeEnd) return;
  pushRouteEditSnapshot();
  const prevStart = cloneLatLon(routeStart);
  const prevEnd = cloneLatLon(routeEnd);
  routeVias.reverse();
  if (manualWaypoints && manualWaypoints.length >= 2) {
    manualWaypoints.reverse();
  }
  setRouteEndpoint('start', prevEnd.lat, prevEnd.lon);
  setRouteEndpoint('end', prevStart.lat, prevStart.lon);
  calculateRoute({ useManualWaypoints: Boolean(manualWaypoints && manualWaypoints.length >= 2) });
});

document.getElementById('demoRouteBtn').addEventListener('click', () => {
  setRoutePickMode(null);
  routeVias = [];
  manualWaypoints = null;
  editHistoryStack = [];
  map.setView([60.151, 24.975], 13);
  setRouteEndpoint('start', 60.165, 25.002);
  setRouteEndpoint('end', 60.1485, 24.956);
  calculateRoute({ useManualWaypoints: false });
});

document.getElementById('calcRouteBtn').addEventListener('click', () => {
  if (currentRouteType === 'manual' && manualWaypoints && manualWaypoints.length >= 2) {
    calculateRoute({ useManualWaypoints: true });
  } else {
    if (manualWaypoints) pushRouteEditSnapshot();
    manualWaypoints = null;
    calculateRoute({ useManualWaypoints: false });
  }
});
document.getElementById('clearRouteBtn').addEventListener('click', clearRoute);

document.getElementById('undoRouteEditBtn').addEventListener('click', () => {
  if (editHistoryStack.length === 0) return;
  const snap = editHistoryStack.pop();
  restoreRouteSnapshot(snap);
});

document.getElementById('resetRouteEditsBtn').addEventListener('click', () => {
  if (routeVias.length === 0 && !manualWaypoints) return;
  pushRouteEditSnapshot();
  routeVias = [];
  manualWaypoints = null;
  calculateRoute({ useManualWaypoints: false });
});

document.getElementById('exportGpxBtn').addEventListener('click', exportRouteAsGpx);
document.getElementById('exportGeoJsonBtn').addEventListener('click', exportRouteAsGeoJson);
document.getElementById('replayRouteSearchBtn')?.addEventListener('click', () => {
  if (lastComputedRoute && routeHasTrace(lastComputedRoute)) {
    playRouteSearchAnimation(lastComputedRoute, () => renderComputedRoute(lastComputedRoute));
  }
});
document.getElementById('routeKeepSearchTree')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    if (lastComputedRoute && routeHasTrace(lastComputedRoute)) {
      renderStaticSearchTree(lastComputedRoute);
    } else if (routeStart && routeEnd) {
      calculateRoute();
    }
  } else if (routeSearchAnimFrame === null) {
    routeSearchLayer.clearLayers();
  }
});
document.getElementById('copyRouteDebugBtn')?.addEventListener('click', (e) => {
  copyRouteDebugReport(e.currentTarget);
});
document.getElementById('copyRouteDebugInlineBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  copyRouteDebugReport(e.currentTarget);
});

const importFileInput = document.getElementById('importRouteFileInput');
document.getElementById('importRouteBtn').addEventListener('click', () => {
  importFileInput?.click();
});
importFileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    await handleImportedRouteFile(file);
  }
  e.target.value = '';
});

document.getElementById('routeDraftM').addEventListener('change', syncThresholdFromDraftAndUkc);
document.getElementById('routeUkcM').addEventListener('change', syncThresholdFromDraftAndUkc);

document.getElementById('routeUseSeaLevel').addEventListener('change', () => {
  updateRouteSafeDepthBadge();
  scheduleRouteRecalc(250);
});

document.getElementById('routeSpeedKn').addEventListener('change', () => {
  scheduleRouteRecalc(250);
});

document.getElementById('routePrefMode').addEventListener('change', () => {
  if (manualWaypoints) pushRouteEditSnapshot();
  manualWaypoints = null;
  if (routeStart && routeEnd) calculateRoute({ useManualWaypoints: false });
});

document.getElementById('routeFairwayOffsetSide').addEventListener('change', (e) => {
  const offsetInput = document.getElementById('routeFairwayOffsetM');
  if (offsetInput) {
    if (e.target.value === 'center') {
      offsetInput.value = '0';
    } else if (!(Number(offsetInput.value) > 0)) {
      offsetInput.value = '15';
    }
  }
  if (manualWaypoints) pushRouteEditSnapshot();
  manualWaypoints = null;
  if (routeStart && routeEnd) calculateRoute({ useManualWaypoints: false });
});

document.getElementById('routeFairwayOffsetM').addEventListener('change', (e) => {
  const sideEl = document.getElementById('routeFairwayOffsetSide');
  const raw = Number(e.target.value);
  const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  e.target.value = String(clamped);
  if (sideEl) {
    if (clamped > 0 && sideEl.value === 'center') {
      sideEl.value = 'starboard';
    } else if (clamped <= 0) {
      sideEl.value = 'center';
    }
  }
  if (manualWaypoints) pushRouteEditSnapshot();
  manualWaypoints = null;
  scheduleRouteRecalc(200);
});

document.getElementById('routeShoreMarginM')?.addEventListener('change', (e) => {
  const raw = Number(e.target.value);
  const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(150, raw)) : 15;
  e.target.value = String(clamped);
  if (manualWaypoints) pushRouteEditSnapshot();
  manualWaypoints = null;
  scheduleRouteRecalc(200);
});

document.getElementById('routeTurnRadiusM')?.addEventListener('change', (e) => {
  const raw = Number(e.target.value);
  const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(500, raw)) : 100;
  e.target.value = String(clamped);
  if (manualWaypoints) pushRouteEditSnapshot();
  manualWaypoints = null;
  scheduleRouteRecalc(200);
});

document.getElementById('routeClearanceMode').addEventListener('change', () => {
  scheduleRouteRecalc(200);
});

document.getElementById('routeAvoidFaulty').addEventListener('change', () => {
  scheduleRouteRecalc(200);
});

document.getElementById('routeAvoidRocks')?.addEventListener('change', () => {
  scheduleRouteRecalc(200);
});

document.getElementById('routeMultiObjective')?.addEventListener('change', () => {
  scheduleRouteRecalc(150);
});

async function updateRockBadge() {
  try {
    const res = await fetch('/api/rocks/stats');
    if (res.ok) {
      const data = await res.json();
      const badge = document.getElementById('rocksCountBadge');
      if (badge && data.totalRocks) {
        const countK = data.totalRocks >= 1000 ? Math.round(data.totalRocks / 1000) + 'k' : data.totalRocks;
        badge.textContent = `${countK} rocks`;
        badge.title = `${data.totalRocks.toLocaleString()} charted rocks, awash & submerged hazards in database`;
      }
    }
  } catch (_) {}
}
updateRockBadge();

document.getElementById('toggleDepthAreas').addEventListener('change', renderDepthVectors);
document.getElementById('toggleDepthSoundings').addEventListener('change', renderDepthVectors);

/** Synchronize the Väylävirasto WMS layer parameter and visibility with master and sub-layer toggles. */
function updateVaylaLayer() {
  const masterEl = document.getElementById('toggleVayla');
  const masterOn = Boolean(masterEl?.checked);
  const subControlsEl = document.getElementById('vaylaSubControls');
  if (subControlsEl) {
    subControlsEl.style.opacity = masterOn ? '1' : '0.55';
  }
  const activeLayers = VAYLA_SUBLAYERS.filter((s) => document.getElementById(s.id)?.checked).map((s) => s.layer);
  if (!masterOn || activeLayers.length === 0) {
    if (map.hasLayer(vaylaLayer)) map.removeLayer(vaylaLayer);
    return;
  }
  const nextLayersParam = activeLayers.join(',');
  if (vaylaLayer.wmsParams.layers !== nextLayersParam) {
    vaylaLayer.setParams({ layers: nextLayersParam });
  }
  if (!map.hasLayer(vaylaLayer)) {
    vaylaLayer.addTo(map);
  }
}

document.getElementById('toggleVayla').addEventListener('change', (e) => {
  if (e.target.checked && !VAYLA_SUBLAYERS.some((s) => document.getElementById(s.id)?.checked)) {
    for (const s of VAYLA_SUBLAYERS) {
      const el = document.getElementById(s.id);
      if (el) el.checked = true;
    }
  }
  updateVaylaLayer();
});

for (const sub of VAYLA_SUBLAYERS) {
  document.getElementById(sub.id).addEventListener('change', (e) => {
    const masterEl = document.getElementById('toggleVayla');
    if (e.target.checked) {
      if (masterEl && !masterEl.checked) masterEl.checked = true;
    } else if (!VAYLA_SUBLAYERS.some((s) => document.getElementById(s.id)?.checked)) {
      if (masterEl) masterEl.checked = false;
    }
    updateVaylaLayer();
  });
}

const SIMPLE_OVERLAY_BINDINGS = [
  ['toggleOpenSeaMap', openSeaMapLayer],
  ['togglePropertyLines', propertyLinesLayer],
  ['toggleMareograph', mareographLayer],
  ['toggleFmi', fmiLayer],
  ['toggleSeptit', septitLayer],
  ['toggleLipasHarbour', lipasHarbourLayer],
  ['toggleLipasShelter', lipasShelterLayer],
  ['toggleLipasHut', lipasHutLayer],
  ['toggleLipasCampfire', lipasCampfireLayer],
];

for (const [checkboxId, layer] of SIMPLE_OVERLAY_BINDINGS) {
  bindSimpleOverlay(checkboxId, layer);
}

document.getElementById('toggleWarnings').addEventListener('change', (e) => {
  if (e.target.checked) {
    warningsLayer.addTo(map);
    traficomWarningsWms.addTo(map);
  } else {
    map.removeLayer(warningsLayer);
    map.removeLayer(traficomWarningsWms);
  }
});

document.getElementById('seaLevelPill').addEventListener('click', () => {
  if (!nearestMareographItem) return;
  if (!document.getElementById('toggleMareograph').checked) {
    document.getElementById('toggleMareograph').checked = true;
    mareographLayer.addTo(map);
  }
  map.setView([nearestMareographItem.lat, nearestMareographItem.lon], Math.max(map.getZoom(), 11));
  nearestMareographItem.marker.openPopup();
});

document.getElementById('toggleAis').addEventListener('change', (e) => {
  if (e.target.checked) {
    aisLayer.addTo(map);
    renderAisViewport();
  } else {
    map.removeLayer(aisLayer);
  }
});

document.getElementById('toggleOsm').addEventListener('change', (e) => {
  if (e.target.checked) {
    osmLayer.addTo(map);
    scheduleOsmLoad();
  } else {
    map.removeLayer(osmLayer);
  }
});

/** Turn all map data and chart overlays on or off while keeping the base map active. */
function setAllDataLayers(enabled) {
  const chartToggle = document.getElementById('toggleTraficomChart');
  if (chartToggle) chartToggle.checked = enabled;
  if (enabled) {
    const opacity = Number(document.getElementById('traficomOpacity')?.value ?? 100) / 100;
    activeTraficomLayer.setOpacity(opacity);
    if (!map.hasLayer(activeTraficomLayer)) activeTraficomLayer.addTo(map);
  } else if (map.hasLayer(activeTraficomLayer)) {
    map.removeLayer(activeTraficomLayer);
  }

  const depthToggle = document.getElementById('toggleTraficomDepth');
  if (depthToggle) depthToggle.checked = enabled;
  if (enabled) {
    loadDepthInView();
  } else {
    depthAreaLayer.clearLayers();
    depthContourLayer.clearLayers();
    depthSoundingLayer.clearLayers();
    if (map.hasLayer(traficomDepthWmsLayer)) map.removeLayer(traficomDepthWmsLayer);
  }

  const vaylaToggle = document.getElementById('toggleVayla');
  if (vaylaToggle) vaylaToggle.checked = enabled;
  for (const sub of VAYLA_SUBLAYERS) {
    const subEl = document.getElementById(sub.id);
    if (subEl) subEl.checked = enabled;
  }
  updateVaylaLayer();

  for (const [checkboxId, layer] of SIMPLE_OVERLAY_BINDINGS) {
    const el = document.getElementById(checkboxId);
    if (el) el.checked = enabled;
    if (enabled) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }

  const warningsToggle = document.getElementById('toggleWarnings');
  if (warningsToggle) warningsToggle.checked = enabled;
  if (enabled) {
    if (!map.hasLayer(warningsLayer)) warningsLayer.addTo(map);
    if (!map.hasLayer(traficomWarningsWms)) traficomWarningsWms.addTo(map);
  } else {
    if (map.hasLayer(warningsLayer)) map.removeLayer(warningsLayer);
    if (map.hasLayer(traficomWarningsWms)) map.removeLayer(traficomWarningsWms);
  }

  const aisToggle = document.getElementById('toggleAis');
  if (aisToggle) aisToggle.checked = enabled;
  if (enabled) {
    if (!map.hasLayer(aisLayer)) aisLayer.addTo(map);
    renderAisViewport();
  } else {
    if (map.hasLayer(aisLayer)) map.removeLayer(aisLayer);
    aisLayer.clearLayers();
  }

  const osmToggle = document.getElementById('toggleOsm');
  if (osmToggle) osmToggle.checked = enabled;
  if (enabled) {
    if (!map.hasLayer(osmLayer)) osmLayer.addTo(map);
    scheduleOsmLoad();
  } else {
    if (map.hasLayer(osmLayer)) map.removeLayer(osmLayer);
    osmLayer.clearLayers();
  }

  updateBaseMapVisibility();
}

document.getElementById('allLayersOffBtn').addEventListener('click', () => setAllDataLayers(false));
document.getElementById('allLayersOnBtn').addEventListener('click', () => setAllDataLayers(true));

document.getElementById('refreshLiveBtn').addEventListener('click', () => {
  loadAis();
  loadWarnings();
  loadMareographs();
  loadFmi();
  const c = map.getCenter();
  loadWeather(c.lat, c.lng, false);
});

// Presets
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const lat = Number(btn.dataset.lat);
    const lon = Number(btn.dataset.lon);
    const zoom = Number(btn.dataset.zoom);
    map.setView([lat, lon], zoom);
  });
});

// Sidebar collapse / expand
const sidebar = document.getElementById('sidebar');
const sidebarExpandBtn = document.getElementById('sidebarExpandBtn');

document.getElementById('sidebarToggleInside').addEventListener('click', () => {
  sidebar.classList.add('hidden');
  sidebarExpandBtn.classList.remove('hidden');
  setTimeout(() => map.invalidateSize(), 150);
});

sidebarExpandBtn.addEventListener('click', () => {
  sidebar.classList.remove('hidden');
  sidebarExpandBtn.classList.add('hidden');
  setTimeout(() => map.invalidateSize(), 150);
});

// Sidebar View Tabs (Route Planner vs Chart Layers)
const tabNavBtn = document.getElementById('tabNavBtn');
const tabLayersBtn = document.getElementById('tabLayersBtn');
const panelRoute = document.getElementById('panelRoute');
const panelLayers = document.getElementById('panelLayers');

function switchSidebarTab(target) {
  if (target === 'route') {
    tabNavBtn?.classList.add('active');
    tabNavBtn?.setAttribute('aria-selected', 'true');
    tabLayersBtn?.classList.remove('active');
    tabLayersBtn?.setAttribute('aria-selected', 'false');
    panelRoute?.classList.add('active');
    panelLayers?.classList.remove('active');
  } else {
    tabLayersBtn?.classList.add('active');
    tabLayersBtn?.setAttribute('aria-selected', 'true');
    tabNavBtn?.classList.remove('active');
    tabNavBtn?.setAttribute('aria-selected', 'false');
    panelLayers?.classList.add('active');
    panelRoute?.classList.remove('active');
  }
}

tabNavBtn?.addEventListener('click', () => switchSidebarTab('route'));
tabLayersBtn?.addEventListener('click', () => switchSidebarTab('layers'));
window.switchSidebarTab = switchSidebarTab;

// Weather Inspect & Forecast Drawer
let weatherInspectMode = false;
const weatherInspectBtn = document.getElementById('weatherInspectBtn');
const mapEl = document.getElementById('map');

weatherInspectBtn.addEventListener('click', () => {
  weatherInspectMode = !weatherInspectMode;
  if (weatherInspectMode && routePickMode) {
    setRoutePickMode(null);
  }
  weatherInspectBtn.classList.toggle('active', weatherInspectMode);
  mapEl.classList.toggle('inspect-cursor', weatherInspectMode || Boolean(routePickMode));
});

document.getElementById('weatherPill').addEventListener('click', () => {
  const drawer = document.getElementById('forecastDrawer');
  if (drawer.classList.contains('hidden')) {
    const c = map.getCenter();
    loadWeather(c.lat, c.lng, true);
  } else {
    drawer.classList.add('hidden');
  }
});

document.getElementById('closeForecastBtn').addEventListener('click', () => {
  document.getElementById('forecastDrawer').classList.add('hidden');
});

map.on('click', (e) => {
  if (weatherInspectMode) {
    loadWeather(e.latlng.lat, e.latlng.lng, true);
    weatherInspectMode = false;
    weatherInspectBtn.classList.remove('active');
    mapEl.classList.toggle('inspect-cursor', Boolean(routePickMode));
  } else if (routePickMode === 'start') {
    if (routeStart) pushRouteEditSnapshot();
    setRouteEndpoint('start', e.latlng.lat, e.latlng.lng);
    if (manualWaypoints && manualWaypoints.length >= 2) {
      manualWaypoints[0] = { ...routeStart };
    }
    if (!routeEnd) {
      setRoutePickMode('end');
    } else {
      setRoutePickMode(null);
      calculateRoute({ useManualWaypoints: Boolean(manualWaypoints && manualWaypoints.length >= 2) });
    }
  } else if (routePickMode === 'end') {
    if (routeEnd) pushRouteEditSnapshot();
    setRouteEndpoint('end', e.latlng.lat, e.latlng.lng);
    if (manualWaypoints && manualWaypoints.length >= 2) {
      manualWaypoints[manualWaypoints.length - 1] = { ...routeEnd };
    }
    setRoutePickMode(null);
    if (routeStart && routeEnd) {
      calculateRoute({ useManualWaypoints: Boolean(manualWaypoints && manualWaypoints.length >= 2) });
    }
  } else if (routePickMode === 'via') {
    pushRouteEditSnapshot();
    const newVia = {
      lat: Number(e.latlng.lat.toFixed(6)),
      lon: Number(e.latlng.lng.toFixed(6)),
    };
    let insertIdx = routeVias.length;
    const legs = lastComputedRoute?.legs || [];
    if (legs.length > 0) {
      const cosLat = Math.cos((newVia.lat * Math.PI) / 180);
      const px = newVia.lon * cosLat;
      const py = newVia.lat;
      let bestDistSq = Infinity;
      for (const leg of legs) {
        const ax = leg.from.lon * cosLat;
        const ay = leg.from.lat;
        const bx = leg.to.lon * cosLat;
        const by = leg.to.lat;
        const vx = bx - ax;
        const vy = by - ay;
        const lenSq = vx * vx + vy * vy;
        const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq)) : 0;
        const dx = px - (ax + t * vx);
        const dy = py - (ay + t * vy);
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          insertIdx = Math.min(routeVias.length, Math.max(0, Number(leg.from?.segIdx) || 0));
        }
      }
    }
    routeVias.splice(insertIdx, 0, newVia);
    manualWaypoints = null;
    setRoutePickMode(null);
    if (routeStart && routeEnd) {
      calculateRoute({ useManualWaypoints: false });
    } else {
      updateRouteButtons();
      setRouteStatus('Via-point added. Place Start (A) and Dest (B) to calculate route.');
    }
  } else if (routePickMode === 'manual_draw') {
    pushRouteEditSnapshot();
    if (!manualWaypoints) {
      manualWaypoints = [];
    }
    const newPt = {
      lat: Number(e.latlng.lat.toFixed(6)),
      lon: Number(e.latlng.lng.toFixed(6)),
    };
    manualWaypoints.push(newPt);
    routeStart = { ...manualWaypoints[0] };
    routeEnd = { ...manualWaypoints[manualWaypoints.length - 1] };

    if (manualWaypoints.length === 1) {
      setRouteEndpoint('start', newPt.lat, newPt.lon);
      setRouteStatus('Waypoint 1 (Start A) placed. Move cursor and click on chart to place Waypoint 2...');
    } else {
      setRouteEndpoint('end', newPt.lat, newPt.lon);
      setRouteStatus(
        `Manual Route: ${manualWaypoints.length} waypoints placed. Click to add next point, or click "Done" to finish.`
      );
      calculateRoute({ useManualWaypoints: true });
    }
    updateRouteButtons();
  }
});

map.on('dblclick', (e) => {
  if (isDrawingManual) {
    L.DomEvent.stopPropagation(e);
    stopDrawingManual(true);
  }
});

// Coordinate readout
const coordReadout = document.getElementById('coordReadout');
map.on('mousemove', (e) => {
  const { lat, lng } = e.latlng;
  if (coordReadout) {
    coordReadout.textContent = `${lat.toFixed(4)}° N, ${lng.toFixed(4)}° E · ${formatDdm(lat, 'N', 'S')}, ${formatDdm(lng, 'E', 'W')}`;
  }

  // Live rubberband line & distance/bearing tooltip while drawing manual route by hand
  if (isDrawingManual && manualWaypoints && manualWaypoints.length > 0) {
    const lastPt = manualWaypoints[manualWaypoints.length - 1];
    const lat1 = lastPt.lat, lon1 = lastPt.lon;
    const lat2 = e.latlng.lat, lon2 = e.latlng.lng;
    const cosLat = Math.cos((lat1 * Math.PI) / 180);
    const dx = (lon2 - lon1) * 111320 * cosLat;
    const dy = (lat2 - lat1) * 111132;
    const distM = Math.hypot(dx, dy);
    const distNm = distM / 1852;
    const bearing = Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360);

    const guideCoords = [[lat1, lon1], [lat2, lon2]];
    const tooltipText = `${distNm.toFixed(2)} NM · ${String(bearing).padStart(3, '0')}°`;

    if (!manualRubberbandLine) {
      manualRubberbandLine = L.polyline(guideCoords, {
        color: '#0891b2',
        weight: 2.5,
        dashArray: '5, 5',
        opacity: 0.85,
        interactive: false,
      }).addTo(map);
      manualRubberbandLine.bindTooltip(tooltipText, {
        permanent: true,
        direction: 'right',
        offset: [12, 0],
        className: 'rubberband-tooltip',
      });
    } else {
      manualRubberbandLine.setLatLngs(guideCoords);
      manualRubberbandLine.setTooltipContent(tooltipText);
    }
  } else {
    removeManualGuide();
  }
});

// Map move handlers
let weatherTimer = null;
map.on('moveend', () => {
  renderAisViewport();
  updateNearestMareographPill();
  scheduleOsmLoad();
  scheduleDepthLoad();
  clearTimeout(weatherTimer);
  weatherTimer = setTimeout(() => {
    const c = map.getCenter();
    if (
      Math.abs(c.lat - lastWeatherCoords.lat) > 0.08 ||
      Math.abs(c.lng - lastWeatherCoords.lng) > 0.08
    ) {
      loadWeather(c.lat, c.lng, false);
    }
  }, 600);
});

// Licenses Modal
const licensesModal = document.getElementById('licensesModal');
document.getElementById('licensesBtn').addEventListener('click', () => {
  licensesModal.classList.remove('hidden');
});
document.getElementById('closeLicensesBtn').addEventListener('click', () => {
  licensesModal.classList.add('hidden');
});
licensesModal.addEventListener('click', (e) => {
  if (e.target === licensesModal) {
    licensesModal.classList.add('hidden');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    licensesModal.classList.add('hidden');
    if (isDrawingManual) {
      stopDrawingManual(true);
    }
    if (routePickMode) {
      setRoutePickMode(null);
    }
    if (weatherInspectMode) {
      weatherInspectMode = false;
      weatherInspectBtn.classList.remove('active');
      mapEl.classList.remove('inspect-cursor');
    }
  }
});

// ---------------------------------------------------------------------------
// 12. Initial Load & Periodic Refresh
// ---------------------------------------------------------------------------
updateRouteSafeDepthBadge();
updateVaylaLayer();
loadAis();
loadWarnings();
loadMareographs();
loadFmi();
loadSeptit();
loadLipas();
loadOsmInView();
loadDepthInView();
loadWeather(INITIAL_CENTER[0], INITIAL_CENTER[1], false);

setInterval(loadAis, 30 * 1000);
setInterval(() => {
  loadWarnings();
  loadMareographs();
  loadFmi();
}, 5 * 60 * 1000);
