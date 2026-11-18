const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const USER_AGENT = 'LuotsiOpenMapViewer/1.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// In-memory TTL cache with in-flight request deduplication
const cache = new Map();
const inFlight = new Map();

/**
 * Fetch and cache a resource for ttlMs, coalescing concurrent callers.
 */
async function cachedFetch(key, ttlMs, fetcherFn) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.data;
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = (async () => {
    try {
      const data = await fetcherFn();
      cache.set(key, { data, expiresAt: Date.now() + ttlMs });
      return data;
    } catch (err) {
      if (entry) {
        console.warn(`Returning stale cache for ${key}: ${err.message}`);
        return entry.data;
      }
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

async function fetchJson(url, options = {}) {
  const maxAttempts = options.retries ?? 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.headers || {}),
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const isTransientSocket =
        err.name !== 'AbortError' &&
        (err.cause?.code === 'UND_ERR_SOCKET' ||
          err.cause?.code === 'ECONNRESET' ||
          err.message === 'terminated');
      if (attempt < maxAttempts && isTransientSocket) {
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 1. Septit.net pump-out stations (normalizes swapped [lat, lon] -> [lon, lat]).
 */
async function getSeptitData() {
  return cachedFetch('septit', 30 * 60 * 1000, async () => {
    const raw = await fetchJson('https://septit.net/septic.json');
    const features = (raw.features || []).map((f) => {
      const coords = f.geometry?.coordinates;
      let normalizedCoords = coords;
      if (Array.isArray(coords) && coords.length >= 2 && coords[0] > 50 && coords[1] < 40) {
        normalizedCoords = [coords[1], coords[0]];
      }
      return {
        ...f,
        geometry: {
          ...f.geometry,
          coordinates: normalizedCoords,
        },
      };
    });

    return {
      type: 'FeatureCollection',
      source: 'Septit.net',
      features,
    };
  });
}

/**
 * 2. Fintraffic / Digitraffic AIS vessel traffic.
 */
async function getAisData(bboxParam) {
  const headers = { 'Digitraffic-User': USER_AGENT };

  const [locations, vesselsMap] = await Promise.all([
    cachedFetch('ais_locations', 30 * 1000, () =>
      fetchJson('https://meri.digitraffic.fi/api/ais/v1/locations', { headers })
    ),
    cachedFetch('ais_vessels', 10 * 60 * 1000, async () => {
      const list = await fetchJson('https://meri.digitraffic.fi/api/ais/v1/vessels', { headers });
      const map = new Map();
      for (const v of list) {
        if (v && v.mmsi != null) {
          map.set(Number(v.mmsi), v);
        }
      }
      return map;
    }),
  ]);

  let minLon = 16;
  let minLat = 58;
  let maxLon = 32;
  let maxLat = 71;
  if (bboxParam) {
    const parts = bboxParam.split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      [minLon, minLat, maxLon, maxLat] = parts;
    }
  }

  const features = [];
  for (const f of locations.features || []) {
    const coords = f.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lon, lat] = coords;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;

    const p = f.properties || {};
    const mmsi = Number(f.mmsi ?? p.mmsi);
    const meta = vesselsMap.get(mmsi) || {};
    const name = (meta.name || '').trim() || `MMSI ${mmsi}`;

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        mmsi,
        name,
        callSign: (meta.callSign || '').trim() || null,
        destination: (meta.destination || '').trim() || null,
        draught: meta.draught ? Number((meta.draught / 10).toFixed(1)) : null,
        shipType: meta.shipType ?? null,
        imo: meta.imo || null,
        sog: p.sog ?? null,
        cog: p.cog ?? null,
        heading: p.heading != null && p.heading !== 511 ? p.heading : null,
        navStat: p.navStat ?? null,
        timestampExternal: p.timestampExternal ?? null,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    dataUpdatedTime: locations.dataUpdatedTime || new Date().toISOString(),
    features,
  };
}

/**
 * Extract primary [lon, lat] coordinate from a Lipas V2 item.
 */
function extractLipasCoords(item) {
  const feat = item.location?.geometries?.features?.[0];
  const geom = feat?.geometry;
  if (!geom || !geom.coordinates) return null;

  if (geom.type === 'Point') {
    return geom.coordinates;
  }
  if (geom.type === 'MultiPoint' || geom.type === 'LineString') {
    return Array.isArray(geom.coordinates[0]) ? geom.coordinates[0] : null;
  }
  if (geom.type === 'Polygon') {
    return Array.isArray(geom.coordinates[0]?.[0]) ? geom.coordinates[0][0] : null;
  }
  return null;
}

const LIPAS_CATEGORIES = {
  203: 'harbour',
  301: 'shelter',
  302: 'hut',
  206: 'campfire',
};

const TURKU_HARBOUR_SUPPLEMENTS = [
  {
    id: 'turku-guest-harbour',
    name: 'Turku Guest Harbour (Turun Vierasvenesatama)',
    typeCode: 203,
    category: 'harbour',
    city: 'Turku',
    address: 'Läntinen Rantakatu 57, 20100 Turku',
    www: 'https://www.turku.fi',
    comment: 'City of Turku guest marina along Aura River.',
    coords: [22.2446, 60.4408],
  },
  {
    id: 'turku-ruissalo-marina',
    name: 'Ruissalo Marina (Turun Pursiseura / Saaronniemi)',
    typeCode: 203,
    category: 'harbour',
    city: 'Turku',
    address: 'Ruissalon puistotie, 20100 Turku',
    www: 'https://www.turku.fi',
    comment: 'Turku recreational boating harbour in Ruissalo.',
    coords: [22.1489, 60.4272],
  },
  {
    id: 'turku-vepsa-harbour',
    name: 'Vepsä Island Excursion Harbour',
    typeCode: 203,
    category: 'harbour',
    city: 'Turku',
    address: 'Vepsä, Turku Archipelago',
    www: 'https://www.turku.fi',
    comment: 'City of Turku recreational island harbour and camping services.',
    coords: [22.0706, 60.3719],
  },
  {
    id: 'turku-maisaari-harbour',
    name: 'Maisaari Excursion Harbour',
    typeCode: 203,
    category: 'harbour',
    city: 'Rymättylä / Turku',
    address: 'Maisaari, Naantali / Turku recreation area',
    www: 'https://www.turku.fi',
    comment: 'Public archipelago harbour with sauna and campfire services.',
    coords: [21.9794, 60.3408],
  },
  {
    id: 'turku-pahkinainen-harbour',
    name: 'Pähkinäinen Excursion Harbour',
    typeCode: 203,
    category: 'harbour',
    city: 'Rymättylä / Turku',
    address: 'Pähkinäinen, Turku recreational area',
    www: 'https://www.turku.fi',
    comment: 'Archipelago harbour and nature trail stopover.',
    coords: [21.7414, 60.3009],
  },
  {
    id: 'turku-hirvensalo-harbour',
    name: 'Pikisaari / Hirvensalo Small Boat Harbour',
    typeCode: 203,
    category: 'harbour',
    city: 'Turku',
    address: 'Hirvensalo, Turku',
    www: 'https://www.turku.fi',
    comment: 'Municipal small boat harbour in Hirvensalo.',
    coords: [22.2225, 60.4234],
  },
];

async function fetchLipasTypePages(typeCode, maxPages = 6) {
  const pageSize = 100;
  const firstUrl = `https://api.lipas.fi/v2/sports-sites?type-codes=${typeCode}&page-size=${pageSize}&page=1`;
  const firstPage = await fetchJson(firstUrl);
  const items = [...(firstPage.items || [])];
  const totalPages = Math.min(firstPage.pagination?.['total-pages'] || 1, maxPages);

  if (totalPages > 1) {
    const restPromises = [];
    for (let p = 2; p <= totalPages; p++) {
      const url = `https://api.lipas.fi/v2/sports-sites?type-codes=${typeCode}&page-size=${pageSize}&page=${p}`;
      restPromises.push(fetchJson(url).catch(() => ({ items: [] })));
    }
    const restPages = await Promise.all(restPromises);
    for (const pageData of restPages) {
      if (Array.isArray(pageData.items)) {
        items.push(...pageData.items);
      }
    }
  }

  return items;
}

/**
 * 3. Lipas (JYU) harbours, shelters, huts, and campfire sites + Turku supplements.
 */
async function getLipasData() {
  return cachedFetch('lipas', 60 * 60 * 1000, async () => {
    const typeCodes = [203, 301, 302, 206];
    const results = await Promise.all(
      typeCodes.map((tc) => fetchLipasTypePages(tc, tc === 203 ? 14 : 6))
    );

    const features = [];
    const seenIds = new Set();

    results.forEach((items, idx) => {
      const tc = typeCodes[idx];
      const category = LIPAS_CATEGORIES[tc];
      for (const item of items) {
        if (item.status === 'out-of-service-permanently') continue;
        const coords = extractLipasCoords(item);
        if (!Array.isArray(coords) || coords.length < 2) continue;

        const id = `lipas-${item['lipas-id']}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [coords[0], coords[1]] },
          properties: {
            id,
            lipasId: item['lipas-id'],
            name: item.name || 'Unnamed site',
            typeCode: tc,
            category,
            city: item.location?.['postal-office'] || item.location?.city?.neighborhood || null,
            address: item.location?.address || null,
            www: item.properties?.www || null,
            comment: item.properties?.info || item.properties?.['info-fi'] || null,
            source: 'Lipas (JYU)',
          },
        });
      }
    });

    for (const sup of TURKU_HARBOUR_SUPPLEMENTS) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: sup.coords },
        properties: {
          id: sup.id,
          name: sup.name,
          typeCode: sup.typeCode,
          category: sup.category,
          city: sup.city,
          address: sup.address,
          www: sup.www,
          comment: sup.comment,
          source: 'Lipas (JYU) / City of Turku & Luotsi',
        },
      });
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  });
}

function parseNumericOrNull(val) {
  if (!val || val === 'NaN') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an FMI WFS multipointcoverage XML payload into the latest reading per station.
 */
function parseFmiMultipointCoverage(xml, fieldCount) {
  const stationNames = new Map();
  const pointRegex = /<gml:Point\b[^>]*>[\s\S]*?<gml:name>([^<]+)<\/gml:name>[\s\S]*?<gml:pos>\s*([0-9.-]+)\s+([0-9.-]+)\s*<\/gml:pos>[\s\S]*?<\/gml:Point>/g;
  let m;
  while ((m = pointRegex.exec(xml)) !== null) {
    const name = m[1].trim();
    const lat = Number(m[2]);
    const lon = Number(m[3]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      stationNames.set(key, { name, lat, lon });
    }
  }

  const posMatch = xml.match(/<gmlcov:positions>([\s\S]*?)<\/gmlcov:positions>/);
  const tupleMatch = xml.match(/<gml:doubleOrNilReasonTupleList>([\s\S]*?)<\/gml:doubleOrNilReasonTupleList>/);
  if (!posMatch || !tupleMatch) return [];

  const posTokens = posMatch[1].trim().split(/\s+/);
  const tupleTokens = tupleMatch[1].trim().split(/\s+/);
  const latestByStation = new Map();
  const numEntries = Math.min(
    Math.floor(posTokens.length / 3),
    Math.floor(tupleTokens.length / fieldCount)
  );

  for (let i = 0; i < numEntries; i++) {
    const lat = Number(posTokens[i * 3]);
    const lon = Number(posTokens[i * 3 + 1]);
    const ts = Number(posTokens[i * 3 + 2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(ts)) continue;

    const values = [];
    let hasValue = false;
    for (let f = 0; f < fieldCount; f++) {
      const v = parseNumericOrNull(tupleTokens[i * fieldCount + f]);
      values.push(v);
      if (v !== null) hasValue = true;
    }
    if (!hasValue) continue;

    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const existing = latestByStation.get(key);
    if (!existing || ts > existing.ts) {
      const meta = stationNames.get(key);
      latestByStation.set(key, {
        name: meta?.name || `FMI Station (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
        lat: meta?.lat ?? lat,
        lon: meta?.lon ?? lon,
        ts,
        values,
      });
    }
  }

  return Array.from(latestByStation.values());
}

/**
 * 4. FMI (Ilmatieteen laitos) WFS coastal & lake weather station observations.
 */
async function getFmiData() {
  return cachedFetch('fmi_observations', 5 * 60 * 1000, async () => {
    const starttime = new Date(Date.now() - 25 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const url =
      'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=GetFeature' +
      '&storedquery_id=fmi::observations::weather::multipointcoverage' +
      '&bbox=19,59,31,70' +
      `&starttime=${encodeURIComponent(starttime)}` +
      '&timestep=10&parameters=t2m,ws_10min,wg_10min,wd_10min,p_sea';

    const xml = await fetchText(url, { timeoutMs: 20000 });
    const stations = parseFmiMultipointCoverage(xml, 5);

    return {
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          name: s.name,
          timestamp: new Date(s.ts * 1000).toISOString(),
          t2m: s.values[0],
          ws: s.values[1],
          wg: s.values[2],
          wd: s.values[3],
          pressure: s.values[4],
        },
      })),
    };
  });
}

/**
 * 7. FMI Mareograph coastal sea level observations (WATLEV mm -> cm, N2000 mm -> cm, TW_PT1H_AVG C).
 */
async function getMareographData() {
  return cachedFetch('fmi_mareograph', 5 * 60 * 1000, async () => {
    const starttime = new Date(Date.now() - 45 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const url =
      'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=GetFeature' +
      '&storedquery_id=fmi::observations::mareograph::multipointcoverage' +
      `&starttime=${encodeURIComponent(starttime)}`;

    const xml = await fetchText(url, { timeoutMs: 20000 });
    const stations = parseFmiMultipointCoverage(xml, 3);

    return {
      type: 'FeatureCollection',
      features: stations.map((s) => {
        const watlevMm = s.values[0];
        const waterTemp = s.values[1];
        const n2000Mm = s.values[2];
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: {
            name: s.name,
            timestamp: new Date(s.ts * 1000).toISOString(),
            watlevCm: watlevMm !== null ? Number((watlevMm / 10).toFixed(1)) : null,
            n2000Cm: n2000Mm !== null ? Number((n2000Mm / 10).toFixed(1)) : null,
            waterTemp,
          },
        };
      }),
    };
  });
}

/**
 * 8. Fintraffic Digitraffic Aids-to-Navigation (ATON) faults / nautical warnings.
 */
async function getWarningsData() {
  return cachedFetch('aton_warnings', 5 * 60 * 1000, async () => {
    const raw = await fetchJson('https://meri.digitraffic.fi/api/aton/v1/faults', {
      headers: { 'Digitraffic-User': USER_AGENT },
    });

    const features = [];
    for (const f of raw.features || []) {
      const coords = f.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const p = f.properties || {};
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [coords[0], coords[1]] },
        properties: {
          id: p.id ?? null,
          type: p.type || 'Warning',
          state: p.state || 'Open',
          atonId: p.aton_id ?? null,
          name: p.aton_name_fi || p.aton_name_sv || `Seamark ${p.aton_id ?? ''}`.trim(),
          atonType: p.aton_type || null,
          fairway: p.fairway_name_fi || p.fairway_name_sv || null,
          area: p.area_description || null,
          timestamp: p.entry_timestamp || null,
        },
      });
    }

    return {
      type: 'FeatureCollection',
      lastUpdated: raw.lastUpdated || new Date().toISOString(),
      features,
    };
  });
}

function clampBbox(south, west, north, east, maxSpan = 2.5) {
  let s = south;
  let n = north;
  let w = west;
  let e = east;

  if (n - s > maxSpan) {
    const midLat = (s + n) / 2;
    s = midLat - maxSpan / 2;
    n = midLat + maxSpan / 2;
  }
  if (e - w > maxSpan) {
    const midLon = (w + e) / 2;
    w = midLon - maxSpan / 2;
    e = midLon + maxSpan / 2;
  }

  return [
    Number(s.toFixed(3)),
    Number(w.toFixed(3)),
    Number(n.toFixed(3)),
    Number(e.toFixed(3)),
  ];
}

/**
 * 5. OpenStreetMap boating POIs (ramps, marinas, fuel/services) via OSM Nominatim tag search.
 */
async function getOsmData(bboxParam) {
  const parts = (bboxParam || '60.0,24.7,60.3,25.2').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error('Invalid bbox parameter; expected south,west,north,east');
  }

  const [s, w, n, e] = clampBbox(parts[0], parts[1], parts[2], parts[3], 2.5);
  const cacheKey = `osm:${s.toFixed(2)},${w.toFixed(2)},${n.toFixed(2)},${e.toFixed(2)}`;

  return cachedFetch(cacheKey, 30 * 60 * 1000, async () => {
    const specs = [
      { q: '[leisure=slipway]', category: 'ramp', kindLabel: 'Boat Ramp (Slipway)' },
      { q: '[leisure=marina]', category: 'marina', kindLabel: 'Marina / Harbour' },
      { q: '[waterway=fuel]', category: 'service', kindLabel: 'Marine Fuel Station' },
    ];

    const features = [];
    const seenIds = new Set();

    for (const spec of specs) {
      const url =
        'https://nominatim.openstreetmap.org/search?format=jsonv2' +
        `&q=${encodeURIComponent(spec.q)}` +
        `&viewbox=${w},${n},${e},${s}&bounded=1&limit=40&extratags=1&namedetails=1`;

      const items = await fetchJson(url, {
        headers: { 'User-Agent': 'LuotsiMapViewer/1.0 (https://localhost)' },
        timeoutMs: 12000,
      });

      for (const item of items || []) {
        const lat = Number(item.lat);
        const lon = Number(item.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const id = `${item.osm_type}/${item.osm_id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            id,
            name:
              item.name ||
              item.namedetails?.name ||
              (item.display_name ? item.display_name.split(',')[0] : spec.kindLabel),
            category: spec.category,
            kindLabel: spec.kindLabel,
            operator: item.extratags?.operator || null,
            website: item.extratags?.website || item.extratags?.url || null,
            access: item.extratags?.access || null,
            fee: item.extratags?.fee || null,
            fuel: item.extratags?.fuel || null,
          },
        });
      }
    }

    return {
      type: 'FeatureCollection',
      bbox: [s, w, n, e],
      features,
    };
  });
}

/**
 * 5b. OpenSeaMap / OSM rocks, shoals, wrecks & obstructions (Persistent Store).
 */
const ROCKS_CACHE_FILE = path.join(__dirname, 'data', 'osm_rocks.json');
const osmRocksMap = new Map();
const osmFetchedTiles = new Set();
let rocksLastMtime = 0;

function reloadRocksFromDiskIfNeeded(force = false) {
  try {
    if (!fs.existsSync(ROCKS_CACHE_FILE)) return;
    const stat = fs.statSync(ROCKS_CACHE_FILE);
    if (!force && stat.mtimeMs <= rocksLastMtime) return;
    rocksLastMtime = stat.mtimeMs;
    const parsed = JSON.parse(fs.readFileSync(ROCKS_CACHE_FILE, 'utf8'));
    let newRocks = 0;
    if (Array.isArray(parsed.fetchedTiles)) {
      for (const t of parsed.fetchedTiles) osmFetchedTiles.add(t);
    }
    if (parsed.rocks && typeof parsed.rocks === 'object') {
      for (const [id, r] of Object.entries(parsed.rocks)) {
        if (!osmRocksMap.has(id)) newRocks++;
        osmRocksMap.set(id, r);
      }
    }
    console.log(`[Rocks] Loaded/Merged ${osmRocksMap.size} rocks (+${newRocks} new) and ${osmFetchedTiles.size} tiles from persistent storage`);
  } catch (err) {
    console.warn('[Rocks] Failed to load/reload disk cache:', err.message);
  }
}

let saveRocksTimeout = null;
function scheduleSaveRocks() {
  if (saveRocksTimeout) return;
  saveRocksTimeout = setTimeout(() => {
    saveRocksTimeout = null;
    try {
      const dataDir = path.dirname(ROCKS_CACHE_FILE);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      // Always merge disk contents before saving so external seeder additions are never clobbered
      if (fs.existsSync(ROCKS_CACHE_FILE)) {
        try {
          const diskData = JSON.parse(fs.readFileSync(ROCKS_CACHE_FILE, 'utf8'));
          if (Array.isArray(diskData.fetchedTiles)) {
            for (const t of diskData.fetchedTiles) osmFetchedTiles.add(t);
          }
          if (diskData.rocks && typeof diskData.rocks === 'object') {
            for (const [id, r] of Object.entries(diskData.rocks)) {
              if (!osmRocksMap.has(id)) osmRocksMap.set(id, r);
            }
          }
        } catch (_) { }
      }

      const obj = {
        fetchedTiles: Array.from(osmFetchedTiles),
        rocks: Object.fromEntries(osmRocksMap.entries()),
      };
      fs.writeFileSync(ROCKS_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
      const stat = fs.statSync(ROCKS_CACHE_FILE);
      rocksLastMtime = stat.mtimeMs;
      console.log(`[Rocks] Persisted ${osmRocksMap.size} rocks to ${ROCKS_CACHE_FILE}`);
    } catch (err) {
      console.warn('[Rocks] Failed to persist rocks:', err.message);
    }
  }, 2000);
}

reloadRocksFromDiskIfNeeded(true);

let isFetchingOsmTiles = false;
async function fetchTilesInBackground(tiles) {
  if (isFetchingOsmTiles) return;
  isFetchingOsmTiles = true;
  try {
    for (const t of tiles) {
      if (osmFetchedTiles.has(t.key)) continue;
      try {
        const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${t.w.toFixed(4)},${t.s.toFixed(4)},${t.e.toFixed(4)},${t.n.toFixed(4)}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'LuotsiMarineRouter/2.0 (contact: admin@luotsi.local)' },
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 429) {
          console.warn('[Rocks] OSM rate-limited (429), pausing tile downloads and using local cache.');
          break;
        }
        if (res.ok) {
          const xml = await res.text();

          // 1. Collect all node coordinates (including untagged nodes needed for way resolution)
          const nodeCoords = new Map();
          const allNodeRegex = /<node\s+([^>]+?)(\/?>)/g;
          let anm;
          while ((anm = allNodeRegex.exec(xml)) !== null) {
            const attrs = anm[1];
            const id = attrs.match(/id="(\d+)"/)?.[1];
            const lat = Number(attrs.match(/lat="([^"]+)"/)?.[1]);
            const lon = Number(attrs.match(/lon="([^"]+)"/)?.[1]);
            if (id && Number.isFinite(lat) && Number.isFinite(lon)) {
              nodeCoords.set(id, [lat, lon]);
            }
          }

          // 2. Parse tagged nodes for rocks, hazards, reefs, seamarks, and islets
          const nodeRegex = /<node\s+([^>]*[^\/])>([\s\S]*?)<\/node>/g;
          let m;
          while ((m = nodeRegex.exec(xml)) !== null) {
            const attrs = m[1];
            const body = m[2];
            if (
              body.includes('k="seamark:type" v="rock"') ||
              body.includes('k="natural" v="rock"') ||
              body.includes('k="natural" v="bare_rock"') ||
              body.includes('k="natural" v="reef"') ||
              body.includes('k="natural" v="shoal"') ||
              body.includes('k="place" v="islet"') ||
              body.includes('k="place" v="island"') ||
              body.includes('k="seamark:type" v="obstruction"') ||
              body.includes('k="seamark:type" v="wreck"') ||
              body.includes('k="seamark:rock:water_level"') ||
              body.includes('k="mml:class" v="38511"') ||
              body.includes('k="mml:class" v="38512"') ||
              body.includes('k="mml:class" v="38513"')
            ) {
              const id = attrs.match(/id="(\d+)"/)?.[1];
              const lat = Number(attrs.match(/lat="([^"]+)"/)?.[1]);
              const lon = Number(attrs.match(/lon="([^"]+)"/)?.[1]);
              if (id && Number.isFinite(lat) && Number.isFinite(lon)) {
                const waterLevel =
                  body.match(/k="seamark:rock:water_level"\s+v="([^"]+)"/)?.[1] ||
                  (body.includes('v="38511"')
                    ? 'submerged'
                    : body.includes('v="38512"')
                      ? 'awash'
                      : body.includes('v="38513"') || body.includes('v="bare_rock"') || body.includes('v="islet"')
                        ? 'always_dry'
                        : 'submerged');
                const seamarkType =
                  body.match(/k="seamark:type"\s+v="([^"]+)"/)?.[1] ||
                  (body.includes('v="islet"')
                    ? 'islet'
                    : body.includes('v="bare_rock"')
                      ? 'bare_rock'
                      : body.includes('v="wreck"')
                        ? 'wreck'
                        : body.includes('v="reef"')
                          ? 'reef'
                          : body.includes('v="shoal"')
                            ? 'shoal'
                            : 'rock');
                osmRocksMap.set(id, { id, lat, lon, waterLevel, type: seamarkType });
              }
            }
          }

          // 3. Parse ways for islets, bare rocks, reefs, shoals, and marine hazards
          const wayRegex = /<way\s+([^>]*[^\/])>([\s\S]*?)<\/way>/g;
          let wm;
          while ((wm = wayRegex.exec(xml)) !== null) {
            const attrs = wm[1];
            const body = wm[2];
            if (
              body.includes('k="natural" v="bare_rock"') ||
              body.includes('k="natural" v="rock"') ||
              body.includes('k="natural" v="reef"') ||
              body.includes('k="natural" v="shoal"') ||
              body.includes('k="place" v="islet"') ||
              body.includes('k="seamark:type" v="rock"') ||
              body.includes('k="seamark:type" v="obstruction"') ||
              body.includes('k="seamark:type" v="wreck"') ||
              body.includes('k="seamark:rock:water_level"') ||
              body.includes('k="mml:class" v="38511"') ||
              body.includes('k="mml:class" v="38512"') ||
              body.includes('k="mml:class" v="38513"') ||
              (body.includes('k="natural" v="coastline"') && body.includes('k="place" v="islet"'))
            ) {
              const wayId = attrs.match(/id="(\d+)"/)?.[1];
              if (!wayId) continue;
              const ndRegex = /<nd\s+ref="(\d+)"/g;
              let ndm;
              const wayPoints = [];
              while ((ndm = ndRegex.exec(body)) !== null) {
                const pt = nodeCoords.get(ndm[1]);
                if (pt) {
                  wayPoints.push({ id: ndm[1], lat: pt[0], lon: pt[1] });
                }
              }
              if (wayPoints.length > 0) {
                let sumLat = 0;
                let sumLon = 0;
                for (const p of wayPoints) {
                  sumLat += p.lat;
                  sumLon += p.lon;
                }
                const avgLat = sumLat / wayPoints.length;
                const avgLon = sumLon / wayPoints.length;
                const isDry =
                  body.includes('v="islet"') ||
                  body.includes('v="bare_rock"') ||
                  body.includes('v="38513"') ||
                  body.includes('v="always_dry"');
                const isAwash = body.includes('v="38512"') || body.includes('v="awash"');
                const waterLevel =
                  body.match(/k="seamark:rock:water_level"\s+v="([^"]+)"/)?.[1] ||
                  (isDry ? 'always_dry' : isAwash ? 'awash' : 'submerged');
                const seamarkType =
                  body.match(/k="seamark:type"\s+v="([^"]+)"/)?.[1] ||
                  (body.includes('v="islet"')
                    ? 'islet'
                    : body.includes('v="bare_rock"')
                      ? 'bare_rock'
                      : body.includes('v="wreck"')
                        ? 'wreck'
                        : body.includes('v="reef"')
                          ? 'reef'
                          : body.includes('v="shoal"')
                            ? 'shoal'
                            : 'rock');

                const wayNodes = wayPoints.map((p) => [p.lat, p.lon]);
                osmRocksMap.set('w' + wayId, {
                  id: 'w' + wayId,
                  lat: avgLat,
                  lon: avgLon,
                  waterLevel,
                  type: seamarkType,
                  nodes: wayNodes,
                });

                // Also index perimeter nodes so the physical boundary is protected
                const step = wayPoints.length > 30 ? 2 : 1;
                for (let i = 0; i < wayPoints.length; i += step) {
                  const p = wayPoints[i];
                  osmRocksMap.set(p.id, {
                    id: p.id,
                    lat: p.lat,
                    lon: p.lon,
                    waterLevel,
                    type: seamarkType,
                  });
                }
              }
            }
          }

          osmFetchedTiles.add(t.key);
          scheduleSaveRocks();
        }
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.warn(`[Rocks] Tile ${t.key} fetch error: ${err.message}`);
      }
    }
  } finally {
    isFetchingOsmTiles = false;
  }
}

async function getOsmRocksData(bboxParam) {
  reloadRocksFromDiskIfNeeded();
  const parts = (bboxParam || '60.0,24.7,60.3,25.2').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    return { bbox: [60.0, 24.7, 60.3, 25.2], features: [] };
  }

  const [s, w, n, e] = clampBbox(parts[0], parts[1], parts[2], parts[3], 8.0);

  const tileStep = 0.02; // ~1.2 km safe tile step
  const tilesToFetch = [];
  const sTile = Math.floor(s / tileStep) * tileStep;
  const wTile = Math.floor(w / tileStep) * tileStep;
  for (let lat = sTile; lat < n; lat += tileStep) {
    for (let lon = wTile; lon < e; lon += tileStep) {
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (!osmFetchedTiles.has(key)) {
        tilesToFetch.push({
          key,
          s: lat,
          w: lon,
          n: lat + tileStep,
          e: lon + tileStep,
        });
      }
    }
  }

  // Fetch missing tiles in background so route requests are never blocked (capped at 50 tiles per batch)
  if (tilesToFetch.length > 0 && !isFetchingOsmTiles) {
    fetchTilesInBackground(tilesToFetch.slice(0, 50)).catch((err) => {
      console.warn('[Rocks] Background fetch error:', err.message);
    });
  }

  // Return all rocks within [s, w, n, e] from in-memory map
  const features = [];
  for (const r of osmRocksMap.values()) {
    if (r.lat >= s && r.lat <= n && r.lon >= w && r.lon <= e) {
      features.push(r);
    }
  }

  return {
    bbox: [s, w, n, e],
    features,
  };
}

/**
 * 6. Open-Meteo marine/coastal weather & 48h forecast for any coordinate.
 */
async function getWeatherData(latParam, lonParam) {
  const lat = Number.isFinite(Number(latParam)) ? Number(latParam) : 60.15;
  const lon = Number.isFinite(Number(lonParam)) ? Number(lonParam) : 24.95;
  const rLat = lat.toFixed(2);
  const rLon = lon.toFixed(2);

  return cachedFetch(`weather:${rLat},${rLon}`, 10 * 60 * 1000, async () => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${rLat}&longitude=${rLon}` +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,weather_code' +
      '&hourly=temperature_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation_probability' +
      '&wind_speed_unit=ms&forecast_days=2&timezone=Europe%2FHelsinki';
    return fetchJson(url);
  });
}

/**
 * 9. Traficom WFS vector depth data (DepthContour_L, DepthArea_A, Sounding_P).
 */
async function getDepthData(bboxParam, maxSpan = 0.35) {
  const parts = (bboxParam || '60.11,24.90,60.17,25.02').split(',').map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite)) {
    throw new Error('Invalid bbox parameter; expected south,west,north,east');
  }

  const [s, w, n, e] = clampBbox(parts[0], parts[1], parts[2], parts[3], maxSpan);
  const cacheKey = `depth:${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)}`;

  return cachedFetch(cacheKey, 15 * 60 * 1000, async () => {
    const base =
      'https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs' +
      '?service=WFS&version=2.0.0&request=GetFeature' +
      '&outputFormat=application/json&srsName=EPSG:4326' +
      `&bbox=${w},${s},${e},${n},EPSG:4326`;

    const [contours, areas, soundings] = await Promise.all([
      fetchJson(`${base}&typeNames=rajoitettu:DepthContour_L&count=2000`, { timeoutMs: 20000 }),
      fetchJson(`${base}&typeNames=rajoitettu:DepthArea_A&count=800`, { timeoutMs: 20000 }),
      fetchJson(`${base}&typeNames=rajoitettu:Sounding_P&count=400`, { timeoutMs: 20000 }),
    ]);

    return {
      bbox: [s, w, n, e],
      contours: contours.features || [],
      areas: areas.features || [],
      soundings: soundings.features || [],
    };
  });
}

