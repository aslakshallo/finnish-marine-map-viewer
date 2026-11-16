# Finnish Marine Map Viewer & Route Planner (Luotsi)

An interactive marine navigation and outdoor map viewer for Finnish coastal waters and lakes. It integrates official open data from Traficom, Väylävirasto, Maanmittauslaitos, Fintraffic, Digitraffic, FMI, OpenSeaMap, Lipas, and Septit.net into a unified nautical chart plotter and multi-stage pathfinding engine.

---

## Key Features

### 1. Intelligent Marine Route Planner
- **Multi-Stage A\* Pathfinding**:
  - Automatically routes through official fairway channels, navigation lines, and safe open water corridors.
  - Honors vessel static draft, under-keel clearance (UKC) safety margins, and live sea level fluctuations.
- **S-57 & Charted Marine Rocks Keep-Out**:
  - Pre-seeded national database of over 168,000+ official S-57 / charted marine hazards (submerged rocks, rocks awash, emergent rocks, and islets).
  - Configurable safety buffers and shoreline margin keep-outs.
- **Fairway Centering & Offsetting**:
  - Option to navigate along the fairway centerline or offset laterally to Starboard or Port side.
- **Nautical Corner Filleting**:
  - Automatic turn radius filleting (configurable radius, e.g. 100 m) for realistic ship turns.
- **Manual Route Drawing & Editing**:
  - Draw custom routes by hand directly on the chart, move vertices, pin via-points, or reverse routes with automatic recalculation.
- **GPX 1.1 & GeoJSON Export / Import**:
  - Export planned routes directly to onboard chart plotters or handheld marine GPS units.

### 2. Official Marine & Topographic Basemaps
- **Maanmittauslaitos (National Land Survey of Finland)**:
  - Background Map (*Taustakartta*)
  - Topographic Map (*Peruskartta* — includes inland lake depth contours and rocks)
  - Aerial Orthophotos (*Ortokuva*)
  - Property Boundaries (*Kiinteistörajat*)
- **OpenStreetMap Standard**: High-detail global basemap.

### 3. Nautical Chart & Depth Overlays
- **Traficom Charts (WMS)**:
  - All Nautical Chart Series (*Merikarttasarjat*)
  - Boating Charts (*Veneilykartat*)
  - Coastal Charts (*Rannikkokartat*)
  - S-57 ENC Vector Charts
  - Configurable layer opacity.
- **Vector Depth Contours & Soundings**:
  - Dynamic safety threshold slider with visual shallow/safe shading.
  - Spot soundings and shallow depth area polygons.
- **Väylävirasto Fairways & Aids to Navigation (WFS/WMS)**:
  - Fairway channels, navigation lines, and fairway areas.
  - Seamarks, lateral buoys, cardinal marks, lights, and sector arcs.
  - Speed limit areas and maritime restriction zones.
- **OpenSeaMap**: Seamarks and navigation aid vector overlay.

### 4. Real-Time Marine Traffic & Weather
- **Fintraffic AIS**: Live real-time vessel traffic and tracking (positions, speeds, headings, ship types).
- **Digitraffic Nautical Warnings**: Active navigational warnings and unlit/faulty ATON notices with automatic route avoidance.
- **Finnish Meteorological Institute (FMI)**:
  - Real-time coastal weather stations (wind speed, gusts, direction, temperature).
  - Mareograph sea level gauges with automated sea-level adjustments for route planning.
- **Septit.net**: Pump-out waste disposal stations for boaters.

### 5. Harbours & Outdoor Recreation (Lipas & OSM)
- Guest harbours, small boat marinas, and service ports.
- Lean-to shelters (*laavut*), wilderness huts (*tuvat*), and campfire sites (*tulipaikat*).
- Boat launch ramps (*veneluiska*) and shoreline amenities.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or newer recommended). No external npm dependencies required!

### Running Locally
1. Clone the repository:
   ```bash
   git clone https://github.com/aslakshallo/finnish-marine-map-viewer.git
   cd finnish-marine-map-viewer
   ```

2. Start the server:
   ```bash
   npm start
   ```
   *(or `node server.js`)*

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## Data Sources & Attributions

- **Traficom (Finnish Transport and Communications Agency)**: Nautical charts, depth contours, and soundings ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **Väylävirasto (Finnish Transport Infrastructure Agency)**: Fairways, navigation lines, seamarks, and restriction areas ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **Maanmittauslaitos (National Land Survey of Finland)**: Topographic and aerial background maps ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **Digitraffic / Fintraffic**: Marine AIS and navigational warnings ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **Ilmatieteen laitos (FMI)**: Mareograph sea levels and weather observations ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).
- **OpenStreetMap & OpenSeaMap**: Basemap data, boating POIs, and seamark overlays ([ODbL](https://opendatacommons.org/licenses/odbl/)).
- **Lipas (University of Jyväskylä)**: Sports and outdoor recreational facilities ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)).

---

## License

This project is licensed under the [MIT License](LICENSE).
