const fs = require('fs');
const path = require('path');

const ROCKS_FILE = path.join(__dirname, '..', 'data', 'osm_rocks.json');

const REGIONS = {
  hanko: { name: 'Hanko & Tammisaari', s: 59.80, w: 22.80, n: 60.05, e: 23.60 },
  porkkala_inkoo: { name: 'Inkoo & Barösund', s: 59.90, w: 23.60, n: 60.10, e: 24.30 },
  archipelago_south: { name: 'Archipelago Sea South (Utö, Kökar, Nauvo)', s: 59.75, w: 21.30, n: 60.25, e: 22.50 },
  archipelago_north: { name: 'Archipelago Sea North (Turku, Naantali, Kustavi)', s: 60.25, w: 21.30, n: 60.60, e: 22.50 },
  aland: { name: 'Åland Islands (Mariehamn, Eckerö, Föglö)', s: 59.80, w: 19.40, n: 60.40, e: 21.00 },
  kotka_hamina: { name: 'Kotka, Hamina & Virolahti', s: 60.25, w: 26.40, n: 60.60, e: 27.80 },
  rauma_pori: { name: 'Bothnian Sea South (Rauma, Pori)', s: 61.00, w: 21.20, n: 61.80, e: 21.80 },
  vaasa_kvarken: { name: 'Kvarken Archipelago (Vaasa)', s: 62.90, w: 20.90, n: 63.45, e: 21.80 }
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseOsmXml(xml, rocksMap) {
  let count = 0;
  // 1. Collect all node coords for way resolution
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

  // 2. Parse tagged nodes for rocks, hazards, reefs, islets
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
        rocksMap[id] = { id, lat, lon, waterLevel, type: seamarkType };
        count++;
      }
    }
  }

  // 3. Parse ways for islets, bare rocks, reefs, and marine hazards
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

        const wayNodes = wayPoints.map(p => [p.lat, p.lon]);
        rocksMap['w' + wayId] = {
          id: 'w' + wayId,
          lat: avgLat,
          lon: avgLon,
          waterLevel,
          type: seamarkType,
          nodes: wayNodes,
        };
        count++;

        const step = wayPoints.length > 30 ? 2 : 1;
        for (let i = 0; i < wayPoints.length; i += step) {
          const p = wayPoints[i];
          rocksMap[p.id] = {
            id: p.id,
            lat: p.lat,
            lon: p.lon,
            waterLevel,
            type: seamarkType,
          };
          count++;
        }
      }
    }
  }
  return count;
}

async function seedRegion(regionKey, maxTiles = 250) {
  const reg = REGIONS[regionKey];
  if (!reg) {
    console.error('Unknown region:', regionKey, 'Available:', Object.keys(REGIONS));
    return;
  }

  console.log(`\n=== Seeding ${reg.name} [bbox: ${reg.s}, ${reg.w} -> ${reg.n}, ${reg.e}] ===`);
  const data = JSON.parse(fs.readFileSync(ROCKS_FILE, 'utf8'));
  const fetchedSet = new Set(data.fetchedTiles || []);
  const rocksMap = data.rocks || {};

  const tileStep = 0.02;
  const tilesToFetch = [];
  for (let lat = reg.s; lat < reg.n; lat += tileStep) {
    for (let lon = reg.w; lon < reg.e; lon += tileStep) {
      const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (!fetchedSet.has(key)) {
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

  console.log(`Total tiles in region: ${Math.round((reg.n - reg.s)/tileStep * (reg.e - reg.w)/tileStep)}, missing: ${tilesToFetch.length}`);
  const batch = tilesToFetch.slice(0, maxTiles);
  console.log(`Fetching batch of ${batch.length} tiles...`);

  let fetchedCount = 0;
  let newRocksCount = 0;

  for (let i = 0; i < batch.length; i++) {
    const t = batch[i];
    const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${t.w.toFixed(4)},${t.s.toFixed(4)},${t.e.toFixed(4)},${t.n.toFixed(4)}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LuotsiMarineSeeder/2.0 (contact: admin@luotsi.local)' },
        signal: AbortSignal.timeout(12000),
      });

      if (res.status === 429) {
        console.warn('\nOSM rate-limited (429), waiting 15s...');
        await sleep(15000);
        continue;
      }

      if (res.ok) {
        const xml = await res.text();
        const found = parseOsmXml(xml, rocksMap);
        fetchedSet.add(t.key);
        fetchedCount++;
        newRocksCount += found;
      }
    } catch (err) {
      // ignore individual timeout
    }

    if ((i + 1) % 25 === 0 || i === batch.length - 1) {
      process.stdout.write(`\rProgress: ${i + 1}/${batch.length} tiles fetched (${fetchedCount} ok, +${newRocksCount} rocks, total ${Object.keys(rocksMap).length})`);
      if (fs.existsSync(ROCKS_FILE)) {
        try {
          const disk = JSON.parse(fs.readFileSync(ROCKS_FILE, 'utf8'));
          if (Array.isArray(disk.fetchedTiles)) {
            for (const k of disk.fetchedTiles) fetchedSet.add(k);
          }
          if (disk.rocks && typeof disk.rocks === 'object') {
            for (const [id, r] of Object.entries(disk.rocks)) {
              if (!rocksMap[id]) rocksMap[id] = r;
            }
          }
        } catch (_) {}
      }
      data.fetchedTiles = Array.from(fetchedSet);
      data.rocks = rocksMap;
      fs.writeFileSync(ROCKS_FILE, JSON.stringify(data, null, 2), 'utf8');
    }
    await sleep(250);
  }

  console.log(`\nDone! Saved ${Object.keys(rocksMap).length} total rocks in osm_rocks.json\n`);
}

const target = process.argv[2] || 'hanko';
const limit = Number(process.argv[3]) || 150;
seedRegion(target, limit).catch(console.error);