// ---------------------------------------------------------------------------
// 10. Automatic Marine Route Planner (Traficom Depth + Väylävirasto Fairways & Marks)
// ---------------------------------------------------------------------------
const SEAMARK_ROLES = {
  1: { role: 'lateral-port', label: 'Port Lateral Mark (Red)', short: 'PORT' },
  2: { role: 'lateral-starboard', label: 'Starboard Lateral Mark (Green)', short: 'STBD' },
  3: { role: 'cardinal-N', label: 'North Cardinal Mark (Pass North)', short: 'CARD-N', safeDir: 'N' },
  4: { role: 'cardinal-S', label: 'South Cardinal Mark (Pass South)', short: 'CARD-S', safeDir: 'S' },
  5: { role: 'cardinal-W', label: 'West Cardinal Mark (Pass West)', short: 'CARD-W', safeDir: 'W' },
  6: { role: 'cardinal-E', label: 'East Cardinal Mark (Pass East)', short: 'CARD-E', safeDir: 'E' },
  7: { role: 'danger', label: 'Isolated Danger Mark', short: 'DANGER' },
  8: { role: 'safe-water', label: 'Safe Water Mark', short: 'SAFE' },
  9: { role: 'special', label: 'Special Mark', short: 'SPEC' },
};

function classifySeamark(feature) {
  const p = feature?.properties || {};
  const code = Number(p.navigointilajikoodi);
  if (SEAMARK_ROLES[code]) {
    return SEAMARK_ROLES[code];
  }
  return {
    role: 'beacon',
    label: p.turvalaitetyyppifi || 'Navigation Mark',
    short: 'MARK',
  };
}

function extractPointCoords(geom) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type === 'Point' && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    return geom.coordinates;
  }
  if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates[0]) && geom.coordinates[0].length >= 2) {
    return geom.coordinates[0];
  }
  return null;
}

function extractLineStrings(geom) {
  if (!geom || !geom.coordinates) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    return geom.geometries.flatMap(extractLineStrings);
  }
  return [];
}

function extractPolygons(geom) {
  if (!geom || !geom.coordinates) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    return geom.geometries.flatMap(extractPolygons);
  }
  return [];
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const ccw = (p1x, p1y, p2x, p2y, p3x, p3y) =>
    (p3y - p1y) * (p2x - p1x) > (p2y - p1y) * (p3x - p1x);
  const d1 = ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy);
  const d2 = ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy);
  return d1 && d2;
}

function segmentToSegmentDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (
    Math.max(ax, bx) < Math.min(cx, dx) - 0.1 ||
    Math.min(ax, bx) > Math.max(cx, dx) + 0.1 ||
    Math.max(ay, by) < Math.min(cy, dy) - 0.1 ||
    Math.min(ay, by) > Math.max(cy, dy) + 0.1
  ) {
    // Skip exact intersection check when bounding boxes are separated, still measure endpoints below
  } else if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
    return 0;
  }
  return Math.min(
    pointToSegmentDist(ax, ay, cx, cy, dx, dy),
    pointToSegmentDist(bx, by, cx, cy, dx, dy),
    pointToSegmentDist(cx, cy, ax, ay, bx, by),
    pointToSegmentDist(dx, dy, ax, ay, bx, by)
  );
}

function buildRingYSlabs(ring, minY, maxY) {
  if (!ring || ring.length < 20 || maxY <= minY + 1e-6) return;
  const count = Math.min(256, Math.max(16, ring.length >> 2));
  const invSlabH = count / (maxY - minY);
  const buckets = Array.from({ length: count }, () => []);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi === yj) continue;
    const y0 = yi < yj ? yi : yj;
    const y1 = yi > yj ? yi : yj;
    let s0 = Math.floor((y0 - minY) * invSlabH);
    let s1 = Math.floor((y1 - minY) * invSlabH);
    if (s0 < 0) s0 = 0;
    else if (s0 >= count) s0 = count - 1;
    if (s1 < 0) s1 = 0;
    else if (s1 >= count) s1 = count - 1;
    for (let s = s0; s <= s1; s++) {
      buckets[s].push(xi, yi, xj, yj);
    }
  }
  ring._slabs = { minY, maxY, count, invSlabH, buckets };
}

function pointInRing(px, py, ring) {
  let inside = false;
  const slabs = ring._slabs;
  if (slabs) {
    if (py < slabs.minY || py > slabs.maxY) return false;
    let s = Math.floor((py - slabs.minY) * slabs.invSlabH);
    if (s < 0) s = 0;
    else if (s >= slabs.count) s = slabs.count - 1;
    const b = slabs.buckets[s];
    for (let k = 0, len = b.length; k < len; k += 4) {
      const xi = b[k];
      const yi = b[k + 1];
      const xj = b[k + 2];
      const yj = b[k + 3];
      const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonItem(px, py, areaItem) {
  const outerBox = areaItem.ringBoxes[0];
  if (px < outerBox[0] || px > outerBox[2] || py < outerBox[1] || py > outerBox[3]) {
    return false;
  }
  if (!pointInRing(px, py, areaItem.ringsXY[0])) return false;
  for (let r = 1; r < areaItem.ringsXY.length; r++) {
    const hb = areaItem.ringBoxes[r];
    if (px >= hb[0] && px <= hb[2] && py >= hb[1] && py <= hb[3]) {
      if (pointInRing(px, py, areaItem.ringsXY[r])) return false;
    }
  }
  return true;
}

function parseFairwayDepth(p) {
  if (!p) return null;
  if (p.haraussyvyys != null && Number.isFinite(Number(p.haraussyvyys))) {
    return Number(p.haraussyvyys);
  }
  if (p.mitoitussyvays != null && Number.isFinite(Number(p.mitoitussyvays))) {
    return Number(p.mitoitussyvays);
  }
  return null;
}

function formatFairwayName(p) {
  if (!p) return null;
  if (p.nimifi) return p.jnro ? `${p.jnro}: ${p.nimifi}` : p.nimifi;
  if (p.vaylan_nimi) {
    const match = String(p.vaylan_nimi).match(/^\[([^\]]+)\]/);
    return match ? match[1] : String(p.vaylan_nimi);
  }
  return p.jnro ? `Fairway ${p.jnro}` : null;
}

function makeSpatialBucketIndex(cellSize = 350) {
  const buckets = new Map();
  let nextId = 0;
  let seenStamp = new Int32Array(256);
  let queryTag = 0;

  const cellKey = (gx, gy) => ((gx + 32768) << 16) | ((gy + 32768) & 0xffff);

  function add(item, minX, minY, maxX, maxY) {
    const id = nextId++;
    item._sid = id;
    if (id >= seenStamp.length) {
      const nextStamp = new Int32Array(seenStamp.length * 2);
      nextStamp.set(seenStamp);
      seenStamp = nextStamp;
    }
    item.minX = minX;
    item.minY = minY;
    item.maxX = maxX;
    item.maxY = maxY;
    const x0 = Math.floor(minX / cellSize);
    const x1 = Math.floor(maxX / cellSize);
    const y0 = Math.floor(minY / cellSize);
    const y1 = Math.floor(maxY / cellSize);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = cellKey(gx, gy);
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(item);
      }
    }
  }

  function query(minX, minY, maxX, maxY) {
    const x0 = Math.floor(minX / cellSize);
    const x1 = Math.floor(maxX / cellSize);
    const y0 = Math.floor(minY / cellSize);
    const y1 = Math.floor(maxY / cellSize);
    if (x0 === x1 && y0 === y1) {
      const list = buckets.get(cellKey(x0, y0));
      if (!list) return [];
      const results = [];
      for (let i = 0, len = list.length; i < len; i++) {
        const item = list[i];
        if (item.maxX < minX || item.minX > maxX || item.maxY < minY || item.minY > maxY) {
          continue;
        }
        results.push(item);
      }
      return results;
    }
    const results = [];
    queryTag = (queryTag + 1) | 0;
    if (queryTag <= 0) {
      seenStamp.fill(0);
      queryTag = 1;
    }
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const list = buckets.get(cellKey(gx, gy));
        if (!list) continue;
        for (let i = 0, len = list.length; i < len; i++) {
          const item = list[i];
          if (seenStamp[item._sid] === queryTag) continue;
          seenStamp[item._sid] = queryTag;
          if (item.maxX < minX || item.minX > maxX || item.maxY < minY || item.minY > maxY) {
            continue;
          }
          results.push(item);
        }
      }
    }
    return results;
  }

  return { add, query };
}

const recentCorridors = [];

async function fetchRouteCorridorData(bbox) {
  const [s, w, n, e] = clampBbox(bbox[0], bbox[1], bbox[2], bbox[3], 8.0);
  const now = Date.now();
  for (let i = recentCorridors.length - 1; i >= 0; i--) {
    const c = recentCorridors[i];
    if (c.expiresAt <= now) {
      recentCorridors.splice(i, 1);
      continue;
    }
    if (
      c.bbox[0] <= s &&
      c.bbox[1] <= w &&
      c.bbox[2] >= n &&
      c.bbox[3] >= e &&
      c.bbox[2] - c.bbox[0] <= n - s + 0.08 &&
      c.bbox[3] - c.bbox[1] <= e - w + 0.12
    ) {
      return { ...c.data, bbox: [s, w, n, e] };
    }
  }

  const key = `vayla_route:${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)}`;

  const [vaylaData, depthData, warningsData, osmRocksData] = await Promise.all([
    cachedFetch(key, 15 * 60 * 1000, async () => {
      const base =
        'https://avoinapi.vaylapilvi.fi/vaylatiedot/ows' +
        '?service=WFS&version=2.0.0&request=GetFeature' +
        '&outputFormat=application/json&srsName=EPSG:4326' +
        `&bbox=${w},${s},${e},${n},EPSG:4326`;

      const [navLines, fairways, seamarks] = await Promise.all([
        fetchJson(`${base}&typeNames=vesivaylatiedot:navigointilinjat_uusi&count=5000`, { timeoutMs: 30000 }),
        fetchJson(`${base}&typeNames=vesivaylatiedot:vaylat_uusi&count=2000`, { timeoutMs: 30000 }),
        fetchJson(`${base}&typeNames=vesivaylatiedot:turvalaitteet_uusi&count=5000`, { timeoutMs: 30000 }),
      ]);

      return {
        navLines: navLines.features || [],
        fairways: fairways.features || [],
        seamarks: seamarks.features || [],
      };
    }),
    getDepthData(`${s},${w},${n},${e}`, 8.0),
    getWarningsData().catch(() => ({ features: [] })),
    getOsmRocksData(`${s},${w},${n},${e}`).catch(() => ({ features: [] })),
  ]);

  const result = {
    bbox: [s, w, n, e],
    ...vaylaData,
    ...depthData,
    warnings: warningsData.features || [],
    rocks: osmRocksData.features || [],
  };
  recentCorridors.push({
    bbox: [s, w, n, e],
    expiresAt: Date.now() + 5 * 60 * 1000,
    data: result,
  });
  if (recentCorridors.length > 12) {
    recentCorridors.shift();
  }
  return result;
}

const spatialIndexCache = new Map();
const shorelineCache = new Map();
const rockCache = new Map();

function buildSpatialIndex(data, project, effectiveSafeDepth) {
  const contourIndex = makeSpatialBucketIndex(350);
  const waterAreaIndex = makeSpatialBucketIndex(450);
  const soundingIndex = makeSpatialBucketIndex(300);
  const fairwayIndex = makeSpatialBucketIndex(350);
  const seamarkIndex = makeSpatialBucketIndex(350);

  const shallowContours = [];
  const allContours = [];
  const allWaterAreas = [];
  const shallowAreas = [];
  const shallowSoundings = [];
  const safeFairways = [];
  const unsafeFairways = [];
  const allSeamarks = [];

  // Index faulty ATON IDs & coordinates from Digitraffic
  const faultyAtonIds = new Set();
  const faultyPoints = [];
  for (const wf of data.warnings || []) {
    const p = wf.properties || {};
    if (p.atonId != null) faultyAtonIds.add(String(p.atonId));
    const c = wf.geometry?.coordinates;
    if (Array.isArray(c) && c.length >= 2) {
      const [fx, fy] = project.toXY(c[1], c[0]);
      faultyPoints.push({ x: fx, y: fy, type: p.type || 'Fault' });
    }
  }

  for (const f of data.contours || []) {
    const depth = Number(f.properties?.VALDCO);
    if (!Number.isFinite(depth)) continue;
    const isShallow = depth <= effectiveSafeDepth;
    for (const line of extractLineStrings(f.geometry)) {
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = project.toXY(line[i][1], line[i][0]);
        const [bx, by] = project.toXY(line[i + 1][1], line[i + 1][0]);
        const seg = { ax, ay, bx, by, depth, isShallow };
        allContours.push(seg);
        if (isShallow) {
          shallowContours.push(seg);
          contourIndex.add(seg, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
        }
      }
    }
  }

  for (const f of data.areas || []) {
    const drval1 = Number(f.properties?.DRVAL1 ?? 0);
    const drval2 = Number(f.properties?.DRVAL2 ?? 999);
    const isShallow = drval2 <= effectiveSafeDepth || (drval1 === 0 && drval2 <= effectiveSafeDepth);

    for (const poly of extractPolygons(f.geometry)) {
      const ringsXY = poly.map((ring) => ring.map((pt) => project.toXY(pt[1], pt[0])));
      if (!ringsXY.length || ringsXY[0].length < 3) continue;
      const ringBoxes = ringsXY.map((ring, r) => {
        let rMinX = Infinity;
        let rMinY = Infinity;
        let rMaxX = -Infinity;
        let rMaxY = -Infinity;
        for (const [px, py] of ring) {
          if (px < rMinX) rMinX = px;
          if (py < rMinY) rMinY = py;
          if (px > rMaxX) rMaxX = px;
          if (py > rMaxY) rMaxY = py;
        }
        buildRingYSlabs(ringsXY[r], rMinY, rMaxY);
        return [rMinX, rMinY, rMaxX, rMaxY];
      });
      const outer = ringBoxes[0];
      const areaItem = { ringsXY, ringBoxes, drval1, drval2, isShallow };
      allWaterAreas.push(areaItem);
      if (isShallow) shallowAreas.push(areaItem);
      waterAreaIndex.add(areaItem, outer[0], outer[1], outer[2], outer[3]);
    }
  }

  let hasClipBox = false;
  let clipMinX = -Infinity;
  let clipMaxX = Infinity;
  let clipMinY = -Infinity;
  let clipMaxY = Infinity;
  let bMinX = 0;
  let bMinY = 0;
  if (Array.isArray(data.bbox) && data.bbox.length === 4) {
    [bMinX, bMinY] = project.toXY(data.bbox[0], data.bbox[1]);
    const [bMaxX, bMaxY] = project.toXY(data.bbox[2], data.bbox[3]);
    clipMinX = Math.min(bMinX, bMaxX) + 30;
    clipMaxX = Math.max(bMinX, bMaxX) - 30;
    clipMinY = Math.min(bMinY, bMaxY) + 30;
    clipMaxY = Math.max(bMinY, bMaxY) - 30;
    hasClipBox = clipMaxX > clipMinX && clipMaxY > clipMinY;
  }

  const shoreKey = Array.isArray(data.bbox)
    ? `${data.bbox.join(',')}|n=${allWaterAreas.length}|xy=${Math.round(bMinX)},${Math.round(bMinY)}|rocks=${(data.rocks || []).length}`
    : null;
  let shorelineIndex;
  let shorelineSegments;
  const cachedShore = shoreKey ? shorelineCache.get(shoreKey) : null;
  if (cachedShore) {
    shorelineCache.delete(shoreKey);
    shorelineCache.set(shoreKey, cachedShore);
    shorelineIndex = cachedShore.shorelineIndex;
    shorelineSegments = cachedShore.shorelineSegments;
  } else {
    shorelineIndex = makeSpatialBucketIndex(350);
    shorelineSegments = [];
    let lastCellX = NaN;
    let lastCellY = NaN;
    let lastCand = null;

    for (let ai = 0, aLen = allWaterAreas.length; ai < aLen; ai++) {
      const a = allWaterAreas[ai];
      for (let r = 0, rLen = a.ringsXY.length; r < rLen; r++) {
        if (r === 0 && a.drval1 > 0) continue;
        const ring = a.ringsXY[r];
        for (let i = 0, nPts = ring.length; i < nPts; i++) {
          const j = i + 1 < nPts ? i + 1 : 0;
          const ax = ring[i][0];
          const ay = ring[i][1];
          const bx = ring[j][0];
          const by = ring[j][1];
          const mx = (ax + bx) * 0.5;
          const my = (ay + by) * 0.5;
          if (hasClipBox && (mx < clipMinX || mx > clipMaxX || my < clipMinY || my > clipMaxY)) {
            continue;
          }
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.hypot(dx, dy);
          if (len < 2.0) continue;
          const nx = -dy / len;
          const ny = dx / len;
          const cx = Math.floor(mx / 120);
          const cy = Math.floor(my / 120);
          if (cx !== lastCellX || cy !== lastCellY) {
            lastCellX = cx;
            lastCellY = cy;
            lastCand = waterAreaIndex.query(
              cx * 120 - 6,
              cy * 120 - 6,
              (cx + 1) * 120 + 6,
              (cy + 1) * 120 + 6
            );
          }
          const cand = lastCand;
          const isLandEdge =
            checkWaterAtPoint(mx + nx * 1.5, my + ny * 1.5, cand) === 'land' ||
            checkWaterAtPoint(mx - nx * 1.5, my - ny * 1.5, cand) === 'land';
          if (isLandEdge) {
            const minX = ax < bx ? ax : bx;
            const minY = ay < by ? ay : by;
            const maxX = ax > bx ? ax : bx;
            const maxY = ay > by ? ay : by;
            const seg = { ax, ay, bx, by, minX, minY, maxX, maxY };
            shorelineSegments.push(seg);
            shorelineIndex.add(seg, minX, minY, maxX, maxY);
          }
        }
      }
    }

    // Inject above-water rocks, bare rocks, and islets so shoreMarginM protects against them
    const octRadius = 12; // 12-meter radius for emergent rocks / islets
    const octCos = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
    const octSin = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];
    for (const r of data.rocks || []) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const isDry = r.waterLevel === 'always_dry' || r.type === 'bare_rock' || r.type === 'islet';
      if (!isDry) continue;
      if (Array.isArray(r.nodes) && r.nodes.length >= 2) {
        for (let i = 0; i < r.nodes.length - 1; i++) {
          const [ax, ay] = project.toXY(r.nodes[i][0], r.nodes[i][1]);
          const [bx, by] = project.toXY(r.nodes[i + 1][0], r.nodes[i + 1][1]);
          const minX = ax < bx ? ax : bx;
          const minY = ay < by ? ay : by;
          const maxX = ax > bx ? ax : bx;
          const maxY = ay > by ? ay : by;
          const seg = { ax, ay, bx, by, minX, minY, maxX, maxY };
          shorelineSegments.push(seg);
          shorelineIndex.add(seg, minX, minY, maxX, maxY);
        }
      } else {
        const [rx, ry] = project.toXY(r.lat, r.lon);
        for (let i = 0; i < 8; i++) {
          const j = (i + 1) % 8;
          const ax = rx + octRadius * octCos[i];
          const ay = ry + octRadius * octSin[i];
          const bx = rx + octRadius * octCos[j];
          const by = ry + octRadius * octSin[j];
          const minX = ax < bx ? ax : bx;
          const minY = ay < by ? ay : by;
          const maxX = ax > bx ? ax : bx;
          const maxY = ay > by ? ay : by;
          const seg = { ax, ay, bx, by, minX, minY, maxX, maxY };
          shorelineSegments.push(seg);
          shorelineIndex.add(seg, minX, minY, maxX, maxY);
        }
      }
    }

    if (shoreKey) {
      if (shorelineCache.size >= 20) {
        const oldestKey = shorelineCache.keys().next().value;
        shorelineCache.delete(oldestKey);
      }
      shorelineCache.set(shoreKey, { shorelineIndex, shorelineSegments });
    }
  }

  for (const f of data.soundings || []) {
    const depth = Number(f.properties?.DEPTH);
    if (!Number.isFinite(depth)) continue;
    const coords = extractPointCoords(f.geometry);
    if (!coords) continue;
    const [x, y] = project.toXY(coords[1], coords[0]);
    if (depth <= effectiveSafeDepth) {
      const sItem = { x, y, depth };
      shallowSoundings.push(sItem);
      soundingIndex.add(sItem, x, y, x, y);
    }
  }

  const knownDepthByJnro = new Map();
  for (const f of [...(data.navLines || []), ...(data.fairways || [])]) {
    const p = f?.properties || {};
    if (p.jnro == null) continue;
    const d = parseFairwayDepth(p);
    if (d !== null) {
      const jKey = String(p.jnro);
      const prev = knownDepthByJnro.get(jKey);
      if (prev === undefined || d > prev) knownDepthByJnro.set(jKey, d);
    }
  }

  const processFairwayFeature = (f, priority) => {
    const p = f.properties || {};
    const rawDepth = parseFairwayDepth(p);
    const fDepth =
      rawDepth !== null
        ? rawDepth
        : p.jnro != null
          ? (knownDepthByJnro.get(String(p.jnro)) ?? null)
          : null;
    const fName = formatFairwayName(p);
    const verifiedDepth = fDepth !== null && fDepth >= effectiveSafeDepth;
    const shallowFairway = fDepth !== null && fDepth < effectiveSafeDepth;
    for (const line of extractLineStrings(f.geometry)) {
      const ptsXY = line.map((pt) => project.toXY(pt[1], pt[0]));
      for (let i = 0; i < ptsXY.length - 1; i++) {
        const [ax, ay] = ptsXY[i];
        const [bx, by] = ptsXY[i + 1];
        const seg = {
          ax,
          ay,
          bx,
          by,
          fairwayDepth: fDepth,
          verifiedDepth,
          shallowFairway,
          name: fName,
          isSafe: !shallowFairway,
          priority,
        };
        safeFairways.push(seg);
        fairwayIndex.add(seg, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
        if (shallowFairway) {
          unsafeFairways.push(seg);
        }
      }
    }
  };

  for (const f of data.navLines || []) processFairwayFeature(f, 2);
  for (const f of data.fairways || []) processFairwayFeature(f, 1);

  for (const f of data.seamarks || []) {
    const coords = extractPointCoords(f.geometry);
    if (!coords) continue;
    const p = f.properties || {};
    const [x, y] = project.toXY(coords[1], coords[0]);
    const info = classifySeamark(f);
    const atonNum = p.turvalaitenumero ? String(p.turvalaitenumero) : null;
    let isFaulty = atonNum ? faultyAtonIds.has(atonNum) : false;
    let faultType = null;
    if (!isFaulty) {
      for (const fp of faultyPoints) {
        if (Math.hypot(x - fp.x, y - fp.y) < 35) {
          isFaulty = true;
          faultType = fp.type;
          break;
        }
      }
    }
    const mark = {
      id: p.id || atonNum || `${coords[0].toFixed(5)},${coords[1].toFixed(5)}`,
      turvalaitenumero: atonNum,
      name: p.nimifi || p.nimisv || p.turvalaitetyyppifi || 'Seamark',
      typeFi: p.turvalaitetyyppifi || null,
      locationDesc: p.sijaintifi || null,
      lat: coords[1],
      lon: coords[0],
      x,
      y,
      role: info.role,
      label: info.label,
      short: info.short,
      safeDir: info.safeDir || null,
      isFaulty,
      faultType,
    };
    allSeamarks.push(mark);
    const padR = mark.safeDir ? 185 : mark.role === 'danger' ? 85 : 35;
    seamarkIndex.add(mark, x - padR, y - padR, x + padR, y + padR);
  }

  const rockKey = Array.isArray(data.bbox)
    ? `${data.bbox.join(',')}|n=${(data.rocks || []).length}`
    : null;
  let rockIndex;
  let allRocks;
  const cachedRock = rockKey ? rockCache.get(rockKey) : null;
  if (cachedRock) {
    rockCache.delete(rockKey);
    rockCache.set(rockKey, cachedRock);
    rockIndex = cachedRock.rockIndex;
    allRocks = cachedRock.allRocks;
  } else {
    rockIndex = makeSpatialBucketIndex(300);
    allRocks = [];
    const padR = 40;
    for (const r of data.rocks || []) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const [x, y] = project.toXY(r.lat, r.lon);
      const rockItem = {
        id: r.id,
        lat: r.lat,
        lon: r.lon,
        x,
        y,
        waterLevel: r.waterLevel || 'submerged',
        type: r.type || 'rock',
      };
      allRocks.push(rockItem);
      rockIndex.add(rockItem, x - padR, y - padR, x + padR, y + padR);
    }
    if (rockKey) {
      if (rockCache.size >= 20) {
        const oldestKey = rockCache.keys().next().value;
        rockCache.delete(oldestKey);
      }
      rockCache.set(rockKey, { rockIndex, allRocks });
    }
  }

  return {
    contourIndex,
    waterAreaIndex,
    shorelineIndex,
    soundingIndex,
    fairwayIndex,
    seamarkIndex,
    rockIndex,
    shallowContours,
    allWaterAreas,
    shallowAreas,
    shorelineSegments,
    shallowSoundings,
    safeFairways,
    unsafeFairways,
    allSeamarks,
    allRocks,
  };
}

function checkWaterAtPoint(px, py, waterCandidates) {
  let inAnyWater = false;
  let hasDeepWater = false;
  let hasShallowWater = false;
  let inCoastalBox = false;
  let inInteriorHole = false;
  for (const a of waterCandidates) {
    const outerBox = a.ringBoxes[0];
    if (px < outerBox[0] || px > outerBox[2] || py < outerBox[1] || py > outerBox[3]) {
      continue;
    }
    if (a.drval1 <= 0) inCoastalBox = true;
    if (!pointInRing(px, py, a.ringsXY[0])) continue;
    let inHole = false;
    for (let r = 1; r < a.ringsXY.length; r++) {
      const hb = a.ringBoxes[r];
      if (px >= hb[0] && px <= hb[2] && py >= hb[1] && py <= hb[3]) {
        if (pointInRing(px, py, a.ringsXY[r])) {
          inHole = true;
          break;
        }
      }
    }
    if (inHole) {
      inInteriorHole = true;
      continue;
    }
    inAnyWater = true;
    if (a.isShallow) hasShallowWater = true;
    else hasDeepWater = true;
  }
  if (!inAnyWater) {
    return inInteriorHole || inCoastalBox ? 'land' : 'ok';
  }
  if (hasShallowWater && !hasDeepWater) return 'shallow-area';
  return 'ok';
}

const ROUTING_MODE_WEIGHTS = {
  strict_fairway: {
    verifiedMult: 0.32,
    fairwayMult: 0.45,
    shallowFwMult: 0.62,
    openWaterMult: 1.35,
    hMult: 0.32,
    allowOpenWaterShortcut: false,
  },
  open_water: {
    verifiedMult: 0.8,
    fairwayMult: 0.86,
    shallowFwMult: 0.92,
    openWaterMult: 1.0,
    hMult: 0.8,
    allowOpenWaterShortcut: true,
  },
  balanced: {
    verifiedMult: 0.48,
    fairwayMult: 0.6,
    shallowFwMult: 0.68,
    openWaterMult: 1.0,
    hMult: 0.48,
    allowOpenWaterShortcut: false,
  },
};

function getRoutingModeWeights(routingMode) {
  return ROUTING_MODE_WEIGHTS[routingMode] || ROUTING_MODE_WEIGHTS.balanced;
}

/**
 * Multi-objective route profiles.
 * Each profile produces a meaningfully different trade-off between
 * distance/time, safety margins, and official fairway adherence.
 */
const OBJECTIVE_PROFILES = {
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Compromise of distance, safety margins and fairway use',
    routingMode: 'balanced',
    clearanceMode: 'normal',
    shoreMarginBoost: 0,
    rockBufferBoost: 0,
    preferVerifiedFairways: false,
  },
  fast: {
    id: 'fast',
    label: 'Fast / Direct',
    description: 'Shorter distance; more open-water and tighter clearances allowed',
    routingMode: 'open_water',
    clearanceMode: 'tight',
    shoreMarginBoost: -12,
    rockBufferBoost: -6,
    preferVerifiedFairways: false,
  },
  safe: {
    id: 'safe',
    label: 'Maximum Safety',
    description: 'Wider margins from shore, rocks and shallow water; prefer deeper routes',
    routingMode: 'balanced',
    clearanceMode: 'wide',
    shoreMarginBoost: 25,
    rockBufferBoost: 18,
    preferVerifiedFairways: true,
  },
  fairway: {
    id: 'fairway',
    label: 'Official Fairways',
    description: 'Strong preference for verified fairway centreline and channel marks',
    routingMode: 'strict_fairway',
    clearanceMode: 'normal',
    shoreMarginBoost: 8,
    rockBufferBoost: 8,
    preferVerifiedFairways: true,
  },
};

/**
 * Physically evaluate maritime safety along a route polyline using the already-indexed
 * Traficom hydrographic data (depths, contours, soundings, shorelines, fairways, seamarks)
 * and S-57 rock database. Returns 0–100 sub-scores across 4 pillars:
 *   1. Depth & UKC (35%)
 *   2. Charted Rocks & Underwater Hazards (30%)
 *   3. Shoreline & Narrow Passage Clearance (20%)
 *   4. Fairway Quality & Navigational Aids (15%)
 * Note: Sharp turns / course changes are intentionally NOT penalized.
 */
function evaluateRouteSafety(waypointsXY, index, opts = {}) {
  const effectiveSafeDepth = Number(opts.effectiveSafeDepth) || 2.0;
  const signedOffsetM = Number(opts.signedOffsetM) || 0;
  const usedFallback = Boolean(opts.usedFallback);
  const usedShallowWaterFallback = Boolean(opts.usedShallowWaterFallback);

  if (!Array.isArray(waypointsXY) || waypointsXY.length < 2 || !index) {
    return null;
  }

  let totalDistM = 0;
  for (let i = 0; i < waypointsXY.length - 1; i++) {
    totalDistM += Math.hypot(waypointsXY[i + 1].x - waypointsXY[i].x, waypointsXY[i + 1].y - waypointsXY[i].y);
  }
  if (totalDistM < 1) return null;

  const totalDistNm = totalDistM / 1852;
  const approachZoneM = Math.min(120, totalDistM * 0.12);
  const fwTol = 28 + Math.abs(signedOffsetM);

  let cumDist = 0;
  let enRouteDistM = 0;
  let verifiedFairwayDistM = 0;
  let shallowFairwayDistM = 0;
  let cautionDistM = 0;
  let depthPenaltySum = 0;
  let shallowSoundingDistM = 0;
  let nearShallowContourDistM = 0;
  let narrowExposureSum = 0;
  let narrowDistM = 0;
  let minShoreDistM = Infinity;
  let minShoreOnVerifiedFw = false;

  const rockMinDistMap = new Map(); // id -> { dist, sev, isHidden, onVerifiedFw }
  let rawMinRockDistM = Infinity;
  const faultyMarkIds = new Set();

  for (let i = 0; i < waypointsXY.length - 1; i++) {
    const ax = waypointsXY[i].x;
    const ay = waypointsXY[i].y;
    const bx = waypointsXY[i + 1].x;
    const by = waypointsXY[i + 1].y;
    const legDistM = Math.hypot(bx - ax, by - ay);
    if (legDistM < 0.5) continue;

    const nSteps = Math.max(1, Math.ceil(legDistM / 30));
    const ds = legDistM / nSteps;

    for (let s = 0; s < nSteps; s++) {
      const t = (s + 0.5) / nSteps;
      const mx = ax + (bx - ax) * t;
      const my = ay + (by - ay) * t;
      const midDist = cumDist + (s + 0.5) * ds;
      const isDockZone = midDist < approachZoneM || totalDistM - midDist < approachZoneM;

      // 1. Fairway status
      const fwHit = pointOnSafeFairway(mx, my, index, fwTol, true);
      const fw = fwHit ? fwHit.seg : null;
      const onVerifiedFw = Boolean(fw && fw.verifiedDepth);
      if (onVerifiedFw) {
        verifiedFairwayDistM += ds;
      } else if (fw) {
        shallowFairwayDistM += ds;
      }

      // 2. Depth & UKC status
      const waterCand = index.waterAreaIndex.query(mx - 5, my - 5, mx + 5, my + 5);
      const waterStatus = checkWaterAtPoint(mx, my, waterCand);

      if (onVerifiedFw) {
        // Surveyed official fairway swept deeper than effectiveSafeDepth
      } else if (waterStatus === 'land') {
        cautionDistM += ds;
        depthPenaltySum += ds * 1.0;
      } else if (waterStatus === 'shallow-area' || (fw && fw.fairwayDepth != null && fw.fairwayDepth < effectiveSafeDepth)) {
        cautionDistM += ds;
        depthPenaltySum += ds * (fw ? 0.45 : 0.85);
      } else {
        // Open deep water: evaluate depth headroom from enclosing polygons
        let bestDrval1 = -1;
        for (let wi = 0; wi < waterCand.length; wi++) {
          const a = waterCand[wi];
          const ob = a.ringBoxes[0];
          if (mx < ob[0] || mx > ob[2] || my < ob[1] || my > ob[3]) continue;
          if (!pointInRing(mx, my, a.ringsXY[0])) continue;
          if (a.drval1 > bestDrval1) bestDrval1 = a.drval1;
        }
        if (bestDrval1 >= 0 && bestDrval1 < effectiveSafeDepth) {
          // Broad coastal band (e.g. 0–10 m) where local shoals can exist
          depthPenaltySum += ds * 0.14;
        } else if (bestDrval1 >= effectiveSafeDepth && bestDrval1 < effectiveSafeDepth + 2.5) {
          depthPenaltySum += ds * 0.04;
        }
      }

      // Shallow soundings & shallow contours outside verified swept fairways
      if (!onVerifiedFw) {
        if (index.shallowSoundings.length > 0) {
          const sCand = index.soundingIndex.query(mx - 40, my - 40, mx + 40, my + 40);
          let hitSounding = false;
          for (let si = 0; si < sCand.length; si++) {
            const sd = Math.hypot(mx - sCand[si].x, my - sCand[si].y);
            if (sd <= 35) {
              hitSounding = true;
              break;
            }
          }
          if (hitSounding) shallowSoundingDistM += ds;
        }
        if (index.shallowContours.length > 0) {
          const cCand = index.contourIndex.query(mx - 25, my - 25, mx + 25, my + 25);
          let hitContour = false;
          for (let ci = 0; ci < cCand.length; ci++) {
            const c = cCand[ci];
            if (pointToSegmentDist(mx, my, c.ax, c.ay, c.bx, c.by) <= 20) {
              hitContour = true;
              break;
            }
          }
          if (hitContour) nearShallowContourDistM += ds;
        }
      }

      // 3. Charted rocks & underwater hazards (within 120 m)
      if (index.allRocks && index.allRocks.length > 0) {
        const rCand = index.rockIndex.query(mx - 120, my - 120, mx + 120, my + 120);
        for (let ri = 0; ri < rCand.length; ri++) {
          const r = rCand[ri];
          const d = Math.hypot(mx - r.x, my - r.y);
          if (d > 120) continue;
          const isHidden = r.waterLevel === 'submerged' || r.waterLevel === 'awash' || r.type === 'wreck';
          const sev = isHidden ? 1.0 : 0.65;
          if (!onVerifiedFw && d < rawMinRockDistM) {
            rawMinRockDistM = d;
          } else if (rawMinRockDistM === Infinity && d < rawMinRockDistM) {
            rawMinRockDistM = d;
          }
          const prev = rockMinDistMap.get(r.id);
          if (!prev || d < prev.dist) {
            rockMinDistMap.set(r.id, { dist: d, sev, isHidden, onVerifiedFw });
          }
        }
      }

      // 4. Shoreline & narrow passage clearance (en-route, outside shared dock zones)
      if (!isDockZone) {
        enRouteDistM += ds;
        if (index.shorelineSegments.length > 0) {
          const shCand = index.shorelineIndex.query(mx - 120, my - 120, mx + 120, my + 120);
          let dShore = 120;
          for (let shi = 0; shi < shCand.length; shi++) {
            const seg = shCand[shi];
            if (mx < seg.minX - dShore || mx > seg.maxX + dShore || my < seg.minY - dShore || my > seg.maxY + dShore) {
              continue;
            }
            const d = pointToSegmentDist(mx, my, seg.ax, seg.ay, seg.bx, seg.by);
            if (d < dShore) dShore = d;
          }
          if (dShore < minShoreDistM) {
            minShoreDistM = dShore;
            minShoreOnVerifiedFw = onVerifiedFw;
          }
          if (dShore < 60) {
            const tightness = (60 - dShore) / 60;
            const fwDiscount = onVerifiedFw ? 0.35 : 1.0;
            narrowExposureSum += ds * tightness * fwDiscount;
            if (dShore < 50 && !onVerifiedFw) {
              narrowDistM += ds;
            }
          }
        }
      }

      // 5. Nearby faulty ATON seamarks (within 220 m)
      if (index.allSeamarks.length > 0) {
        const mCand = index.seamarkIndex.query(mx - 220, my - 220, mx + 220, my + 220);
        for (let mi = 0; mi < mCand.length; mi++) {
          const m = mCand[mi];
          if (!m.isFaulty) continue;
          if (Math.hypot(mx - m.x, my - m.y) <= 220) {
            faultyMarkIds.add(m.id);
          }
        }
      }
    }

    cumDist += legDistM;
  }

  // --- Sub-score 1: Depth & UKC (35%) ---
  const depthExposureFrac = Math.min(1, depthPenaltySum / totalDistM);
  const soundingFrac = Math.min(1, shallowSoundingDistM / totalDistM);
  const contourFrac = Math.min(1, nearShallowContourDistM / totalDistM);
  const fallbackPenalty = usedShallowWaterFallback ? 16 : usedFallback ? 6 : 0;
  const depthPenalty =
    55 * Math.pow(depthExposureFrac, 0.75) +
    25 * Math.pow(soundingFrac, 0.7) +
    15 * Math.pow(contourFrac, 0.8) +
    fallbackPenalty;
  const depthScore = Math.max(0, Math.min(100, 100 - depthPenalty));

  // --- Sub-score 2: Charted Rocks & Underwater Hazards (30%) ---
  let worstRockRisk = 0;
  let rockExposure = 0;
  let closeRocksCount = 0;
  let hiddenRocksCloseCount = 0;

  for (const info of rockMinDistMap.values()) {
    const fwDiscount = info.onVerifiedFw ? 0.45 : 1.0;
    const d = info.dist;
    let curve = 0;
    if (d <= 10) curve = 1.0;
    else if (d <= 30) curve = 1.0 - ((d - 10) / 20) * 0.45; // 1.0 -> 0.55
    else if (d <= 60) curve = 0.55 - ((d - 30) / 30) * 0.35; // 0.55 -> 0.20
    else if (d <= 100) curve = 0.20 - ((d - 60) / 40) * 0.20; // 0.20 -> 0.0

    const risk = info.sev * fwDiscount * curve;
    if (risk > worstRockRisk) worstRockRisk = risk;

    if (d < 90) {
      rockExposure += info.sev * fwDiscount * ((90 - d) / 90);
    }
    if (d <= 75 && !info.onVerifiedFw) {
      closeRocksCount++;
      if (info.isHidden) hiddenRocksCloseCount++;
    }
  }

  const rockBottleneckPenalty = 42 * worstRockRisk;
  const rockDensity = rockExposure / Math.max(0.8, totalDistNm);
  const rockDensityPenalty = 45 * (1 - Math.exp(-rockDensity / 2.5));
  const rockScore = Math.max(0, Math.min(100, 100 - rockBottleneckPenalty - rockDensityPenalty));

  // --- Sub-score 3: Shoreline & Narrow Passages (20%) ---
  let shoreBottleneck = 0;
  if (minShoreDistM < 15) shoreBottleneck = 30;
  else if (minShoreDistM < 35) shoreBottleneck = 30 - (minShoreDistM - 15) * 0.9;
  else if (minShoreDistM < 70) shoreBottleneck = 12 - (minShoreDistM - 35) * (12 / 35);
  if (minShoreOnVerifiedFw) shoreBottleneck *= 0.4;

  const narrowExposureFrac = enRouteDistM > 0 ? Math.min(1, narrowExposureSum / enRouteDistM) : 0;
  const shoreExposurePenalty = 55 * Math.pow(narrowExposureFrac, 0.75);
  const shoreScore = Math.max(0, Math.min(100, 100 - shoreBottleneck - shoreExposurePenalty));

  // --- Sub-score 4: Fairway Quality & Navigational Aids (15%) ---
  const verifiedFrac = Math.min(1, verifiedFairwayDistM / totalDistM);
  const shallowFwFrac = Math.min(1, shallowFairwayDistM / totalDistM);
  const fairwayBase = Math.min(100, 68 + verifiedFrac * 32 + shallowFwFrac * 14);
  const faultyMarksCount = faultyMarkIds.size;
  const faultyPenalty = Math.min(35, faultyMarksCount * 9);
  const fairwayScore = Math.max(0, Math.min(100, fairwayBase - faultyPenalty));

  // --- Combined Weighted Maritime Safety Score ---
  const safetyScore = Math.max(
    0,
    Math.min(100, depthScore * 0.35 + rockScore * 0.30 + shoreScore * 0.20 + fairwayScore * 0.15)
  );
  const riskScore = Math.max(0, Math.min(100, 100 - safetyScore));

  return {
    safetyScore: Number(safetyScore.toFixed(1)),
    riskScore: Number(riskScore.toFixed(1)),
    breakdown: {
      depth: Math.round(depthScore),
      rocks: Math.round(rockScore),
      shore: Math.round(shoreScore),
      fairway: Math.round(fairwayScore),
      metrics: {
        minRockDistM: rawMinRockDistM < 120 ? Math.round(rawMinRockDistM) : null,
        closeRocksCount,
        hiddenRocksCloseCount,
        minShoreDistM: minShoreDistM < 120 ? Math.round(minShoreDistM) : null,
        cautionDistPct: Number(((cautionDistM / totalDistM) * 100).toFixed(1)),
        verifiedFairwayPct: Math.round(verifiedFrac * 100),
        narrowDistPct: enRouteDistM > 0 ? Number(((narrowDistM / enRouteDistM) * 100).toFixed(1)) : 0,
        faultyMarks: faultyMarksCount,
      },
    },
  };
}

/**
 * Compute multi-objective comparison scores / Pareto ranking using physical hydrographic safety.
 * Higher safetyScore and efficiencyScore are better; lower riskScore is better.
 */
function scoreRouteResult(summary, totalDistNm, fairwayPct, cautionLegs, faultyMarksNearby, routeFailed, safetyEval = null) {
  if (routeFailed) {
    return {
      distanceNm: Number((totalDistNm || 0).toFixed(2)),
      etaMinutes: summary?.etaMinutes ?? null,
      fairwayPct: 0,
      cautionLegs: 99,
      riskScore: 100,
      safetyScore: 0,
      efficiencyScore: 0,
      composite: 0,
      safetyBreakdown: null,
    };
  }

  let riskScore;
  let safetyScore;
  let safetyBreakdown = null;

  if (safetyEval) {
    safetyScore = safetyEval.safetyScore;
    riskScore = safetyEval.riskScore;
    safetyBreakdown = safetyEval.breakdown;
  } else {
    // Fallback heuristic if spatial index evaluation was unavailable
    const legRatio = Math.min(1, cautionLegs / Math.max(4, totalDistNm * 6));
    riskScore = Math.min(
      100,
      legRatio * 45 +
      Math.max(0, 55 - fairwayPct) * 0.4 +
      (faultyMarksNearby || 0) * 6 +
      (summary?.usedFallback ? 6 : 0) +
      (summary?.usedShallowWaterFallback ? 16 : 0)
    );
    safetyScore = Math.max(0, Math.min(100, 100 - riskScore));
  }

  // Efficiency: shorter is better
  const efficiencyScore = Math.max(0, 100 - totalDistNm * 1.8);

  // Composite used only for default ranking when client does not specify preference
  const composite = safetyScore * 0.50 + efficiencyScore * 0.30 + fairwayPct * 0.20;

  return {
    distanceNm: Number(totalDistNm.toFixed(2)),
    etaMinutes: summary?.etaMinutes ?? null,
    fairwayPct,
    cautionLegs,
    riskScore: Number(riskScore.toFixed(1)),
    safetyScore: Number(safetyScore.toFixed(1)),
    efficiencyScore: Number(efficiencyScore.toFixed(1)),
    composite: Number(composite.toFixed(1)),
    safetyBreakdown,
  };
}

/**
 * Pareto filter: keep routes that are not dominated on (distance, risk),
 * and deduplicate virtually identical paths (within 0.01 NM and 0.3 risk pts).
 */
function filterParetoAlternatives(alts) {
  if (alts.length <= 1) return alts;
  const deduped = [];
  for (const alt of alts) {
    if (alt.summary?.routeFailed) continue;
    const duplicate = deduped.some(
      (k) =>
        Math.abs(k.scores.distanceNm - alt.scores.distanceNm) <= 0.01 &&
        Math.abs(k.scores.riskScore - alt.scores.riskScore) <= 0.3
    );
    if (!duplicate) deduped.push(alt);
  }
  if (deduped.length <= 1) return deduped.length > 0 ? deduped : alts.slice(0, 1);

  const kept = [];
  for (let i = 0; i < deduped.length; i++) {
    const a = deduped[i];
    let dominated = false;
    for (let j = 0; j < deduped.length; j++) {
      if (i === j) continue;
      const b = deduped[j];
      const aDist = a.scores.distanceNm;
      const bDist = b.scores.distanceNm;
      const aRisk = a.scores.riskScore;
      const bRisk = b.scores.riskScore;
      if (bDist <= aDist && bRisk <= aRisk && (bDist < aDist || bRisk < aRisk)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(a);
  }
  return kept.length > 0 ? kept : deduped.slice(0, 1);
}

function parseLatLonList(raw, maxItems = 15) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(';')) {
    if (out.length >= maxItems) break;
    const trimmed = part.trim();
    if (!trimmed) continue;
    const pieces = trimmed.split(',');
    if (pieces.length < 2) continue;
    const lat = Number(pieces[0]);
    const lon = Number(pieces[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      out.push({ lat, lon });
    }
  }
  return out;
}

function violatesCardinal(px, py, mark, relaxFactor = 1.0, avoidFaulty = true) {
  if (!mark.safeDir) return false;
  const faulty = Boolean(avoidFaulty && mark.isFaulty);
  const dx = px - mark.x;
  const dy = py - mark.y;
  const dist = Math.hypot(dx, dy);
  const maxRadius = (faulty ? 60 : 38) * relaxFactor;
  if (dist > maxRadius) return false;
  const buoyBuf = (faulty ? 18 : 8) * relaxFactor;
  if (dist < buoyBuf) return true;

  const offset = 4 * relaxFactor;
  if (mark.safeDir === 'N') return dy < -offset && Math.abs(dx) <= -dy * 0.85;
  if (mark.safeDir === 'S') return dy > offset && Math.abs(dx) <= dy * 0.85;
  if (mark.safeDir === 'W') return dx > offset && Math.abs(dy) <= dx * 0.85;
  if (mark.safeDir === 'E') return dx < -offset && Math.abs(dy) <= -dx * 0.85;
  return false;
}

function pointOnSafeFairway(px, py, index, tolerance = 10, allowShallowFairways = false, preCandidates = null) {
  const candidates =
    preCandidates ||
    index.fairwayIndex.query(px - tolerance, py - tolerance, px + tolerance, py + tolerance);
  let bestScore = Infinity;
  let bestDist = Infinity;
  let bestSeg = null;
  for (let i = 0, len = candidates.length; i < len; i++) {
    const fw = candidates[i];
    if (!allowShallowFairways && fw.shallowFairway) continue;
    if (
      px < fw.minX - tolerance ||
      px > fw.maxX + tolerance ||
      py < fw.minY - tolerance ||
      py > fw.maxY + tolerance
    ) {
      continue;
    }
    const d = pointToSegmentDist(px, py, fw.ax, fw.ay, fw.bx, fw.by);
    if (d <= tolerance) {
      const tierScore = fw.verifiedDepth ? -40 : fw.shallowFairway ? 10 : -15;
      const score = d + tierScore - fw.priority * 5;
      if (score < bestScore) {
        bestScore = score;
        bestDist = d;
        bestSeg = fw;
      }
    }
  }
  return bestSeg ? { dist: bestDist, seg: bestSeg } : null;
}

function segmentNearSafeFairway(
  ax,
  ay,
  bx,
  by,
  index,
  tolerance = 10,
  allowShallowFairways = false,
  preCandidates = null
) {
  const candidates =
    preCandidates ||
    index.fairwayIndex.query(
      Math.min(ax, bx) - tolerance,
      Math.min(ay, by) - tolerance,
      Math.max(ax, bx) + tolerance,
      Math.max(ay, by) + tolerance
    );
  if (candidates.length === 0) return null;

  const matchPoint = (px, py) => {
    let bestScore = Infinity;
    let bestSeg = null;
    for (let j = 0, len = candidates.length; j < len; j++) {
      const fw = candidates[j];
      if (!allowShallowFairways && fw.shallowFairway) continue;
      if (
        px < fw.minX - tolerance ||
        px > fw.maxX + tolerance ||
        py < fw.minY - tolerance ||
        py > fw.maxY + tolerance
      ) {
        continue;
      }
      const d = pointToSegmentDist(px, py, fw.ax, fw.ay, fw.bx, fw.by);
      if (d <= tolerance) {
        const tierScore = fw.verifiedDepth ? -40 : fw.shallowFairway ? 10 : -15;
        const score = d + tierScore - fw.priority * 5;
        if (score < bestScore) {
          bestScore = score;
          bestSeg = fw;
        }
      }
    }
    return bestSeg;
  };

  const segA = matchPoint(ax, ay);
  if (!segA) return null;
  const segB = matchPoint(bx, by);
  if (!segB) return null;

  let allVerified = Boolean(segA.verifiedDepth && segB.verifiedDepth);
  let anyShallow = Boolean(segA.shallowFairway || segB.shallowFairway);
  let chosen = segA;
  const rankSeg = (fw) => (fw.verifiedDepth ? 100 : fw.shallowFairway ? -50 : 20) + fw.priority;
  if (rankSeg(segB) > rankSeg(chosen)) chosen = segB;

  const dist = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(dist / 20));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const segM = matchPoint(ax + (bx - ax) * t, ay + (by - ay) * t);
    if (!segM) return null;
    if (!segM.verifiedDepth) allVerified = false;
    if (segM.shallowFairway) anyShallow = true;
    if (rankSeg(segM) > rankSeg(chosen)) chosen = segM;
  }

  return { ...chosen, verifiedDepth: allVerified, shallowFairway: anyShallow };
}

const EMPTY_MARK_LIST = Object.freeze([]);

function isPointBlocked(px, py, index, options = {}, metricCache = null) {
  const contourBuf = options.contourBuffer ?? 16;
  const soundingBuf = options.soundingBuffer ?? 22;
  const shoreBuf = options.shoreBuffer ?? 0;
  const rockBuf = options.rockBuffer ?? 0;
  const relax = options.relaxFactor ?? 1.0;
  const allowShallowFairways = Boolean(options.allowShallowFairways);
  const allowShallowWater = Boolean(options.allowShallowWater);
  const avoidFaulty = options.avoidFaulty !== false;
  const weights = getRoutingModeWeights(options.routingMode);

  let fwHit;
  if (metricCache) {
    if (metricCache.fwHit === undefined) {
      metricCache.fwHit = pointOnSafeFairway(px, py, index, 10, true);
    }
    fwHit = metricCache.fwHit;
  } else {
    fwHit = pointOnSafeFairway(px, py, index, 10, true);
  }

  const onFairway = Boolean(fwHit);
  const bypassDepthChecks = Boolean(
    fwHit && (fwHit.seg.verifiedDepth || (allowShallowFairways && fwHit.seg.shallowFairway))
  );

  let softPenalty = weights.openWaterMult;

  // Seamarks: isolated danger always applies; channel buoys & cardinal sectors do not block official fairways
  if (metricCache) {
    if (metricCache.markEntries === undefined) {
      const marks = index.seamarkIndex.query(px - 115, py - 115, px + 115, py + 115);
      metricCache.markEntries =
        marks.length === 0
          ? EMPTY_MARK_LIST
          : marks.map((m) => ({ m, d: Math.hypot(px - m.x, py - m.y) }));
    }
    for (let i = 0, len = metricCache.markEntries.length; i < len; i++) {
      const entry = metricCache.markEntries[i];
      const m = entry.m;
      const d = entry.d;
      const isFaultyEff = avoidFaulty && m.isFaulty;
      if (m.role === 'danger' && d < (onFairway ? 12 : (isFaultyEff ? 65 : 38) * relax)) {
        return { blocked: true, reason: 'danger-mark' };
      }
      if (!onFairway) {
        const buoyBuf = (isFaultyEff ? 24 : 12) * relax;
        if (d < buoyBuf) return { blocked: true, reason: 'buoy' };
        if (violatesCardinal(px, py, m, relax, avoidFaulty)) {
          return { blocked: true, reason: m.role };
        }
        if (isFaultyEff && d <= 110) {
          softPenalty = Math.max(softPenalty, 1.55);
        }
      }
    }
  } else {
    const marks = index.seamarkIndex.query(px - 115, py - 115, px + 115, py + 115);
    for (let i = 0, len = marks.length; i < len; i++) {
      const m = marks[i];
      const d = Math.hypot(px - m.x, py - m.y);
      const isFaultyEff = avoidFaulty && m.isFaulty;
      if (m.role === 'danger' && d < (onFairway ? 12 : (isFaultyEff ? 65 : 38) * relax)) {
        return { blocked: true, reason: 'danger-mark' };
      }
      if (!onFairway) {
        const buoyBuf = (isFaultyEff ? 24 : 12) * relax;
        if (d < buoyBuf) return { blocked: true, reason: 'buoy' };
        if (violatesCardinal(px, py, m, relax, avoidFaulty)) {
          return { blocked: true, reason: m.role };
        }
        if (isFaultyEff && d <= 110) {
          softPenalty = Math.max(softPenalty, 1.55);
        }
      }
    }
  }

  // OpenSeaMap rocks & hazards: risk only on open waters, not in official fairways
  if (!onFairway && rockBuf > 0 && index.rockIndex) {
    const queryBuf = Math.max(rockBuf, 15);
    if (metricCache) {
      if (metricCache.minRockDist === undefined || queryBuf > metricCache.rockPad) {
        const rocks = index.rockIndex.query(px - queryBuf, py - queryBuf, px + queryBuf, py + queryBuf);
        let minD = Infinity;
        let blocked = false;
        for (let i = 0, len = rocks.length; i < len; i++) {
          const r = rocks[i];
          const d = Math.hypot(px - r.x, py - r.y);
          const effectiveBuf = (r.waterLevel === 'always_dry' || r.type === 'bare_rock' || r.type === 'islet')
            ? Math.max(rockBuf, 15)
            : rockBuf;
          if (d <= effectiveBuf) {
            blocked = true;
          }
          if (d < minD) minD = d;
        }
        metricCache.minRockDist = minD;
        metricCache.rockPad = queryBuf;
        metricCache.rockBlocked = blocked;
      }
      if (metricCache.rockBlocked || metricCache.minRockDist <= rockBuf) {
        return { blocked: true, reason: 'rock' };
      }
    } else {
      const rocks = index.rockIndex.query(px - queryBuf, py - queryBuf, px + queryBuf, py + queryBuf);
      for (let i = 0, len = rocks.length; i < len; i++) {
        const r = rocks[i];
        const effectiveBuf = (r.waterLevel === 'always_dry' || r.type === 'bare_rock' || r.type === 'islet')
          ? Math.max(rockBuf, 15)
          : rockBuf;
        if (Math.hypot(px - r.x, py - r.y) <= effectiveBuf) {
          return { blocked: true, reason: 'rock' };
        }
      }
    }
  }

  let waterStatus = 'ok';
  if (index.allWaterAreas.length > 0) {
    if (metricCache) {
      if (metricCache.waterStatus === undefined) {
        const areas = index.waterAreaIndex.query(px - 5, py - 5, px + 5, py + 5);
        metricCache.waterStatus = checkWaterAtPoint(px, py, areas);
      }
      waterStatus = metricCache.waterStatus;
    } else {
      const areas = index.waterAreaIndex.query(px - 5, py - 5, px + 5, py + 5);
      waterStatus = checkWaterAtPoint(px, py, areas);
    }
    if (waterStatus === 'land' && (!fwHit || fwHit.dist > 5)) {
      return { blocked: true, reason: 'land' };
    }
  }

  if (shoreBuf > 0 && (!fwHit || fwHit.dist > 5) && index.shorelineSegments.length > 0) {
    if (metricCache) {
      if (metricCache.minShoreDist === undefined || shoreBuf > metricCache.shorePad) {
        const shores = index.shorelineIndex.query(px - shoreBuf, py - shoreBuf, px + shoreBuf, py + shoreBuf);
        let activeBound = shoreBuf;
        let minD = Infinity;
        for (let i = 0, len = shores.length; i < len; i++) {
          const sh = shores[i];
          if (
            px < sh.minX - activeBound ||
            px > sh.maxX + activeBound ||
            py < sh.minY - activeBound ||
            py > sh.maxY + activeBound
          ) {
            continue;
          }
          const d = pointToSegmentDist(px, py, sh.ax, sh.ay, sh.bx, sh.by);
          if (d < minD) {
            minD = d;
            if (minD < activeBound) activeBound = minD;
          }
        }
        metricCache.minShoreDist = minD;
        metricCache.shorePad = shoreBuf;
      }
      if (metricCache.minShoreDist <= shoreBuf) {
        return { blocked: true, reason: 'shore-margin' };
      }
    } else {
      const shores = index.shorelineIndex.query(px - shoreBuf, py - shoreBuf, px + shoreBuf, py + shoreBuf);
      for (let i = 0, len = shores.length; i < len; i++) {
        const sh = shores[i];
        if (
          px < sh.minX - shoreBuf ||
          px > sh.maxX + shoreBuf ||
          py < sh.minY - shoreBuf ||
          py > sh.maxY + shoreBuf
        ) {
          continue;
        }
        if (pointToSegmentDist(px, py, sh.ax, sh.ay, sh.bx, sh.by) <= shoreBuf) {
          return { blocked: true, reason: 'shore-margin' };
        }
      }
    }
  }

  if (!bypassDepthChecks) {
    if (waterStatus === 'shallow-area') {
      if (!allowShallowWater) {
        return { blocked: true, reason: 'shallow-area' };
      }
      softPenalty = Math.max(softPenalty, 3.2);
    }

    const searchPad = Math.max(contourBuf, 65);
    if (metricCache) {
      if (metricCache.minContourDist === undefined || searchPad > metricCache.contourPad) {
        const contours = index.contourIndex.query(px - searchPad, py - searchPad, px + searchPad, py + searchPad);
        let activeBound = searchPad;
        let minD = Infinity;
        for (let i = 0, len = contours.length; i < len; i++) {
          const c = contours[i];
          if (
            px < c.minX - activeBound ||
            px > c.maxX + activeBound ||
            py < c.minY - activeBound ||
            py > c.maxY + activeBound
          ) {
            continue;
          }
          const d = pointToSegmentDist(px, py, c.ax, c.ay, c.bx, c.by);
          if (d < minD) {
            minD = d;
            if (minD < activeBound) activeBound = minD;
          }
        }
        metricCache.minContourDist = minD;
        metricCache.contourPad = searchPad;
      }
      if (contourBuf > 0 && metricCache.minContourDist <= contourBuf) {
        if (!allowShallowWater) {
          return { blocked: true, reason: 'shallow-contour' };
        }
        softPenalty = Math.max(softPenalty, 3.2);
      } else if (metricCache.minContourDist <= 65) {
        softPenalty = Math.max(softPenalty, 1.5);
      }
    } else if (contourBuf > 0 || allowShallowWater || (!onFairway && softPenalty < 1.5)) {
      const contours = index.contourIndex.query(px - searchPad, py - searchPad, px + searchPad, py + searchPad);
      let activePad = (onFairway || (!allowShallowWater && softPenalty >= 1.5)) ? contourBuf : searchPad;
      for (let i = 0, len = contours.length; i < len; i++) {
        const c = contours[i];
        if (
          px < c.minX - activePad ||
          px > c.maxX + activePad ||
          py < c.minY - activePad ||
          py > c.maxY + activePad
        ) {
          continue;
        }
        const d = pointToSegmentDist(px, py, c.ax, c.ay, c.bx, c.by);
        if (contourBuf > 0 && d <= contourBuf) {
          if (!allowShallowWater) {
            return { blocked: true, reason: 'shallow-contour' };
          }
          softPenalty = Math.max(softPenalty, 3.2);
          break;
        } else if (d <= 65) {
          softPenalty = Math.max(softPenalty, 1.5);
          if (!allowShallowWater) {
            if (contourBuf <= 0) break;
            activePad = contourBuf;
          }
        }
      }
    }

    if (soundingBuf > 0) {
      if (metricCache) {
        if (metricCache.minSoundingDist === undefined || soundingBuf > metricCache.soundingPad) {
          const soundings = index.soundingIndex.query(
            px - soundingBuf,
            py - soundingBuf,
            px + soundingBuf,
            py + soundingBuf
          );
          let activeBound = soundingBuf;
          let minS = Infinity;
          for (let i = 0, len = soundings.length; i < len; i++) {
            const s = soundings[i];
            if (Math.abs(px - s.x) > activeBound || Math.abs(py - s.y) > activeBound) continue;
            const d = Math.hypot(px - s.x, py - s.y);
            if (d < minS) {
              minS = d;
              if (minS < activeBound) activeBound = minS;
            }
          }
          metricCache.minSoundingDist = minS;
          metricCache.soundingPad = soundingBuf;
        }
        if (metricCache.minSoundingDist <= soundingBuf) {
          if (!allowShallowWater) {
            return { blocked: true, reason: 'shallow-sounding' };
          }
          softPenalty = Math.max(softPenalty, 3.2);
        }
      } else if (!(allowShallowWater && softPenalty >= 3.2)) {
        const soundings = index.soundingIndex.query(px - soundingBuf, py - soundingBuf, px + soundingBuf, py + soundingBuf);
        for (let i = 0, len = soundings.length; i < len; i++) {
          const s = soundings[i];
          if (Math.hypot(px - s.x, py - s.y) <= soundingBuf) {
            if (!allowShallowWater) {
              return { blocked: true, reason: 'shallow-sounding' };
            }
            softPenalty = Math.max(softPenalty, 3.2);
            break;
          }
        }
      }
    }
  }

  let penalty = softPenalty;
  if (onFairway && fwHit) {
    if (bypassDepthChecks && fwHit.seg.verifiedDepth) penalty = weights.verifiedMult;
    else if (!fwHit.seg.shallowFairway) penalty = weights.fairwayMult;
    else penalty = allowShallowFairways ? weights.shallowFwMult : Math.max(weights.shallowFwMult, 0.75);
    if (fwHit.dist > 3) penalty *= 1.15;
  }

  return {
    blocked: false,
    onFairway,
    verifiedFairway: Boolean(fwHit && fwHit.seg.verifiedDepth),
    fairwayDepth: fwHit?.seg?.fairwayDepth ?? null,
    fairwayName: fwHit?.seg?.name ?? null,
    penalty,
  };
}

function evaluateSegment(ax, ay, bx, by, index, options = {}) {
  const contourBuf = options.contourBuffer ?? 16;
  const soundingBuf = options.soundingBuffer ?? 22;
  const shoreBuf = options.shoreBuffer ?? 0;
  const rockBuf = options.rockBuffer ?? 0;
  const relax = options.relaxFactor ?? 1.0;
  const allowShallowFairways = Boolean(options.allowShallowFairways);
  const allowShallowWater = Boolean(options.allowShallowWater);
  const avoidFaulty = options.avoidFaulty !== false;
  const weights = getRoutingModeWeights(options.routingMode);
  const maxAllowedCost = options.maxAllowedCost;

  const dist = Math.hypot(bx - ax, by - ay);
  if (dist < 1e-3) {
    return { blocked: false, costMultiplier: 1.0, onFairway: false, verifiedFairway: false, fairwayDepth: null, minDepthSeen: null };
  }

  const minX = ax < bx ? ax : bx;
  const minY = ay < by ? ay : by;
  const maxX = ax > bx ? ax : bx;
  const maxY = ay > by ? ay : by;

  let nearFairways = null;
  let fwMatch;
  if (options.precomputedFwMatch !== undefined) {
    fwMatch = options.precomputedFwMatch;
  } else if (options.skipFairwayCheckIfEndpointsOff && (!options.aOnFairway || !options.bOnFairway)) {
    fwMatch = null;
  } else {
    nearFairways = index.fairwayIndex.query(minX - 12, minY - 12, maxX + 12, maxY + 12);
    fwMatch =
      nearFairways.length > 0 ? segmentNearSafeFairway(ax, ay, bx, by, index, 5, true, nearFairways) : null;
  }
  const onFairway = Boolean(fwMatch);
  const bypassDepthChecks = Boolean(
    fwMatch && (fwMatch.verifiedDepth || (allowShallowFairways && fwMatch.shallowFairway))
  );

  let softPenalty = weights.openWaterMult;
  let minDepthSeen = null;

  if (maxAllowedCost !== undefined) {
    let minPossibleMult = softPenalty;
    if (onFairway && fwMatch) {
      if (bypassDepthChecks && fwMatch.verifiedDepth) minPossibleMult = weights.verifiedMult;
      else if (!fwMatch.shallowFairway) minPossibleMult = weights.fairwayMult;
      else minPossibleMult = allowShallowFairways ? weights.shallowFwMult : Math.max(weights.shallowFwMult, 0.75);
    }
    if (dist * minPossibleMult > maxAllowedCost) {
      return { blocked: true, reason: 'cost-exceeded' };
    }
  }

  let cardinalMarks = EMPTY_MARK_LIST;

  const runContoursAndSoundings = () => {
    if (bypassDepthChecks) return null;

    if (contourBuf > 0) {
      const searchPad = Math.max(contourBuf, 65);
      if (allowShallowWater || contourBuf > 0 || (!onFairway && softPenalty < 1.5)) {
        const contours = index.contourIndex.query(minX - searchPad, minY - searchPad, maxX + searchPad, maxY + searchPad);
        let activePad = (onFairway || (!allowShallowWater && softPenalty >= 1.5) || (allowShallowWater && softPenalty >= 3.2))
          ? contourBuf
          : searchPad;
        for (let i = 0, len = contours.length; i < len; i++) {
          const c = contours[i];
          if (
            c.maxX < minX - activePad ||
            c.minX > maxX + activePad ||
            c.maxY < minY - activePad ||
            c.minY > maxY + activePad
          ) {
            continue;
          }
          const d = segmentToSegmentDist(ax, ay, bx, by, c.ax, c.ay, c.bx, c.by);
          if (d <= contourBuf) {
            if (!allowShallowWater) {
              return { blocked: true, reason: 'shallow-contour' };
            }
            softPenalty = Math.max(softPenalty, 3.2);
            if (!onFairway && maxAllowedCost !== undefined && dist * softPenalty > maxAllowedCost) {
              return { blocked: true, reason: 'cost-exceeded' };
            }
            if (minDepthSeen === null || c.depth < minDepthSeen) minDepthSeen = c.depth;
            if (onFairway || softPenalty >= 3.2) break;
            activePad = contourBuf;
          } else if (d <= 65) {
            softPenalty = Math.max(softPenalty, 1.5);
            if (!onFairway && maxAllowedCost !== undefined && dist * softPenalty > maxAllowedCost) {
              return { blocked: true, reason: 'cost-exceeded' };
            }
            if (minDepthSeen === null || c.depth < minDepthSeen) minDepthSeen = c.depth;
            if (!allowShallowWater) {
              activePad = contourBuf;
            }
          } else if (minDepthSeen === null || c.depth < minDepthSeen) {
            minDepthSeen = c.depth;
          }
        }
      }
    }

    if (soundingBuf > 0 && !(allowShallowWater && softPenalty >= 3.2 && !onFairway)) {
      const soundings = index.soundingIndex.query(
        minX - soundingBuf,
        minY - soundingBuf,
        maxX + soundingBuf,
        maxY + soundingBuf
      );
      for (let i = 0, len = soundings.length; i < len; i++) {
        const s = soundings[i];
        if (pointToSegmentDist(s.x, s.y, ax, ay, bx, by) <= soundingBuf) {
          if (!allowShallowWater) {
            return { blocked: true, reason: 'shallow-sounding' };
          }
          softPenalty = Math.max(softPenalty, 3.2);
          if (!onFairway && maxAllowedCost !== undefined && dist * softPenalty > maxAllowedCost) {
            return { blocked: true, reason: 'cost-exceeded' };
          }
          if (minDepthSeen === null || s.depth < minDepthSeen) minDepthSeen = s.depth;
          break;
        }
        if (minDepthSeen === null || s.depth < minDepthSeen) minDepthSeen = s.depth;
      }
    }

    return null;
  };

  const runSeamarks = () => {
    const marks = index.seamarkIndex.query(minX - 115, minY - 115, maxX + 115, maxY + 115);
    if (marks.length === 0) return null;
    const cards = [];
    for (let i = 0, len = marks.length; i < len; i++) {
      const m = marks[i];
      const d = pointToSegmentDist(m.x, m.y, ax, ay, bx, by);
      if (m.safeDir && d <= 75) {
        cards.push(m);
      }
      const isFaultyEff = avoidFaulty && m.isFaulty;
      if (m.role === 'danger' && d < (onFairway ? 12 : (isFaultyEff ? 65 : 38) * relax)) {
        return { blocked: true, reason: 'danger-mark' };
      }
      if (!onFairway) {
        const buoyBuf = (isFaultyEff ? 24 : 12) * relax;
        if (d < buoyBuf) {
          return { blocked: true, reason: 'buoy' };
        }
        if (isFaultyEff && d <= 110) {
          softPenalty = Math.max(softPenalty, 1.55);
          if (maxAllowedCost !== undefined && dist * softPenalty > maxAllowedCost) {
            return { blocked: true, reason: 'cost-exceeded' };
          }
        }
      }
    }
    cardinalMarks = cards;
    return null;
  };

  const runRocks = () => {
    if (onFairway || rockBuf <= 0 || !index.rockIndex) return null;
    const queryBuf = Math.max(rockBuf, 15);
    const rocks = index.rockIndex.query(minX - queryBuf, minY - queryBuf, maxX + queryBuf, maxY + queryBuf);
    for (let i = 0, len = rocks.length; i < len; i++) {
      const r = rocks[i];
      const effectiveBuf = (r.waterLevel === 'always_dry' || r.type === 'bare_rock' || r.type === 'islet')
        ? Math.max(rockBuf, 15)
        : rockBuf;
      const d = pointToSegmentDist(r.x, r.y, ax, ay, bx, by);
      if (d <= effectiveBuf) {
        return { blocked: true, reason: 'rock' };
      }
    }
    return null;
  };

  const runSampledAreasAndCardinals = () => {
    if (bypassDepthChecks) return null;
    const sampleStep = dist > 5000 ? 100 : 20;
    const steps = Math.max(2, Math.ceil(dist / sampleStep));
    const hasWaterAreas = index.allWaterAreas.length > 0;
    const candidateAreas = hasWaterAreas
      ? index.waterAreaIndex.query(minX - 5, minY - 5, maxX + 5, maxY + 5)
      : EMPTY_MARK_LIST;

    if (!hasWaterAreas && (onFairway || cardinalMarks.length === 0)) {
      return null;
    }

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;

      let ptFwHit;
      const getPtFwHit = () => {
        if (ptFwHit === undefined) {
          if (nearFairways === null) {
            nearFairways = index.fairwayIndex.query(minX - 12, minY - 12, maxX + 12, maxY + 12);
          }
          ptFwHit = nearFairways.length > 0 ? pointOnSafeFairway(px, py, index, 10, true, nearFairways) : null;
        }
        return ptFwHit;
      };

      if (hasWaterAreas) {
        const waterStatus = checkWaterAtPoint(px, py, candidateAreas);
        if (waterStatus === 'land') {
          const hit = getPtFwHit();
          if (!hit || hit.dist > 5) {
            return { blocked: true, reason: 'land' };
          }
        } else if (waterStatus === 'shallow-area') {
          const hit = getPtFwHit();
          const ptBypass = Boolean(
            hit && (hit.seg.verifiedDepth || (allowShallowFairways && hit.seg.shallowFairway))
          );
          if (!ptBypass) {
            if (!allowShallowWater) {
              return { blocked: true, reason: 'shallow-area' };
            }
            softPenalty = Math.max(softPenalty, 3.2);
            if (!onFairway && maxAllowedCost !== undefined && dist * softPenalty > maxAllowedCost) {
              return { blocked: true, reason: 'cost-exceeded' };
            }
          }
        }
      }

      if (!onFairway && cardinalMarks.length > 0) {
        for (let c = 0, len = cardinalMarks.length; c < len; c++) {
          const m = cardinalMarks[c];
          if (violatesCardinal(px, py, m, relax, avoidFaulty)) {
            const hit = getPtFwHit();
            if (!hit) {
              return { blocked: true, reason: m.role };
            }
          }
        }
      }
    }
    return null;
  };

  const runShorelineCheck = () => {
    if (shoreBuf <= 0 || onFairway || index.shorelineSegments.length === 0) return null;
    const shores = index.shorelineIndex.query(minX - shoreBuf, minY - shoreBuf, maxX + shoreBuf, maxY + shoreBuf);
    for (let i = 0, len = shores.length; i < len; i++) {
      const sh = shores[i];
      if (
        sh.maxX < minX - shoreBuf ||
        sh.minX > maxX + shoreBuf ||
        sh.maxY < minY - shoreBuf ||
        sh.minY > maxY + shoreBuf
      ) {
        continue;
      }
      if (segmentToSegmentDist(ax, ay, bx, by, sh.ax, sh.ay, sh.bx, sh.by) <= shoreBuf) {
        return { blocked: true, reason: 'shore-margin' };
      }
    }
    return null;
  };

  if (options.fastLongSegmentCheck) {
    const seamarkRes = runSeamarks();
    if (seamarkRes) return seamarkRes;
    const rockRes = runRocks();
    if (rockRes) return rockRes;
    const areaRes = runSampledAreasAndCardinals();
    if (areaRes) return areaRes;
    const shoreRes = runShorelineCheck();
    if (shoreRes) return shoreRes;
    const csRes = runContoursAndSoundings();
    if (csRes) return csRes;
  } else {
    const csRes = runContoursAndSoundings();
    if (csRes) return csRes;
    const shoreRes = runShorelineCheck();
    if (shoreRes) return shoreRes;
    const seamarkRes = runSeamarks();
    if (seamarkRes) return seamarkRes;
    const rockRes = runRocks();
    if (rockRes) return rockRes;
    const areaRes = runSampledAreasAndCardinals();
    if (areaRes) return areaRes;
  }

  let costMultiplier = softPenalty;
  if (onFairway && fwMatch) {
    if (bypassDepthChecks && fwMatch.verifiedDepth) costMultiplier = weights.verifiedMult;
    else if (!fwMatch.shallowFairway) costMultiplier = weights.fairwayMult;
    else costMultiplier = allowShallowFairways ? weights.shallowFwMult : Math.max(weights.shallowFwMult, 0.75);
  }

  return {
    blocked: false,
    costMultiplier,
    onFairway,
    verifiedFairway: Boolean(fwMatch && fwMatch.verifiedDepth),
    fairwayDepth: fwMatch?.fairwayDepth ?? null,
    fairwayName: fwMatch?.name ?? null,
    minDepthSeen,
  };
}

function inspectSegmentObstructions(ax, ay, bx, by, index, project, effectiveSafeDepth, options = {}) {
  const contourBuf = options.contourBuffer ?? 16;
  const soundingBuf = options.soundingBuffer ?? 22;
  const shoreBuf = options.shoreBuffer ?? 0;
  const rockBuf = options.rockBuffer ?? 0;
  const relax = options.relaxFactor ?? 1.0;
  const allowShallowFairways = Boolean(options.allowShallowFairways);
  const allowShallowWater = Boolean(options.allowShallowWater);
  const avoidFaulty = options.avoidFaulty !== false;

  const dist = Math.hypot(bx - ax, by - ay);
  if (dist < 1e-3) {
    return { blocked: false, firstObstruction: null, obstructions: [], reasonCounts: {} };
  }

  const steps = Math.max(8, Math.min(180, Math.ceil(dist / 25)));
  const reasonCounts = {};
  const obstructions = [];
  const recordedXY = [];
  let firstObstruction = null;

  const recordHit = (px, py, t, hit) => {
    reasonCounts[hit.reason] = (reasonCounts[hit.reason] || 0) + 1;
    const [lat, lon] = project.toLatLon(px, py);
    const entry = {
      reason: hit.reason,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      distFromStartM: Math.round(dist * t),
      progressPct: Math.round(t * 100),
      depth: hit.depth ?? null,
      markName: hit.markName ?? null,
      detail: hit.detail,
    };
    if (!firstObstruction) firstObstruction = entry;
    const lastIdx = obstructions.length - 1;
    if (
      obstructions.length === 0 ||
      (obstructions.length < 5 &&
        (obstructions[lastIdx].reason !== entry.reason ||
          Math.hypot(px - recordedXY[lastIdx][0], py - recordedXY[lastIdx][1]) >= 150))
    ) {
      obstructions.push(entry);
      recordedXY.push([px, py]);
    }
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const prevT = i === 0 ? 0 : (i - 1) / steps;
    const prevX = ax + (bx - ax) * prevT;
    const prevY = ay + (by - ay) * prevT;

    const fwHit = pointOnSafeFairway(px, py, index, 10, true);
    const onFairway = Boolean(fwHit);
    const bypassDepthChecks = Boolean(
      fwHit && (fwHit.seg.verifiedDepth || (allowShallowFairways && fwHit.seg.shallowFairway))
    );

    const marks = index.seamarkIndex.query(px - 115, py - 115, px + 115, py + 115);
    let markHit = null;
    for (const m of marks) {
      const d = Math.hypot(px - m.x, py - m.y);
      const isFaultyEff = avoidFaulty && m.isFaulty;
      if (m.role === 'danger' && d < (onFairway ? 12 : (isFaultyEff ? 65 : 38) * relax)) {
        markHit = {
          reason: 'danger-mark',
          markName: m.name,
          detail: `Seamark keep-out: ${m.name} (${m.label || 'Isolated Danger'})`,
        };
        break;
      }
      if (!onFairway) {
        const buoyBuf = (isFaultyEff ? 24 : 12) * relax;
        if (d < buoyBuf) {
          markHit = {
            reason: 'buoy',
            markName: m.name,
            detail: `Seamark keep-out: ${m.name} (${m.label || m.role}) within ${Math.round(d)} m`,
          };
          break;
        }
        if (violatesCardinal(px, py, m, relax, avoidFaulty)) {
          markHit = {
            reason: m.role,
            markName: m.name,
            detail: `Cardinal sector keep-out: ${m.name} (${m.label || m.role})`,
          };
          break;
        }
      }
    }
    if (markHit) {
      recordHit(px, py, t, markHit);
    }

    if (!onFairway && rockBuf > 0 && index.rockIndex) {
      const rocks = index.rockIndex.query(px - rockBuf, py - rockBuf, px + rockBuf, py + rockBuf);
      let nearestRock = null;
      let minRockDist = Infinity;
      for (let rIdx = 0, rLen = rocks.length; rIdx < rLen; rIdx++) {
        const r = rocks[rIdx];
        const d = Math.hypot(px - r.x, py - r.y);
        if (d <= rockBuf && d < minRockDist) {
          minRockDist = d;
          nearestRock = r;
        }
      }
      if (nearestRock) {
        recordHit(px, py, t, {
          reason: 'rock',
          markName: `Rock (${nearestRock.waterLevel})`,
          detail: `OpenSeaMap rock (${nearestRock.waterLevel || 'submerged'}) within ${Math.round(minRockDist)} m (buffer: ${rockBuf} m)`,
        });
      }
    }

    let waterStatus = 'ok';
    let matchedAreas = null;
    if (index.allWaterAreas.length > 0) {
      matchedAreas = index.waterAreaIndex.query(px - 5, py - 5, px + 5, py + 5);
      waterStatus = checkWaterAtPoint(px, py, matchedAreas);
      if (waterStatus === 'land' && (!fwHit || fwHit.dist > 5)) {
        recordHit(px, py, t, {
          reason: 'land',
          detail: 'Land / island or coastal shoreline polygon (drval1 <= 0 m)',
        });
        continue;
      }
      if (!onFairway && shoreBuf > 0 && index.shorelineSegments.length > 0) {
        const shores = index.shorelineIndex.query(
          Math.min(prevX, px) - shoreBuf,
          Math.min(prevY, py) - shoreBuf,
          Math.max(prevX, px) + shoreBuf,
          Math.max(prevY, py) + shoreBuf
        );
        let hitShoreDist = Infinity;
        for (let sIdx = 0; sIdx < shores.length; sIdx++) {
          const sh = shores[sIdx];
          const d = segmentToSegmentDist(prevX, prevY, px, py, sh.ax, sh.ay, sh.bx, sh.by);
          if (d <= shoreBuf && d < hitShoreDist) hitShoreDist = d;
        }
        if (hitShoreDist <= shoreBuf) {
          recordHit(px, py, t, {
            reason: 'shore-margin',
            detail: `Land / shoreline margin keep-out (${Math.round(hitShoreDist)} m <= ${shoreBuf} m limit)`,
          });
        }
      }
      if (!bypassDepthChecks && !allowShallowWater && waterStatus === 'shallow-area') {
        let hitArea = null;
        for (const a of matchedAreas) {
          if (!a.isShallow) continue;
          const ob = a.ringBoxes[0];
          if (px >= ob[0] && px <= ob[2] && py >= ob[1] && py <= ob[3] && pointInRing(px, py, a.ringsXY[0])) {
            hitArea = a;
            break;
          }
        }
        const rangeText = hitArea ? `${hitArea.drval1}–${hitArea.drval2} m` : `< ${effectiveSafeDepth.toFixed(1)} m`;
        recordHit(px, py, t, {
          reason: 'shallow-area',
          depth: hitArea?.drval2 ?? null,
          detail: `Shallow depth area (${rangeText} <= D_safe ${effectiveSafeDepth.toFixed(1)} m)`,
        });
      }
    }

    if (!bypassDepthChecks && !allowShallowWater && contourBuf > 0) {
      const contours = index.contourIndex.query(
        Math.min(prevX, px) - contourBuf,
        Math.min(prevY, py) - contourBuf,
        Math.max(prevX, px) + contourBuf,
        Math.max(prevY, py) + contourBuf
      );
      let hitContour = null;
      for (const c of contours) {
        if (segmentToSegmentDist(prevX, prevY, px, py, c.ax, c.ay, c.bx, c.by) <= contourBuf) {
          if (!hitContour || c.depth < hitContour.depth) hitContour = c;
        }
      }
      if (hitContour) {
        recordHit(px, py, t, {
          reason: 'shallow-contour',
          depth: hitContour.depth,
          detail: `Shallow depth contour (${hitContour.depth} m <= D_safe ${effectiveSafeDepth.toFixed(1)} m)`,
        });
      }
    }

    if (!bypassDepthChecks && !allowShallowWater && soundingBuf > 0) {
      const soundings = index.soundingIndex.query(
        px - soundingBuf,
        py - soundingBuf,
        px + soundingBuf,
        py + soundingBuf
      );
      let hitSounding = null;
      for (const s of soundings) {
        if (Math.hypot(px - s.x, py - s.y) <= soundingBuf) {
          if (!hitSounding || s.depth < hitSounding.depth) hitSounding = s;
        }
      }
      if (hitSounding) {
        recordHit(px, py, t, {
          reason: 'shallow-sounding',
          depth: hitSounding.depth,
          detail: `Shallow spot sounding (${hitSounding.depth} m <= D_safe ${effectiveSafeDepth.toFixed(1)} m)`,
        });
      }
    }
  }

  return {
    blocked: Boolean(firstObstruction),
    firstObstruction,
    obstructions,
    reasonCounts,
  };
}

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(node) {
    this.items.push(node);
    this._bubbleUp(this.items.length - 1);
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this._sinkDown(0);
    }
    return top;
  }
  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.items[idx].f >= this.items[parent].f) break;
      const tmp = this.items[idx];
      this.items[idx] = this.items[parent];
      this.items[parent] = tmp;
      idx = parent;
    }
  }
  _sinkDown(idx) {
    const len = this.items.length;
    while (true) {
      let smallest = idx;
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;
      if (left < len && this.items[left].f < this.items[smallest].f) smallest = left;
      if (right < len && this.items[right].f < this.items[smallest].f) smallest = right;
      if (smallest === idx) break;
      const tmp = this.items[idx];
      this.items[idx] = this.items[smallest];
      this.items[smallest] = tmp;
      idx = smallest;
    }
  }
}

function findGridAndFairwayPath(startXY, endXY, boundsXY, index, options = {}, diagOut = null) {
  const t0 = Date.now();
  const weights = getRoutingModeWeights(options.routingMode);
  const { minX, minY, maxX, maxY } = boundsXY;
  const widthM = Math.max(200, maxX - minX);
  const heightM = Math.max(200, maxY - minY);
  const stepM = Math.max(
    50,
    Math.min(115, Math.hypot(widthM, heightM) / 55),
    Math.max(widthM, heightM) / 129
  );

  const cols = Math.max(5, Math.min(130, Math.floor(widthM / stepM) + 1));
  const rows = Math.max(5, Math.min(130, Math.floor(heightM / stepM) + 1));
  const actualStepX = widthM / Math.max(1, cols - 1);
  const actualStepY = heightM / Math.max(1, rows - 1);

  const nodes = [];
  const gridNodeIds = new Int32Array(cols * rows).fill(-1);
  let openGridNodes = 0;
  let blockedGridNodes = 0;
  const blockedReasonCounts = {};

  const gridMetrics = options.segCache
    ? (options.segCache.gridBase &&
      options.segCache.gridBase.cols === cols &&
      options.segCache.gridBase.rows === rows
      ? options.segCache.gridBase.cells
      : (options.segCache.gridBase = { cols, rows, cells: new Array(cols * rows) }).cells)
    : null;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellIdx = r * cols + c;
      const x = minX + c * actualStepX;
      const y = minY + r * actualStepY;
      let metricEntry = null;
      if (gridMetrics) {
        metricEntry = gridMetrics[cellIdx];
        if (!metricEntry) {
          metricEntry = {};
          gridMetrics[cellIdx] = metricEntry;
        }
      }
      const state = isPointBlocked(x, y, index, options, metricEntry);
      if (!state.blocked) {
        const id = nodes.length;
        gridNodeIds[cellIdx] = id;
        openGridNodes++;
        nodes.push({
          id,
          x,
          y,
          c,
          r,
          onFairway: state.onFairway,
          penalty: state.penalty,
          kind: state.onFairway ? 'grid-fairway' : 'grid',
          neighbors: [],
        });
      } else {
        blockedGridNodes++;
        const rKey = state.reason || 'blocked';
        blockedReasonCounts[rKey] = (blockedReasonCounts[rKey] || 0) + 1;
      }
    }
  }

  // Inject fairway vertices (verified fairways, shallow fairways when allowed, or fairways in safe water)
  const vertexBlockedCache = new Map();
  const fwVertexMetrics = options.segCache
    ? (options.segCache.fwVertexMetrics || (options.segCache.fwVertexMetrics = new Map()))
    : null;
  const isFwVertexBlocked = (vx, vy) => {
    const k = `${Math.round(vx)}:${Math.round(vy)}`;
    if (vertexBlockedCache.has(k)) return vertexBlockedCache.get(k);
    let entry = null;
    if (fwVertexMetrics) {
      entry = fwVertexMetrics.get(k);
      if (!entry) {
        entry = {};
        fwVertexMetrics.set(k, entry);
      }
    }
    const b = isPointBlocked(vx, vy, index, options, entry).blocked;
    vertexBlockedCache.set(k, b);
    return b;
  };

  const fairwayVertexMap = new Map();
  const fwNodesByCell = new Map();
  const getOrAddFwVertex = (vx, vy) => {
    const key = `${Math.round(vx / 15)}:${Math.round(vy / 15)}`;
    if (fairwayVertexMap.has(key)) return fairwayVertexMap.get(key);
    const id = nodes.length;
    fairwayVertexMap.set(key, id);
    const cellC = Math.max(0, Math.min(cols - 1, Math.round((vx - minX) / actualStepX)));
    const cellR = Math.max(0, Math.min(rows - 1, Math.round((vy - minY) / actualStepY)));
    nodes.push({
      id,
      x: vx,
      y: vy,
      c: -1,
      r: -1,
      cellC,
      cellR,
      onFairway: true,
      penalty: weights.verifiedMult,
      kind: 'fairway-node',
      neighbors: [],
    });
    const cellKey = cellR * cols + cellC;
    let bucket = fwNodesByCell.get(cellKey);
    if (!bucket) {
      bucket = [];
      fwNodesByCell.set(cellKey, bucket);
    }
    bucket.push(id);
    return id;
  };

  const allowShallowFairways = Boolean(options.allowShallowFairways);
  for (const fw of index.safeFairways) {
    if (
      Math.max(fw.ax, fw.bx) < minX ||
      Math.min(fw.ax, fw.bx) > maxX ||
      Math.max(fw.ay, fw.by) < minY ||
      Math.min(fw.ay, fw.by) > maxY
    ) {
      continue;
    }
    if (!fw.verifiedDepth && !allowShallowFairways) {
      if (isFwVertexBlocked(fw.ax, fw.ay) || isFwVertexBlocked(fw.bx, fw.by)) continue;
    }

    const fullDist = Math.hypot(fw.bx - fw.ax, fw.by - fw.ay);
    const parts = Math.max(1, Math.ceil(fullDist / 160));
    const mult = fw.verifiedDepth ? weights.verifiedMult : fw.shallowFairway ? weights.shallowFwMult : weights.fairwayMult;
    const subWeight = (fullDist / parts) * mult;
    let prevId = getOrAddFwVertex(fw.ax, fw.ay);
    for (let k = 1; k <= parts; k++) {
      const t = k / parts;
      const vx = k === parts ? fw.bx : fw.ax + (fw.bx - fw.ax) * t;
      const vy = k === parts ? fw.by : fw.ay + (fw.by - fw.ay) * t;
      const nextId = getOrAddFwVertex(vx, vy);
      if (nextId !== prevId) {
        nodes[prevId].neighbors.push({ to: nextId, weight: subWeight });
        nodes[nextId].neighbors.push({ to: prevId, weight: subWeight });
      }
      prevId = nextId;
    }
  }

  const fairwayNodes = nodes.length - openGridNodes;
  const gridDiag = diagOut
    ? {
      cols,
      rows,
      stepM: Math.round(stepM),
      actualStepX: Math.round(actualStepX),
      actualStepY: Math.round(actualStepY),
      openGridNodes,
      blockedGridNodes,
      fairwayNodes,
      blockedReasonCounts,
    }
    : null;

  const startState = diagOut ? isPointBlocked(startXY[0], startXY[1], index, options) : null;
  const endState = diagOut ? isPointBlocked(endXY[0], endXY[1], index, options) : null;
  const startPointBlocked = startState
    ? { blocked: Boolean(startState.blocked), reason: startState.reason || null }
    : null;
  const endPointBlocked = endState
    ? { blocked: Boolean(endState.blocked), reason: endState.reason || null }
    : null;

  if (nodes.length === 0) {
    if (diagOut) {
      Object.assign(diagOut, {
        outcome: 'failed',
        failureCode: 'no-passable-nodes',
        grid: gridDiag,
        startPointBlocked,
        endPointBlocked,
        visitedNodes: 0,
        elapsedMs: Date.now() - t0,
      });
    }
    return null;
  }

  const findNearestAccessibleNode = (px, py) => {
    const maxDirectSearch = Math.max(400, stepM * 4);
    const maxApproachDist = Math.max(220, stepM * 2.2);
    const candidates = [];
    const approachCandidates = [];
    let nearestAnyNode = null;
    let nearestAnyDist = Infinity;

    for (const n of nodes) {
      const d = Math.hypot(n.x - px, n.y - py);
      if (d < nearestAnyDist) {
        nearestAnyDist = d;
        nearestAnyNode = n;
      }
      if (d <= maxDirectSearch) {
        candidates.push({ n, d });
      }
      if (d <= maxApproachDist) {
        approachCandidates.push({ n, d });
      }
    }

    let firstDirectReason = null;
    candidates.sort((a, b) => a.d - b.d);
    for (const { n, d } of candidates) {
      const segEval = evaluateSegment(px, py, n.x, n.y, index, options);
      if (!segEval.blocked) {
        return {
          anchor: { node: n, dist: d, viaApproach: false },
          info: { ok: true, distM: Math.round(d), viaApproach: false, candidatesInRadius: candidates.length },
        };
      }
      if (!firstDirectReason) firstDirectReason = segEval.reason || 'blocked';
    }

    let firstApproachReason = null;
    approachCandidates.sort((a, b) => a.d - b.d);
    for (const { n, d } of approachCandidates) {
      const landEval = evaluateSegment(px, py, n.x, n.y, index, {
        ...options,
        contourBuffer: 0,
        soundingBuffer: 0,
        shoreBuffer: 0,
        rockBuffer: 0,
        allowShallowWater: true,
      });
      if (!landEval.blocked) {
        return {
          anchor: { node: n, dist: d, viaApproach: true },
          info: { ok: true, distM: Math.round(d), viaApproach: true, candidatesInRadius: approachCandidates.length },
        };
      }
      if (!firstApproachReason) firstApproachReason = landEval.reason || 'blocked';
    }

    let nearestEvalReason = firstApproachReason || firstDirectReason || null;
    if (!nearestEvalReason && nearestAnyNode) {
      const ev = evaluateSegment(px, py, nearestAnyNode.x, nearestAnyNode.y, index, options);
      nearestEvalReason = ev.blocked
        ? ev.reason
        : nearestAnyDist > maxDirectSearch
          ? 'beyond-search-radius'
          : 'blocked';
    }

    return {
      anchor: null,
      info: {
        ok: false,
        nearestNodeDistM: Number.isFinite(nearestAnyDist) ? Math.round(nearestAnyDist) : null,
        maxSearchDistM: Math.round(maxDirectSearch),
        maxApproachDistM: Math.round(maxApproachDist),
        candidatesInRadius: candidates.length,
        blockReason: nearestEvalReason || 'no-nearby-nodes',
      },
    };
  };

  const startRes = findNearestAccessibleNode(startXY[0], startXY[1]);
  const endRes = findNearestAccessibleNode(endXY[0], endXY[1]);
  const startAnchor = startRes.anchor;
  const endAnchor = endRes.anchor;
  if (!startAnchor || !endAnchor) {
    if (diagOut) {
      Object.assign(diagOut, {
        outcome: 'failed',
        failureCode:
          !startAnchor && !endAnchor
            ? 'both-anchors-blocked'
            : !startAnchor
              ? 'start-anchor-blocked'
              : 'end-anchor-blocked',
        grid: gridDiag,
        startPointBlocked,
        endPointBlocked,
        startAnchorInfo: startRes.info,
        endAnchorInfo: endRes.info,
        visitedNodes: 0,
        elapsedMs: Date.now() - t0,
      });
    }
    return null;
  }

  const startId = startAnchor.node.id;
  const goalId = endAnchor.node.id;
  const goalNode = nodes[goalId];

  const gScore = new Float64Array(nodes.length).fill(Infinity);
  const cameFrom = new Int32Array(nodes.length).fill(-1);
  const closed = new Uint8Array(nodes.length);

  gScore[startId] = 0;
  const open = new MinHeap();
  const h = (n) => Math.hypot(goalNode.x - n.x, goalNode.y - n.y) * weights.hMult;
  open.push({ id: startId, f: h(nodes[startId]) });

  const dirs16 = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
    [2, 1], [2, -1], [-2, 1], [-2, -1],
    [1, 2], [1, -2], [-1, 2], [-1, -2],
  ];
  const connectRadius = Math.max(
    stepM * 2.35,
    Math.hypot(actualStepX * 2, actualStepY) + 1,
    Math.hypot(actualStepX, actualStepY * 2) + 1,
    165
  );
  const fwLinkRadius = Math.max(stepM * 1.45, 120);
  const fwRadCells = Math.ceil(fwLinkRadius / Math.min(actualStepX, actualStepY));

  const edgeEvalOptions = {
    ...options,
    skipFairwayCheckIfEndpointsOff: true,
    aOnFairway: false,
    bOnFairway: false,
  };

  const tryRelaxEdge = (u, vId, knownWeight = null, maxDist = connectRadius) => {
    if (closed[vId]) return;
    const v = nodes[vId];
    let weight = knownWeight;
    if (weight === null) {
      const dist = Math.hypot(v.x - u.x, v.y - u.y);
      if (dist > maxDist) return;
      if (gScore[u.id] + dist * weights.hMult >= gScore[vId]) return;
      edgeEvalOptions.aOnFairway = Boolean(u.onFairway);
      edgeEvalOptions.bOnFairway = Boolean(v.onFairway);
      const segEval = evaluateSegment(u.x, u.y, v.x, v.y, index, edgeEvalOptions);
      if (segEval.blocked) return;
      weight = dist * segEval.costMultiplier;
    }
    const tentativeG = gScore[u.id] + weight;
    if (tentativeG < gScore[vId]) {
      gScore[vId] = tentativeG;
      cameFrom[vId] = u.id;
      open.push({ id: vId, f: tentativeG + h(v) });
    }
  };

  let found = false;
  let visitedNodes = 0;
  let minGoalDistM = Infinity;
  let closestNodeToGoal = null;
  const wantTrace = Boolean(options.recordTrace && options.project);
  const rawExploredEdges = wantTrace ? [] : null;

  while (open.size > 0) {
    const cur = open.pop();
    if (cur.id === goalId) {
      visitedNodes++;
      if (wantTrace && cameFrom[cur.id] >= 0) {
        rawExploredEdges.push({ pId: cameFrom[cur.id], uId: cur.id });
      }
      found = true;
      break;
    }
    if (closed[cur.id]) continue;
    closed[cur.id] = 1;
    visitedNodes++;
    if (wantTrace && cameFrom[cur.id] >= 0) {
      rawExploredEdges.push({ pId: cameFrom[cur.id], uId: cur.id });
    }

    const u = nodes[cur.id];
    const goalDist = Math.hypot(goalNode.x - u.x, goalNode.y - u.y);
    if (goalDist < minGoalDistM) {
      minGoalDistM = goalDist;
      closestNodeToGoal = u;
    }

    // 1. Pre-connected fairway edges
    for (const edge of u.neighbors) {
      tryRelaxEdge(u, edge.to, edge.weight);
    }

    // 2. Lazy 16-dir grid neighbors & nearby fairway/grid links
    if (u.c >= 0) {
      for (const [dc, dr] of dirs16) {
        const nc = u.c + dc;
        const nr = u.r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const vId = gridNodeIds[nr * cols + nc];
        if (vId < 0 || closed[vId]) continue;
        tryRelaxEdge(u, vId);
      }
      for (let dr = -fwRadCells; dr <= fwRadCells; dr++) {
        const nr = u.r + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -fwRadCells; dc <= fwRadCells; dc++) {
          const nc = u.c + dc;
          if (nc < 0 || nc >= cols) continue;
          const bucket = fwNodesByCell.get(nr * cols + nc);
          if (!bucket) continue;
          for (const fwId of bucket) {
            if (!closed[fwId]) tryRelaxEdge(u, fwId, null, fwLinkRadius);
          }
        }
      }
    } else {
      for (let dr = -fwRadCells; dr <= fwRadCells; dr++) {
        const nr = u.cellR + dr;
        if (nr < 0 || nr >= rows) continue;
        for (let dc = -fwRadCells; dc <= fwRadCells; dc++) {
          const nc = u.cellC + dc;
          if (nc < 0 || nc >= cols) continue;
          const gId = gridNodeIds[nr * cols + nc];
          if (gId >= 0 && !closed[gId]) tryRelaxEdge(u, gId, null, fwLinkRadius);
          const bucket = fwNodesByCell.get(nr * cols + nc);
          if (bucket) {
            for (const fwId of bucket) {
              if (fwId !== u.id && !closed[fwId]) tryRelaxEdge(u, fwId, null, 55);
            }
          }
        }
      }
    }
  }

  const buildSearchTrace = (winningRawPath = null) => {
    if (!wantTrace || !diagOut) return null;
    const nEdges = rawExploredEdges.length;
    const MAX_TRACE_EDGES = 450;
    const sampleCount = Math.min(nEdges, MAX_TRACE_EDGES);
    const edges = [];
    for (let i = 0; i < sampleCount; i++) {
      const idx =
        sampleCount <= 1 || nEdges <= MAX_TRACE_EDGES
          ? i
          : Math.min(nEdges - 1, Math.floor((i * (nEdges - 1)) / (sampleCount - 1)));
      const { pId, uId } = rawExploredEdges[idx];
      const p = nodes[pId];
      const u = nodes[uId];
      const [lat1, lon1] = options.project.toLatLon(p.x, p.y);
      const [lat2, lon2] = options.project.toLatLon(u.x, u.y);
      edges.push([
        Number(lat1.toFixed(5)),
        Number(lon1.toFixed(5)),
        Number(lat2.toFixed(5)),
        Number(lon2.toFixed(5)),
        p.onFairway && u.onFairway ? 1 : 0,
      ]);
    }

    const milestoneCount = Math.min(18, nEdges);
    const probePaths = [];
    for (let m = 0; m < milestoneCount; m++) {
      const edgeIdx =
        milestoneCount <= 1 ? 0 : Math.floor((m * (nEdges - 1)) / (milestoneCount - 1));
      let traceId = rawExploredEdges[edgeIdx].uId;
      const chainIds = [];
      let guard = 0;
      while (traceId !== -1 && guard < nodes.length) {
        chainIds.push(traceId);
        traceId = cameFrom[traceId];
        guard++;
      }
      chainIds.reverse();
      const maxPts = 25;
      let chosenIds = chainIds;
      if (chainIds.length > maxPts) {
        chosenIds = [];
        for (let k = 0; k < maxPts; k++) {
          const ci = Math.min(chainIds.length - 1, Math.floor((k * (chainIds.length - 1)) / (maxPts - 1)));
          chosenIds.push(chainIds[ci]);
        }
      }
      probePaths.push(
        chosenIds.map((nid) => {
          const [lat, lon] = options.project.toLatLon(nodes[nid].x, nodes[nid].y);
          return [Number(lat.toFixed(5)), Number(lon.toFixed(5))];
        })
      );
    }

    const rawWinningPath = winningRawPath
      ? winningRawPath.map((pt) => {
        const [lat, lon] = options.project.toLatLon(pt.x, pt.y);
        return [Number(lat.toFixed(5)), Number(lon.toFixed(5))];
      })
      : null;

    return { edges, probePaths, rawWinningPath };
  };

  if (!found) {
    if (diagOut) {
      Object.assign(diagOut, {
        outcome: 'failed',
        failureCode: 'graph-disconnected',
        grid: gridDiag,
        startPointBlocked,
        endPointBlocked,
        startAnchorInfo: startRes.info,
        endAnchorInfo: endRes.info,
        visitedNodes,
        closestNodeXY: closestNodeToGoal ? [closestNodeToGoal.x, closestNodeToGoal.y] : null,
        remainingDistToGoalM: Number.isFinite(minGoalDistM) ? Math.round(minGoalDistM) : null,
        trace: buildSearchTrace(null),
        elapsedMs: Date.now() - t0,
      });
    }
    return null;
  }

  const rawPath = [];
  let trace = goalId;
  while (trace !== -1) {
    const n = nodes[trace];
    rawPath.push({ x: n.x, y: n.y, kind: n.kind, onFairway: Boolean(n.onFairway) });
    trace = cameFrom[trace];
  }
  rawPath.reverse();

  // Prepend actual Start and append actual End
  if (Math.hypot(rawPath[0].x - startXY[0], rawPath[0].y - startXY[1]) > 8) {
    rawPath.unshift({
      x: startXY[0],
      y: startXY[1],
      kind: startAnchor.viaApproach ? 'approach-start' : 'start',
      onFairway: false,
    });
  } else {
    rawPath[0].x = startXY[0];
    rawPath[0].y = startXY[1];
  }

  const last = rawPath[rawPath.length - 1];
  if (Math.hypot(last.x - endXY[0], last.y - endXY[1]) > 8) {
    rawPath.push({
      x: endXY[0],
      y: endXY[1],
      kind: endAnchor.viaApproach ? 'approach-end' : 'end',
      onFairway: false,
    });
  } else {
    last.x = endXY[0];
    last.y = endXY[1];
  }

  if (diagOut) {
    Object.assign(diagOut, {
      outcome: 'ok',
      failureCode: null,
      grid: gridDiag,
      startPointBlocked,
      endPointBlocked,
      startAnchorInfo: startRes.info,
      endAnchorInfo: endRes.info,
      visitedNodes,
      rawPathLen: rawPath.length,
      usedApproachStart: startAnchor.viaApproach,
      usedApproachEnd: endAnchor.viaApproach,
      trace: buildSearchTrace(rawPath),
      elapsedMs: Date.now() - t0,
    });
  }

  return {
    rawPath,
    usedApproachStart: startAnchor.viaApproach,
    usedApproachEnd: endAnchor.viaApproach,
  };
}

function smoothPath(rawPath, index, options = {}) {
  if (!rawPath || rawPath.length <= 2) return rawPath || [];
  const weights = getRoutingModeWeights(options.routingMode);

  // Compute cumulative weighted cost along raw path segments and prefix fairway counts
  const cumCost = [0];
  const fwPrefix = new Int32Array(rawPath.length);
  fwPrefix[0] = rawPath[0].onFairway ? 1 : 0;
  for (let i = 0; i < rawPath.length - 1; i++) {
    const a = rawPath[i];
    const b = rawPath[i + 1];
    fwPrefix[i + 1] = fwPrefix[i] + (b.onFairway ? 1 : 0);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const ev = evaluateSegment(a.x, a.y, b.x, b.y, index, {
      ...options,
      aOnFairway: Boolean(a.onFairway),
      bOnFairway: Boolean(b.onFairway),
      skipFairwayCheckIfEndpointsOff: true,
    });
    const mult = ev.blocked ? (a.onFairway && b.onFairway ? weights.shallowFwMult : 3.5) : ev.costMultiplier;
    cumCost.push(cumCost[i] + dist * mult);
  }

  const smoothed = [rawPath[0]];
  let anchorIdx = 0;

  while (anchorIdx < rawPath.length - 1) {
    let bestNext = anchorIdx + 1;
    // Try jumping as far ahead as line-of-sight and fairway-staying allow
    for (let probe = rawPath.length - 1; probe > anchorIdx + 1; probe--) {
      // Do not string-pull across approach endpoints so approach legs remain explicit
      if (rawPath[anchorIdx].kind === 'approach-start' && probe > anchorIdx + 1) continue;
      if (rawPath[probe].kind === 'approach-end' && probe < rawPath.length - 1) continue;

      const a = rawPath[anchorIdx];
      const b = rawPath[probe];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const subCost = cumCost[probe] - cumCost[anchorIdx];
      const maxAllowedCost = subCost * 1.03;

      if (dist * weights.verifiedMult > maxAllowedCost) {
        continue;
      }

      let precomputedFwMatch;
      if (!weights.allowOpenWaterShortcut) {
        const hasFairwayNodes =
          Boolean(a.onFairway && b.onFairway) ||
          (probe - anchorIdx > 1 && fwPrefix[probe - 1] - fwPrefix[anchorIdx] > 0);
        if (hasFairwayNodes) {
          const fwMatch = segmentNearSafeFairway(a.x, a.y, b.x, b.y, index, 5, true);
          if (!fwMatch) continue;
          precomputedFwMatch = fwMatch;
        }
      }

      const ev = evaluateSegment(a.x, a.y, b.x, b.y, index, {
        ...options,
        precomputedFwMatch,
        aOnFairway: Boolean(a.onFairway),
        bOnFairway: Boolean(b.onFairway),
        skipFairwayCheckIfEndpointsOff: precomputedFwMatch === undefined,
        maxAllowedCost,
        fastLongSegmentCheck: dist > 350,
      });
      if (ev.blocked) continue;

      const directCost = dist * ev.costMultiplier;
      if (directCost <= maxAllowedCost) {
        bestNext = probe;
        break;
      }
    }

    smoothed.push(rawPath[bestNext]);
    anchorIdx = bestNext;
  }

  return smoothed;
}

function flipsBuoySide(axOrig, ayOrig, bxOrig, byOrig, axNew, ayNew, bxNew, byNew, index) {
  if (!index?.seamarkIndex) return false;
  const minX = Math.min(axOrig, bxOrig, axNew, bxNew) - 85;
  const minY = Math.min(ayOrig, byOrig, ayNew, byNew) - 85;
  const maxX = Math.max(axOrig, bxOrig, axNew, bxNew) + 85;
  const maxY = Math.max(ayOrig, byOrig, ayNew, byNew) + 85;
  const marks = index.seamarkIndex.query(minX, minY, maxX, maxY);
  const odx = bxOrig - axOrig;
  const ody = byOrig - ayOrig;
  const ndx = bxNew - axNew;
  const ndy = byNew - ayNew;
  for (const m of marks) {
    if (m.role !== 'lateral-port' && m.role !== 'lateral-starboard') continue;
    if (pointToSegmentDist(m.x, m.y, axOrig, ayOrig, bxOrig, byOrig) > 80) continue;
    const origCross = odx * (m.y - ayOrig) - ody * (m.x - axOrig);
    const newCross = ndx * (m.y - ayNew) - ndy * (m.x - axNew);
    if (Math.abs(origCross) > 1e-3 && origCross * newCross <= 0) {
      return true;
    }
  }
  return false;
}

/**
 * Shift interior fairway waypoints laterally to Starboard (+) or Port (-) of the fairway
 * centerline, stepping down the offset if depth/land/seamark checks or buoy side checks fail.
 */
function applyFairwayOffset(segPts, signedOffsetM, index, options = {}) {
  if (!Array.isArray(segPts) || segPts.length < 2 || Math.abs(signedOffsetM) < 1) {
    return segPts;
  }

  let pts = segPts.map((p) => ({ ...p }));
  if (pts.length === 2) {
    const fw0 = segmentNearSafeFairway(pts[0].x, pts[0].y, pts[1].x, pts[1].y, index, 10, true);
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    if (fw0 && dist > 120) {
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      pts = [
        pts[0],
        { x: pts[0].x + dx * 0.2, y: pts[0].y + dy * 0.2, kind: 'fairway-node', onFairway: true },
        { x: pts[0].x + dx * 0.8, y: pts[0].y + dy * 0.8, kind: 'fairway-node', onFairway: true },
        pts[1],
      ];
    }
  }

  if (pts.length < 3) return pts;

  const origPts = pts.map((p) => ({ ...p }));
  const legFwSegs = [];
  const legNormals = [];
  for (let i = 0; i < origPts.length - 1; i++) {
    const a = origPts[i];
    const b = origPts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const fw = len > 1e-3 ? segmentNearSafeFairway(a.x, a.y, b.x, b.y, index, 10, true) : null;
    legFwSegs.push(fw);
    // Unit Starboard normal in +x East, +y North local meters: (dy/len, -dx/len)
    legNormals.push(len > 1e-3 ? { nx: dy / len, ny: -dx / len } : null);
  }

  const checkOpts = {
    ...options,
    contourBuffer: Math.min(12, Math.max(6, Math.round((options.contourBuffer ?? 16) * 0.6))),
    soundingBuffer: Math.min(16, Math.max(8, Math.round((options.soundingBuffer ?? 22) * 0.6))),
    relaxFactor: 0.75,
  };

  const scales = [1.0, 0.75, 0.5, 0.35, 0.2];
  for (let k = 1; k < pts.length - 1; k++) {
    const fwPrev = legFwSegs[k - 1];
    const fwNext = legFwSegs[k];
    if (!fwPrev && !fwNext) continue;

    let nx = 0;
    let ny = 0;
    if (fwPrev && fwNext && legNormals[k - 1] && legNormals[k]) {
      const n1 = legNormals[k - 1];
      const n2 = legNormals[k];
      const sx = n1.nx + n2.nx;
      const sy = n1.ny + n2.ny;
      const sLen = Math.hypot(sx, sy);
      if (sLen > 0.2) {
        const ux = sx / sLen;
        const uy = sy / sLen;
        const dot = ux * n1.nx + uy * n1.ny;
        const miterScale = dot > 0.35 ? Math.min(1.45, 1 / dot) : 1.0;
        nx = ux * miterScale;
        ny = uy * miterScale;
      } else {
        nx = n1.nx;
        ny = n1.ny;
      }
    } else {
      const n = fwPrev ? legNormals[k - 1] : legNormals[k];
      if (!n) continue;
      nx = n.nx;
      ny = n.ny;
    }

    const prev = pts[k - 1];
    const curOrig = origPts[k];
    const nextOrig = origPts[k + 1];
    const prevOrig = origPts[k - 1];
    const fwSeg = fwPrev || fwNext;

    for (const scale of scales) {
      const candOffset = signedOffsetM * scale;
      const candX = curOrig.x + nx * candOffset;
      const candY = curOrig.y + ny * candOffset;

      if (isPointBlocked(candX, candY, index, checkOpts).blocked) continue;
      if (evaluateSegment(prev.x, prev.y, candX, candY, index, checkOpts).blocked) continue;
      if (evaluateSegment(candX, candY, nextOrig.x, nextOrig.y, index, checkOpts).blocked) continue;
      if (flipsBuoySide(prevOrig.x, prevOrig.y, curOrig.x, curOrig.y, prev.x, prev.y, candX, candY, index)) continue;
      if (flipsBuoySide(curOrig.x, curOrig.y, nextOrig.x, nextOrig.y, candX, candY, nextOrig.x, nextOrig.y, index)) continue;

      pts[k] = {
        ...curOrig,
        x: candX,
        y: candY,
        onFairway: true,
        offsetFwSeg: fwSeg,
        appliedOffsetM: candOffset,
      };
      break;
    }
  }

  return pts;
}

/**
 * Smooth sharp fairway and waterway turns by replacing angular apex vertices
 * with nautical circular fillet arcs (controlled turn radius).
 * Checks depth clearance, shoreline margins, rocks, and buoy sides.
 */
function roundSharpCorners(rawPts, index, options = {}) {
  if (!Array.isArray(rawPts) || rawPts.length < 3) return rawPts || [];
  const turnRadiusM = options.turnRadiusM != null ? Number(options.turnRadiusM) : 100;
  if (turnRadiusM <= 0) return rawPts;

  let pts = rawPts.map((p) => ({ ...p }));
  const out = [pts[0]];

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const next = pts[i + 1];

    // Do not round approach anchors or explicit via points
    if (cur.role === 'via' || cur.kind === 'approach-start' || cur.kind === 'approach-end') {
      out.push(cur);
      continue;
    }

    const dxIn = cur.x - prev.x;
    const dyIn = cur.y - prev.y;
    const lenIn = Math.hypot(dxIn, dyIn);

    const dxOut = next.x - cur.x;
    const dyOut = next.y - cur.y;
    const lenOut = Math.hypot(dxOut, dyOut);

    if (lenIn < 25 || lenOut < 25) {
      out.push(cur);
      continue;
    }

    const uInX = dxIn / lenIn;
    const uInY = dyIn / lenIn;
    const uOutX = dxOut / lenOut;
    const uOutY = dyOut / lenOut;

    const dot = uInX * uOutX + uInY * uOutY;
    // Straight line (< 20 deg turn) or near 180 reverse
    if (dot > 0.94 || dot < -0.965) {
      out.push(cur);
      continue;
    }

    const turnAngleRad = Math.acos(Math.max(-1, Math.min(1, dot)));
    const halfAngle = turnAngleRad / 2;
    const tanHalf = Math.tan(halfAngle);
    if (!Number.isFinite(tanHalf) || tanHalf <= 0) {
      out.push(cur);
      continue;
    }

    const targetT = turnRadiusM * tanHalf;
    // Cap at 42% of leg lengths so adjacent corners don't overlap
    const maxT = Math.min(lenIn * 0.42, lenOut * 0.42);
    const initialT = Math.min(targetT, maxT);

    if (initialT < 12) {
      out.push(cur);
      continue;
    }

    const scales = [1.0, 0.7, 0.45];
    let acceptedFillet = null;

    const evalOpts = {
      ...options,
      skipFairwayCheckIfEndpointsOff: true,
      aOnFairway: Boolean(cur.onFairway),
      bOnFairway: Boolean(cur.onFairway),
      contourBuffer: Math.min(12, Math.max(6, Math.round((options.contourBuffer ?? 16) * 0.6))),
      soundingBuffer: Math.min(16, Math.max(8, Math.round((options.soundingBuffer ?? 22) * 0.6))),
      relaxFactor: 0.75,
    };

    for (const scale of scales) {
      const T = initialT * scale;
      if (T < 10) break;

      const sx = cur.x - T * uInX;
      const sy = cur.y - T * uInY;
      const ex = cur.x + T * uOutX;
      const ey = cur.y + T * uOutY;

      const chordDist = Math.hypot(ex - sx, ey - sy);
      const numSteps = Math.max(2, Math.min(5, Math.round(chordDist / 25)));

      const arcPts = [];
      let allSafe = true;

      for (let s = 1; s < numSteps; s++) {
        const t = s / numSteps;
        const omt = 1 - t;
        const qx = omt * omt * sx + 2 * omt * t * cur.x + t * t * ex;
        const qy = omt * omt * sy + 2 * omt * t * cur.y + t * t * ey;

        const blkQ = isPointBlocked(qx, qy, index, evalOpts);
        if (blkQ.blocked) {
          if (cur.role === 'manual') console.log('[fillet] arc blocked reason:', blkQ.reason);
          allSafe = false;
          break;
        }

        arcPts.push({
          x: qx,
          y: qy,
          kind: cur.kind || 'fairway-node',
          onFairway: Boolean(cur.onFairway),
          isFillet: true,
          filletFwSeg: cur.offsetFwSeg || true,
        });
      }

      if (!allSafe) continue;

      if (isPointBlocked(sx, sy, index, evalOpts).blocked) continue;
      if (isPointBlocked(ex, ey, index, evalOpts).blocked) continue;

      if (evaluateSegment(prev.x, prev.y, sx, sy, index, evalOpts).blocked) continue;
      let segsSafe = true;
      const poly = [{ x: sx, y: sy }, ...arcPts, { x: ex, y: ey }];
      for (let k = 0; k < poly.length - 1; k++) {
        if (evaluateSegment(poly[k].x, poly[k].y, poly[k + 1].x, poly[k + 1].y, index, evalOpts).blocked) {
          segsSafe = false;
          break;
        }
      }
      if (!segsSafe) continue;
      if (evaluateSegment(ex, ey, next.x, next.y, index, evalOpts).blocked) continue;

      if (flipsBuoySide(prev.x, prev.y, cur.x, cur.y, prev.x, prev.y, sx, sy, index)) continue;
      if (flipsBuoySide(cur.x, cur.y, next.x, next.y, ex, ey, next.x, next.y, index)) continue;

      acceptedFillet = [
        { x: sx, y: sy, kind: cur.kind || 'fairway-node', onFairway: Boolean(cur.onFairway), isFillet: true, filletFwSeg: cur.offsetFwSeg || true },
        ...arcPts,
        { x: ex, y: ey, kind: cur.kind || 'fairway-node', onFairway: Boolean(cur.onFairway), isFillet: true, filletFwSeg: cur.offsetFwSeg || true },
      ];
      break;
    }

    if (acceptedFillet) {
      for (const fpt of acceptedFillet) {
        out.push(fpt);
      }
    } else {
      out.push(cur);
    }
  }

  out.push(pts[pts.length - 1]);
  return out;
}

async function computeMarineRoute(params) {
  let startLat = params.has('startLat') && params.get('startLat') !== '' ? Number(params.get('startLat')) : NaN;
  let startLon = params.has('startLon') && params.get('startLon') !== '' ? Number(params.get('startLon')) : NaN;
  let endLat = params.has('endLat') && params.get('endLat') !== '' ? Number(params.get('endLat')) : NaN;
  let endLon = params.has('endLon') && params.get('endLon') !== '' ? Number(params.get('endLon')) : NaN;

  const rawDraftParam = params.get('draft');
  const rawVesselDraft = params.get('vesselDraft');
  const rawUkc = params.get('ukc');
  const parsedVesselDraft =
    rawVesselDraft !== null && rawVesselDraft !== '' && Number.isFinite(Number(rawVesselDraft))
      ? Math.max(0.2, Math.min(25, Number(rawVesselDraft)))
      : null;
  const parsedUkc =
    rawUkc !== null && rawUkc !== '' && Number.isFinite(Number(rawUkc))
      ? Math.max(0, Math.min(10, Number(rawUkc)))
      : null;

  let draft = 3.0;
  if (parsedVesselDraft !== null && parsedUkc !== null) {
    draft = Math.max(0.5, Math.min(25, parsedVesselDraft + parsedUkc));
  } else if (rawDraftParam !== null && rawDraftParam !== '' && Number.isFinite(Number(rawDraftParam))) {
    draft = Math.max(0.5, Math.min(25, Number(rawDraftParam)));
  }

  const seaLevelCm = Math.max(-150, Math.min(200, Number(params.get('seaLevelCm')) || 0));
  const speedKn = Math.max(1, Math.min(45, Number(params.get('speedKn')) || 12));
  const routingMode = ['balanced', 'strict_fairway', 'open_water'].includes(params.get('routingMode'))
    ? params.get('routingMode')
    : 'balanced';
  const clearanceMode = ['normal', 'tight', 'wide'].includes(params.get('clearanceMode'))
    ? params.get('clearanceMode')
    : 'normal';
  const avoidFaulty = params.get('avoidFaulty') !== '0';
  const fairwayOffsetSide = ['center', 'starboard', 'port'].includes(params.get('fairwayOffsetSide'))
    ? params.get('fairwayOffsetSide')
    : 'center';
  const rawOffsetM = Number(params.get('fairwayOffsetM'));
  const fairwayOffsetM =
    fairwayOffsetSide === 'center'
      ? 0
      : Number.isFinite(rawOffsetM)
        ? Math.max(0, Math.min(100, rawOffsetM))
        : 0;
  const signedOffsetM =
    fairwayOffsetSide === 'port' ? -fairwayOffsetM : fairwayOffsetSide === 'starboard' ? fairwayOffsetM : 0;
  const rawShoreMargin = params.get('shoreMarginM');
  const shoreMarginM =
    rawShoreMargin !== null && rawShoreMargin !== '' && Number.isFinite(Number(rawShoreMargin))
      ? Math.max(0, Math.min(150, Number(rawShoreMargin)))
      : 0;
  const rawTurnRadius = params.get('turnRadiusM');
  const turnRadiusM =
    rawTurnRadius !== null && rawTurnRadius !== '' && Number.isFinite(Number(rawTurnRadius))
      ? Math.max(0, Math.min(500, Number(rawTurnRadius)))
      : 100;
  const avoidRocks = params.get('avoidRocks') !== '0';
  const viaPoints = parseLatLonList(params.get('vias'), 15);
  const manualPts = parseLatLonList(params.get('manualWaypoints'), 250);
  const recordTrace = params.get('trace') === '1';

  // Multi-objective / Pareto alternatives
  // alternatives=2|3  or  objectives=balanced,fast,safe  (max 3)
  let requestedObjectives = [];
  const rawObjectives = (params.get('objectives') || '').trim();
  if (rawObjectives) {
    requestedObjectives = rawObjectives
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((id) => OBJECTIVE_PROFILES[id])
      .slice(0, 3);
  }
  const altCount = Math.max(1, Math.min(3, Number(params.get('alternatives')) || 0));
  if (requestedObjectives.length === 0 && altCount > 1) {
    // Sensible default set when only a count is given
    requestedObjectives = ['balanced', 'fast', 'safe'].slice(0, altCount);
  }
  if (requestedObjectives.length === 0) {
    // Single primary route — map user routingMode/clearance to a profile id when possible
    const primaryId =
      routingMode === 'strict_fairway'
        ? 'fairway'
        : routingMode === 'open_water'
          ? 'fast'
          : clearanceMode === 'wide'
            ? 'safe'
            : 'balanced';
    requestedObjectives = [primaryId];
  }

  if (![startLat, startLon, endLat, endLon].every(Number.isFinite) && manualPts.length >= 2) {
    startLat = manualPts[0].lat;
    startLon = manualPts[0].lon;
    endLat = manualPts[manualPts.length - 1].lat;
    endLon = manualPts[manualPts.length - 1].lon;
  }

  if (![startLat, startLon, endLat, endLon].every(Number.isFinite)) {
    throw new Error('Missing or invalid startLat, startLon, endLat, endLon');
  }

  const routeComputeStartMs = Date.now();
  const effectiveSafeDepth = Math.max(0.5, Number((draft - seaLevelCm / 100).toFixed(2)));
  const allBoundsPts = [
    { lat: startLat, lon: startLon },
    ...viaPoints,
    ...manualPts,
    { lat: endLat, lon: endLon },
  ];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const pt of allBoundsPts) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lon < minLon) minLon = pt.lon;
    if (pt.lon > maxLon) maxLon = pt.lon;
  }

  const sLat = minLat - 0.035;
  const nLat = maxLat + 0.035;
  const wLon = minLon - 0.055;
  const eLon = maxLon + 0.055;

  const fetchStartMs = Date.now();
  const corridorData = await fetchRouteCorridorData([sLat, wLon, nLat, eLon]);
  const fetchMs = Date.now() - fetchStartMs;

  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const mPerDegLat = 111132;
  const project = {
    toXY: (lat, lon) => [(lon - midLon) * mPerDegLon, (lat - midLat) * mPerDegLat],
    toLatLon: (x, y) => [midLat + y / mPerDegLat, midLon + x / mPerDegLon],
  };

  const indexCacheKey = `${corridorData.bbox.join(',')}|${midLat.toFixed(6)},${midLon.toFixed(6)}|${effectiveSafeDepth}|${corridorData.warnings?.length || 0}`;
  let index = spatialIndexCache.get(indexCacheKey);
  if (index) {
    spatialIndexCache.delete(indexCacheKey);
    spatialIndexCache.set(indexCacheKey, index);
  } else {
    index = buildSpatialIndex(corridorData, project, effectiveSafeDepth);
    if (spatialIndexCache.size >= 20) {
      spatialIndexCache.delete(spatialIndexCache.keys().next().value);
    }
    spatialIndexCache.set(indexCacheKey, index);
  }

  const clearancePresets = {
    tight: { contourBuffer: 8, soundingBuffer: 12, rockBuffer: 12, relaxFactor: 0.75 },
    normal: { contourBuffer: 16, soundingBuffer: 22, rockBuffer: 20, relaxFactor: 1.0 },
    wide: { contourBuffer: 28, soundingBuffer: 34, rockBuffer: 30, relaxFactor: 1.3 },
  };
  const baseClearance = clearancePresets[clearanceMode] || clearancePresets.normal;

  // Multi-objective: we may run several independent searches that share the
  // expensive corridor data + spatial indexes. Each profile gets its own
  // clearance buffers, routingMode weights and shore/rock margins.
  const multiObjective = requestedObjectives.length > 1 && manualPts.length < 2;

  // Helper that runs the full stop-chain path search for one objective profile.
  // Returns the same intermediate state the original single-path code produced.
  function runObjectiveSearch(profile) {
    const rm = profile.routingMode || routingMode;
    const cm = profile.clearanceMode || clearanceMode;
    const baseClearance = clearancePresets[cm] || clearancePresets.normal;
    const localShoreMargin = Math.max(
      0,
      Math.min(150, shoreMarginM + (profile.shoreMarginBoost || 0))
    );
    const localRockBuf = avoidRocks
      ? Math.max(0, baseClearance.rockBuffer + (profile.rockBufferBoost || 0))
      : 0;

    let usedFallback = false;
    let usedShallowWaterFallback = false;
    let routeFailed = false;
    let waypointsXY = [];
    const debugSegments = [];
    const debugMapMarkers = [];
    const failureExplanations = [];

    const stops = [{ lat: startLat, lon: startLon }, ...viaPoints, { lat: endLat, lon: endLon }];
    const [bboxMinX, bboxMinY] = project.toXY(corridorData.bbox[0], corridorData.bbox[1]);
    const [bboxMaxX, bboxMaxY] = project.toXY(corridorData.bbox[2], corridorData.bbox[3]);

    for (let segIdx = 0; segIdx < stops.length - 1; segIdx++) {
      const segStartXY = project.toXY(stops[segIdx].lat, stops[segIdx].lon);
      const segEndXY = project.toXY(stops[segIdx + 1].lat, stops[segIdx + 1].lon);
      const segDistM = Math.hypot(segEndXY[0] - segStartXY[0], segEndXY[1] - segStartXY[1]);
      const padM = Math.max(1800, Math.min(4200, segDistM * 0.55));
      const boundsXY = {
        minX: Math.max(bboxMinX, Math.min(segStartXY[0], segEndXY[0]) - padM),
        minY: Math.max(bboxMinY, Math.min(segStartXY[1], segEndXY[1]) - padM),
        maxX: Math.min(bboxMaxX, Math.max(segStartXY[0], segEndXY[0]) + padM),
        maxY: Math.min(bboxMaxY, Math.max(segStartXY[1], segEndXY[1]) + padM),
      };

      const stages = [
        {
          label: 'Normal clearance',
          contourBuffer: baseClearance.contourBuffer,
          soundingBuffer: baseClearance.soundingBuffer,
          shoreBuffer: localShoreMargin,
          rockBuffer: localRockBuf,
          relaxFactor: baseClearance.relaxFactor,
          allowShallowFairways: false,
          allowShallowWater: false,
          routingMode: rm,
          avoidFaulty,
        },
        {
          label: 'Relaxed + shallow fairways',
          contourBuffer: Math.min(8, Math.round(baseClearance.contourBuffer * 0.5)),
          soundingBuffer: Math.min(12, Math.round(baseClearance.soundingBuffer * 0.55)),
          shoreBuffer: Math.min(12, Math.round(localShoreMargin * 0.5)),
          rockBuffer: avoidRocks ? Math.min(10, Math.round(localRockBuf * 0.5)) : 0,
          relaxFactor: Math.min(0.7, baseClearance.relaxFactor * 0.7),
          allowShallowFairways: true,
          allowShallowWater: false,
          routingMode: rm,
          avoidFaulty,
        },
        {
          label: 'Emergency relaxed shallow water',
          contourBuffer: 0,
          soundingBuffer: 6,
          shoreBuffer: 0,
          rockBuffer: avoidRocks ? 6 : 0,
          relaxFactor: 0.5,
          allowShallowFairways: true,
          allowShallowWater: true,
          routingMode: rm,
          avoidFaulty,
        },
      ];

      const stageAttempts = [];
      const segCache = {};
      const runStage = (stageNum, opts) => {
        const diag = {};
        const res = findGridAndFairwayPath(
          segStartXY,
          segEndXY,
          boundsXY,
          index,
          { ...opts, recordTrace, project, segCache },
          diag
        );
        stageAttempts.push({
          stage: stageNum,
          label: opts.label,
          contourBuffer: opts.contourBuffer,
          soundingBuffer: opts.soundingBuffer,
          shoreBuffer: opts.shoreBuffer,
          relaxFactor: opts.relaxFactor,
          allowShallowFairways: opts.allowShallowFairways,
          allowShallowWater: opts.allowShallowWater,
          ...diag,
        });
        return res;
      };

      let routeOptions = stages[0];
      let searchResult = runStage(1, routeOptions);
      let segUsedFallback = false;

      if (!searchResult) {
        usedFallback = true;
        segUsedFallback = true;
        routeOptions = stages[1];
        searchResult = runStage(2, routeOptions);
      }

      if (!searchResult) {
        usedFallback = true;
        segUsedFallback = true;
        usedShallowWaterFallback = true;
        routeOptions = stages[2];
        searchResult = runStage(3, routeOptions);
      }

      const directLineCheck =
        !searchResult || segUsedFallback
          ? inspectSegmentObstructions(
            segStartXY[0],
            segStartXY[1],
            segEndXY[0],
            segEndXY[1],
            index,
            project,
            effectiveSafeDepth,
            stages[0]
          )
          : null;

      let segPts;
      let farthestReached = null;
      let primaryObstruction = null;
      let failureExplanation = null;
      const lastDiag = stageAttempts[stageAttempts.length - 1] || {};

      if (!searchResult) {
        routeFailed = true;
        if (lastDiag.closestNodeXY) {
          const [fLat, fLon] = project.toLatLon(lastDiag.closestNodeXY[0], lastDiag.closestNodeXY[1]);
          farthestReached = {
            lat: Number(fLat.toFixed(6)),
            lon: Number(fLon.toFixed(6)),
          };
        }
        const frontierCheck = lastDiag.closestNodeXY
          ? inspectSegmentObstructions(
            lastDiag.closestNodeXY[0],
            lastDiag.closestNodeXY[1],
            segEndXY[0],
            segEndXY[1],
            index,
            project,
            effectiveSafeDepth,
            stages[2]
          )
          : null;
        primaryObstruction = frontierCheck?.firstObstruction || directLineCheck?.firstObstruction || null;

        const segPrefix = stops.length > 2 ? `Segment ${segIdx + 1}: ` : '';
        const fc = lastDiag.failureCode || 'failed';
        if (fc === 'no-passable-nodes') {
          failureExplanation = `${segPrefix}No passable water nodes found in corridor grid (${lastDiag.grid?.cols}x${lastDiag.grid?.rows}, all ${lastDiag.grid?.blockedGridNodes} cells blocked).`;
        } else if (fc === 'start-anchor-blocked' || fc === 'end-anchor-blocked' || fc === 'both-anchors-blocked') {
          const segOutsideBbox =
            stops[segIdx].lon < corridorData.bbox[1] ||
            stops[segIdx].lon > corridorData.bbox[3] ||
            stops[segIdx].lat < corridorData.bbox[0] ||
            stops[segIdx].lat > corridorData.bbox[2] ||
            stops[segIdx + 1].lon < corridorData.bbox[1] ||
            stops[segIdx + 1].lon > corridorData.bbox[3] ||
            stops[segIdx + 1].lat < corridorData.bbox[0] ||
            stops[segIdx + 1].lat > corridorData.bbox[2];

          if (segOutsideBbox) {
            const segDistNm = segDistM / 1852;
            failureExplanation = `${segPrefix}Voyage distance (${segDistNm.toFixed(0)} NM) exceeds the single-corridor chart limit (max ~75 NM / 2.5°). For long-distance passages across multiple sea regions (e.g., Helsinki to Åland), please break the voyage into legs using Via-points (e.g., Porkkala, Hanko, Kökar), or use 'Draw by Hand'.`;
          } else {
            const parts = [];
            if (fc !== 'end-anchor-blocked') {
              const nameA = segIdx === 0 ? 'Start (A)' : `Via V${segIdx}`;
              const reasonA = lastDiag.startPointBlocked?.blocked
                ? lastDiag.startPointBlocked.reason
                : lastDiag.startAnchorInfo?.blockReason || 'blocked';
              parts.push(
                `${nameA} (${stops[segIdx].lat.toFixed(4)}° N, ${stops[segIdx].lon.toFixed(4)}° E) could not connect to water grid (blocked by ${reasonA})`
              );
            }
            if (fc !== 'start-anchor-blocked') {
              const nameB = segIdx === stops.length - 2 ? 'Destination (B)' : `Via V${segIdx + 1}`;
              const reasonB = lastDiag.endPointBlocked?.blocked
                ? lastDiag.endPointBlocked.reason
                : lastDiag.endAnchorInfo?.blockReason || 'blocked';
              parts.push(
                `${nameB} (${stops[segIdx + 1].lat.toFixed(4)}° N, ${stops[segIdx + 1].lon.toFixed(4)}° E) could not connect to water grid (blocked by ${reasonB})`
              );
            }
            failureExplanation = `${segPrefix}${parts.join('; ')}.`;
          }
        } else {
          const obsText = primaryObstruction
            ? `blocked near ${primaryObstruction.lat.toFixed(4)}° N, ${primaryObstruction.lon.toFixed(4)}° E by ${primaryObstruction.detail}`
            : 'disconnected water components';
          const frontierText =
            farthestReached && lastDiag.remainingDistToGoalM != null
              ? ` A* explored ${lastDiag.visitedNodes} nodes and stopped at ${farthestReached.lat.toFixed(4)}° N, ${farthestReached.lon.toFixed(4)}° E (${(lastDiag.remainingDistToGoalM / 1852).toFixed(2)} NM from destination).`
              : '';
          failureExplanation = `${segPrefix}Water passage disconnected (${fc}): ${obsText}.${frontierText}`;
        }
        failureExplanations.push(failureExplanation);

        segPts = [
          { x: segStartXY[0], y: segStartXY[1], kind: 'direct', onFairway: false },
          { x: segEndXY[0], y: segEndXY[1], kind: 'direct', onFairway: false },
        ];
      } else {
        segPts = smoothPath(searchResult.rawPath, index, routeOptions);
        if (Math.abs(signedOffsetM) >= 1) {
          segPts = applyFairwayOffset(segPts, signedOffsetM, index, routeOptions);
        }
        if (turnRadiusM > 0) {
          segPts = roundSharpCorners(segPts, index, { ...routeOptions, turnRadiusM });
        }
      }

      debugSegments.push({
        segIdx,
        from: stops[segIdx],
        to: stops[segIdx + 1],
        distM: Math.round(segDistM),
        distNm: Number((segDistM / 1852).toFixed(2)),
        outcome: !searchResult ? 'failed' : stageAttempts.length > 1 ? `fallback-stage-${stageAttempts.length}` : 'ok',
        stageUsed: searchResult ? stageAttempts.length : null,
        failureCode: !searchResult ? lastDiag.failureCode || 'failed' : null,
        failureExplanation,
        startPointBlocked: lastDiag.startPointBlocked || null,
        endPointBlocked: lastDiag.endPointBlocked || null,
        startAnchorInfo: lastDiag.startAnchorInfo || null,
        endAnchorInfo: lastDiag.endAnchorInfo || null,
        farthestReached,
        remainingDistToGoalM: !searchResult ? (lastDiag.remainingDistToGoalM ?? null) : null,
        primaryObstruction,
        directLineObstructions: directLineCheck?.obstructions || [],
        directLineReasonCounts: directLineCheck?.reasonCounts || null,
        stageAttempts: stageAttempts.map(({ closestNodeXY, ...rest }) => rest),
      });

      for (let k = 0; k < segPts.length; k++) {
        if (segIdx > 0 && k === 0) continue;
        const pt = segPts[k];
        const isFirstGlobal = segIdx === 0 && k === 0;
        const isEndOfSeg = k === segPts.length - 1;
        const isLastGlobal = segIdx === stops.length - 2 && isEndOfSeg;
        let role = 'auto';
        let viaIndex = null;
        if (isFirstGlobal) {
          role = 'start';
        } else if (isLastGlobal) {
          role = 'end';
        } else if (isEndOfSeg && segIdx < stops.length - 2) {
          role = 'via';
          viaIndex = segIdx;
        }
        waypointsXY.push({
          ...pt,
          role,
          viaIndex,
          segIdx: isEndOfSeg && segIdx < stops.length - 2 ? segIdx + 1 : segIdx,
        });
      }
    }

    return {
      profile,
      waypointsXY,
      debugSegments,
      debugMapMarkers,
      failureExplanations,
      usedFallback,
      usedShallowWaterFallback,
      routeFailed,
      routingModeUsed: rm,
      clearanceModeUsed: cm,
      shoreMarginUsed: localShoreMargin,
    };
  }

  // ---------- Primary (and optional multi-objective) search ----------
  let usedFallback = false;
  let usedShallowWaterFallback = false;
  let routeFailed = false;
  let waypointsXY = [];
  const debugSegments = [];
  const debugMapMarkers = [];
  const failureExplanations = [];
  let primarySearchResult = null;
  const objectiveSearchResults = [];

  if (manualPts.length >= 2) {
    const baseClearance = clearancePresets[clearanceMode] || clearancePresets.normal;
    waypointsXY = manualPts.map((pt, i) => {
      const [x, y] = project.toXY(pt.lat, pt.lon);
      const onFw = Boolean(pointOnSafeFairway(x, y, index, 28, true));
      const role = i === 0 ? 'start' : i === manualPts.length - 1 ? 'end' : 'manual';
      return {
        x,
        y,
        kind: role,
        role,
        viaIndex: null,
        segIdx: Math.min(i, Math.max(0, manualPts.length - 2)),
        onFairway: onFw,
      };
    });
    if (turnRadiusM > 0) {
      const manualEvalOpts = {
        contourBuffer: baseClearance.contourBuffer,
        soundingBuffer: baseClearance.soundingBuffer,
        shoreBuffer: shoreMarginM,
        rockBuffer: avoidRocks ? baseClearance.rockBuffer : 0,
        routingMode: 'open_water',
        avoidFaulty,
        allowShallowWater: true,
        turnRadiusM,
      };
      waypointsXY = roundSharpCorners(waypointsXY, index, manualEvalOpts);
    }
    // Manual routes do not participate in multi-objective search
    primarySearchResult = {
      profile: OBJECTIVE_PROFILES.balanced || { id: 'manual', label: 'Manual', description: 'User-drawn route' },
      waypointsXY,
      debugSegments: [],
      debugMapMarkers: [],
      failureExplanations: [],
      usedFallback: false,
      usedShallowWaterFallback: false,
      routeFailed: false,
      routingModeUsed: 'open_water',
      clearanceModeUsed: clearanceMode,
      shoreMarginUsed: shoreMarginM,
    };
  } else if (multiObjective) {
    // Run independent searches for each requested objective, sharing the spatial index
    for (const objId of requestedObjectives) {
      const profile = OBJECTIVE_PROFILES[objId] || OBJECTIVE_PROFILES.balanced;
      const result = runObjectiveSearch(profile);
      objectiveSearchResults.push(result);
    }
    // Primary = first requested objective
    primarySearchResult = objectiveSearchResults[0];
    waypointsXY = primarySearchResult.waypointsXY;
    usedFallback = primarySearchResult.usedFallback;
    usedShallowWaterFallback = primarySearchResult.usedShallowWaterFallback;
    routeFailed = primarySearchResult.routeFailed;
    debugSegments.push(...primarySearchResult.debugSegments);
    debugMapMarkers.push(...primarySearchResult.debugMapMarkers);
    failureExplanations.push(...primarySearchResult.failureExplanations);
  } else {
    // Single-objective path (original behaviour)
    const profile = OBJECTIVE_PROFILES[requestedObjectives[0]] || {
      id: 'custom',
      label: 'Custom',
      description: 'User-specified routingMode / clearanceMode',
      routingMode,
      clearanceMode,
      shoreMarginBoost: 0,
      rockBufferBoost: 0,
    };
    // Honour explicit user routingMode / clearanceMode over profile defaults
    profile.routingMode = routingMode;
    profile.clearanceMode = clearanceMode;
    primarySearchResult = runObjectiveSearch(profile);
    waypointsXY = primarySearchResult.waypointsXY;
    usedFallback = primarySearchResult.usedFallback;
    usedShallowWaterFallback = primarySearchResult.usedShallowWaterFallback;
    routeFailed = primarySearchResult.routeFailed;
    debugSegments.push(...primarySearchResult.debugSegments);
    debugMapMarkers.push(...primarySearchResult.debugMapMarkers);
    failureExplanations.push(...primarySearchResult.failureExplanations);
  }

  // Convert to geographic legs and generate seamark pass instructions
  const legs = [];
  const marksNearRouteMap = new Map();
  let totalDistM = 0;
  let fairwayDistM = 0;
  let cautionLegs = 0;
  let faultyMarksNearby = 0;

  const waypoints = waypointsXY.map((wp, idx) => {
    const [lat, lon] = project.toLatLon(wp.x, wp.y);
    return {
      index: idx,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      role: wp.role || (idx === 0 ? 'start' : idx === waypointsXY.length - 1 ? 'end' : 'auto'),
      viaIndex: wp.viaIndex ?? null,
      segIdx: wp.segIdx ?? 0,
      isFillet: Boolean(wp.isFillet),
    };
  });

  for (let i = 0; i < waypointsXY.length - 1; i++) {
    const a = waypointsXY[i];
    const b = waypointsXY[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const legDistM = Math.hypot(dx, dy);
    const legDistNm = legDistM / 1852;
    const bearingDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

    const fwSeg =
      segmentNearSafeFairway(a.x, a.y, b.x, b.y, index, 10 + Math.abs(signedOffsetM) + 6, true) ||
      ((a.onFairway || a.isFillet) && (b.onFairway || b.isFillet)
        ? a.offsetFwSeg || b.offsetFwSeg || a.filletFwSeg || b.filletFwSeg || true
        : null);
    const evalRes = evaluateSegment(a.x, a.y, b.x, b.y, index, {
      contourBuffer: Math.min(12, Math.max(6, Math.round(baseClearance.contourBuffer * 0.5))),
      soundingBuffer: Math.min(16, Math.max(8, Math.round(baseClearance.soundingBuffer * 0.55))),
      relaxFactor: 0.7,
      routingMode,
      avoidFaulty,
    });
    const hitLand = evalRes.blocked && evalRes.reason === 'land';
    const isApproach =
      a.kind === 'approach-start' ||
      b.kind === 'approach-end' ||
      routeFailed ||
      hitLand ||
      (evalRes.blocked && !fwSeg);
    const shallowFairwayLeg = Boolean(
      fwSeg && fwSeg.fairwayDepth !== null && fwSeg.fairwayDepth < effectiveSafeDepth
    );
    const legType = fwSeg && !hitLand ? 'fairway' : isApproach ? 'approach' : 'open-water';
    const shallowCaution = Boolean(
      hitLand || shallowFairwayLeg || isApproach || (evalRes.blocked && !fwSeg?.verifiedDepth)
    );

    totalDistM += legDistM;
    if (legType === 'fairway') fairwayDistM += legDistM;
    if (shallowCaution) cautionLegs++;

    // Find seamarks within 180m of this leg
    const lMinX = Math.min(a.x, b.x) - 180;
    const lMinY = Math.min(a.y, b.y) - 180;
    const lMaxX = Math.max(a.x, b.x) + 180;
    const lMaxY = Math.max(a.y, b.y) + 180;
    const nearbyMarks = index.seamarkIndex.query(lMinX, lMinY, lMaxX, lMaxY);

    const instructions = [];
    for (const m of nearbyMarks) {
      const distToMark = pointToSegmentDist(m.x, m.y, a.x, a.y, b.x, b.y);
      if (distToMark > 180) continue;

      if (!marksNearRouteMap.has(m.id)) {
        marksNearRouteMap.set(m.id, {
          id: m.id,
          name: m.name,
          role: m.role,
          label: m.label,
          short: m.short,
          safeDir: m.safeDir,
          lat: m.lat,
          lon: m.lon,
          isFaulty: m.isFaulty,
          faultType: m.faultType,
          distM: Math.round(distToMark),
        });
        if (m.isFaulty) faultyMarksNearby++;
      }

      // Compute relative side (port/starboard) along vector a -> b using cross product
      const cross = dx * (m.y - a.y) - dy * (m.x - a.x);
      const sideText = cross > 0 ? 'port' : 'starboard';

      if (m.safeDir) {
        const dirWord =
          m.safeDir === 'N' ? 'North' : m.safeDir === 'S' ? 'South' : m.safeDir === 'W' ? 'West' : 'East';
        instructions.push(`Pass ${dirWord} of ${m.name} (${m.short})`);
      } else if (m.role === 'lateral-port' || m.role === 'lateral-starboard') {
        instructions.push(`Pass ${m.name} (${m.short}) on ${sideText} (${Math.round(distToMark)} m)`);
      } else if (m.role === 'danger') {
        instructions.push(`Clear ${m.name} Isolated Danger (${Math.round(distToMark)} m)`);
      }
    }

    legs.push({
      index: i + 1,
      from: waypoints[i],
      to: waypoints[i + 1],
      distM: Math.round(legDistM),
      distNm: Number(legDistNm.toFixed(2)),
      bearingDeg: Math.round(bearingDeg),
      legType,
      fairwayName: fwSeg?.name || evalRes.fairwayName || null,
      fairwayDepth: fwSeg?.fairwayDepth ?? evalRes.fairwayDepth ?? null,
      fairwayOffsetM: legType === 'fairway' && Math.abs(signedOffsetM) >= 1 ? Math.round(Math.abs(signedOffsetM)) : 0,
      fairwayOffsetSide: legType === 'fairway' && Math.abs(signedOffsetM) >= 1 ? fairwayOffsetSide : 'center',
      shallowCaution,
      instructions: instructions.slice(0, 4),
    });
  }

  const totalDistNm = totalDistM / 1852;
  const etaMinutes = Math.round((totalDistNm / speedKn) * 60);
  const fairwayPct = totalDistM > 0 ? Math.round((fairwayDistM / totalDistM) * 100) : 0;

  const warnings = [
    'Advisory only: verify against official Traficom nautical charts before navigating.',
  ];
  if (usedShallowWaterFallback && !routeFailed) {
    warnings.push('Relaxed shallow coastal clearance applied to reach destination.');
  } else if (usedFallback && !routeFailed) {
    warnings.push('Used official shallow-draft fairway channel where nominal swept depth is below D_safe.');
  }
  if (cautionLegs > 0) {
    warnings.push(
      `${cautionLegs} leg(s) traverse fairways or coastal water with nominal depth < ${effectiveSafeDepth.toFixed(1)} m.`
    );
  }
  if (faultyMarksNearby > 0) {
    warnings.push(`${faultyMarksNearby} seamark(s) near the route have active Digitraffic ATON faults.`);
  }
  if (routeFailed) {
    warnings.push('No unobstructed water passage found at this draft threshold; showing direct reference line.');
    for (const exp of failureExplanations) {
      warnings.push(exp);
    }
  }
  if (manualPts.length >= 2) {
    warnings.push('Manual route edit active: legs were re-evaluated against Traficom depths & Väylävirasto seamarks.');
  }

  const marksNearRoute = Array.from(marksNearRouteMap.values()).sort((x, y) => x.distM - y.distM);
  const debugStatus = routeFailed ? 'FAILED' : usedFallback ? 'FALLBACK' : manualPts.length >= 2 ? 'MANUAL' : 'OK';
  const debug = {
    status: debugStatus,
    computeMs: Date.now() - routeComputeStartMs,
    fetchMs,
    corridorBbox: corridorData.bbox.map((v) => Number(v.toFixed(5))),
    wfsCounts: {
      contours: (corridorData.contours || []).length,
      depthAreas: (corridorData.areas || []).length,
      soundings: (corridorData.soundings || []).length,
      navLines: (corridorData.navLines || []).length,
      fairways: (corridorData.fairways || []).length,
      seamarks: (corridorData.seamarks || []).length,
      warnings: (corridorData.warnings || []).length,
      rocks: (corridorData.rocks || []).length,
    },
    indexCounts: {
      shallowContours: index.shallowContours.length,
      allWaterAreas: index.allWaterAreas.length,
      shallowAreas: index.shallowAreas.length,
      shorelineSegments: index.shorelineSegments.length,
      shallowSoundings: index.shallowSoundings.length,
      safeFairwaySegments: index.safeFairways.length,
      unsafeFairwaySegments: index.unsafeFairways.length,
      seamarks: index.allSeamarks.length,
      rocks: index.allRocks.length,
    },
    segments: debugSegments,
    mapMarkers: debugMapMarkers,
  };

  // Primary physical hydrographic safety evaluation & scores
  const primarySafetyEval = !routeFailed
    ? evaluateRouteSafety(waypointsXY, index, {
      effectiveSafeDepth,
      signedOffsetM,
      usedFallback,
      usedShallowWaterFallback,
    })
    : null;
  const primaryScores = scoreRouteResult(
    { etaMinutes, usedFallback, usedShallowWaterFallback },
    totalDistNm,
    fairwayPct,
    cautionLegs,
    faultyMarksNearby,
    routeFailed,
    primarySafetyEval
  );

  // Build alternative route summaries (geometry + scores) when multi-objective was requested
  const alternatives = [];
  if (multiObjective && objectiveSearchResults.length > 1) {
    for (let ai = 0; ai < objectiveSearchResults.length; ai++) {
      const osr = objectiveSearchResults[ai];
      const altWaypoints = osr.waypointsXY.map((wp, idx) => {
        const [lat, lon] = project.toLatLon(wp.x, wp.y);
        return {
          index: idx,
          lat: Number(lat.toFixed(6)),
          lon: Number(lon.toFixed(6)),
          role: wp.role || (idx === 0 ? 'start' : idx === osr.waypointsXY.length - 1 ? 'end' : 'auto'),
          viaIndex: wp.viaIndex ?? null,
          segIdx: wp.segIdx ?? 0,
        };
      });

      let altDistM = 0;
      let altFairwayDistM = 0;
      let altCautionLegs = 0;
      for (let i = 0; i < osr.waypointsXY.length - 1; i++) {
        const a = osr.waypointsXY[i];
        const b = osr.waypointsXY[i + 1];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        altDistM += d;
        const fw = segmentNearSafeFairway(a.x, a.y, b.x, b.y, index, 10, true);
        if (fw) altFairwayDistM += d;
        const ev = evaluateSegment(a.x, a.y, b.x, b.y, index, {
          contourBuffer: 10,
          soundingBuffer: 14,
          relaxFactor: 0.75,
          routingMode: osr.routingModeUsed,
          avoidFaulty,
        });
        if (ev.blocked || (fw && fw.fairwayDepth != null && fw.fairwayDepth < effectiveSafeDepth)) {
          altCautionLegs++;
        }
      }
      const altDistNm = altDistM / 1852;
      const altFairwayPct = altDistM > 0 ? Math.round((altFairwayDistM / altDistM) * 100) : 0;
      const altEta = Math.round((altDistNm / speedKn) * 60);
      const altSafetyEval = osr.routeFailed
        ? null
        : ai === 0 && primarySafetyEval
          ? primarySafetyEval
          : evaluateRouteSafety(osr.waypointsXY, index, {
            effectiveSafeDepth,
            signedOffsetM,
            usedFallback: osr.usedFallback,
            usedShallowWaterFallback: osr.usedShallowWaterFallback,
          });
      const altScores = scoreRouteResult(
        {
          etaMinutes: altEta,
          usedFallback: osr.usedFallback,
          usedShallowWaterFallback: osr.usedShallowWaterFallback,
        },
        altDistNm,
        altFairwayPct,
        altCautionLegs,
        altSafetyEval?.breakdown?.metrics?.faultyMarks || 0,
        osr.routeFailed,
        altSafetyEval
      );

      alternatives.push({
        objective: osr.profile.id,
        label: osr.profile.label,
        description: osr.profile.description,
        isPrimary: ai === 0,
        routingMode: osr.routingModeUsed,
        clearanceMode: osr.clearanceModeUsed,
        scores: altScores,
        route: {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: altWaypoints.map((w) => [w.lon, w.lat]),
          },
          properties: {
            totalDistM: Math.round(altDistM),
            totalDistNm: Number(altDistNm.toFixed(2)),
            etaMinutes: altEta,
            fairwayPct: altFairwayPct,
            effectiveSafeDepth,
            objective: osr.profile.id,
          },
        },
        waypoints: altWaypoints,
        summary: {
          totalDistM: Math.round(altDistM),
          totalDistNm: Number(altDistNm.toFixed(2)),
          etaMinutes: altEta,
          fairwayPct: altFairwayPct,
          cautionLegs: altCautionLegs,
          usedFallback: osr.usedFallback,
          routeFailed: osr.routeFailed,
        },
      });
    }
  }

  // Keep only non-dominated alternatives when we have a real set
  const paretoAlternatives =
    alternatives.length > 1 ? filterParetoAlternatives(alternatives) : alternatives;

  return {
    params: {
      startLat,
      startLon,
      endLat,
      endLon,
      draft,
      vesselDraft: parsedVesselDraft,
      ukc: parsedUkc,
      seaLevelCm,
      speedKn,
      effectiveSafeDepth,
      routingMode,
      clearanceMode,
      avoidFaulty,
      avoidRocks,
      fairwayOffsetSide,
      fairwayOffsetM: Math.round(fairwayOffsetM),
      shoreMarginM: Math.round(shoreMarginM),
      turnRadiusM: Math.round(turnRadiusM),
      vias: viaPoints,
      isManual: manualPts.length >= 2,
      objectives: requestedObjectives,
      multiObjective,
    },
    objective: primarySearchResult?.profile?.id || requestedObjectives[0] || 'balanced',
    scores: primaryScores,
    route: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: waypoints.map((w) => [w.lon, w.lat]),
      },
      properties: {
        totalDistM: Math.round(totalDistM),
        totalDistNm: Number(totalDistNm.toFixed(2)),
        etaMinutes,
        fairwayPct,
        effectiveSafeDepth,
        objective: primarySearchResult?.profile?.id || requestedObjectives[0] || 'balanced',
      },
    },
    waypoints,
    legs,
    marksNearRoute,
    debug,
    summary: {
      totalDistM: Math.round(totalDistM),
      totalDistNm: Number(totalDistNm.toFixed(2)),
      etaMinutes,
      fairwayPct,
      effectiveSafeDepth,
      marksRespectedCount: marksNearRoute.length,
      faultyMarksNearby,
      cautionLegs,
      usedFallback,
      routeFailed,
      warnings,
      stats: {
        shallowContours: index.shallowContours.length,
        shallowAreas: index.shallowAreas.length,
        safeFairwaySegments: index.safeFairways.length,
        seamarksChecked: index.allSeamarks.length,
      },
      debug,
    },
    // Multi-objective / Pareto set (empty when only a single route was requested)
    alternatives: paretoAlternatives,
    objectiveComparison:
      paretoAlternatives.length > 1
        ? paretoAlternatives.map((a) => ({
          objective: a.objective,
          label: a.label,
          distanceNm: a.scores.distanceNm,
          etaMinutes: a.scores.etaMinutes,
          fairwayPct: a.scores.fairwayPct,
          riskScore: a.scores.riskScore,
          safetyScore: a.scores.safetyScore,
          efficiencyScore: a.scores.efficiencyScore,
          composite: a.scores.composite,
          routeFailed: a.summary.routeFailed,
        }))
        : undefined,
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function serveStaticFile(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(ROOT_DIR, '.' + safePath);

  if (!resolved.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname, searchParams } = reqUrl;

  try {
    if (pathname === '/api/septit') {
      const data = await getSeptitData();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/ais') {
      const data = await getAisData(searchParams.get('bbox'));
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/lipas') {
      const data = await getLipasData();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/fmi') {
      const data = await getFmiData();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/mareograph') {
      const data = await getMareographData();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/warnings') {
      const data = await getWarningsData();
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/osm') {
      const data = await getOsmData(searchParams.get('bbox'));
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/rocks') {
      const data = await getOsmRocksData(searchParams.get('bbox'));
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/rocks/stats') {
      reloadRocksFromDiskIfNeeded();
      const breakdown = {
        submerged: 0,
        awash: 0,
        always_dry: 0,
        islet: 0,
        bare_rock: 0,
        wreck: 0,
        other: 0,
      };
      for (const r of osmRocksMap.values()) {
        const key = r.type === 'islet' ? 'islet' : (r.waterLevel || 'submerged');
        if (breakdown[key] !== undefined) breakdown[key]++;
        else breakdown.other++;
      }
      return sendJson(res, 200, {
        totalRocks: osmRocksMap.size,
        fetchedTiles: osmFetchedTiles.size,
        breakdown,
      });
    }
    if (pathname === '/api/weather') {
      const data = await getWeatherData(searchParams.get('lat'), searchParams.get('lon'));
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/depth') {
      const data = await getDepthData(searchParams.get('bbox'));
      return sendJson(res, 200, data);
    }
    if (pathname === '/api/route') {
      const data = await computeMarineRoute(searchParams);
      return sendJson(res, 200, data);
    }

    return serveStaticFile(res, pathname);
  } catch (err) {
    console.error(`Error handling ${pathname}:`, err);
    return sendJson(res, 502, {
      error: err.message || 'Upstream data source error',
      endpoint: pathname,
    });
  }
});

server.listen(PORT, () => {
  console.log(`Luotsi Open Map Viewer running at http://localhost:${PORT}`);
});
