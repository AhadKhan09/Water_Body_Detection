# AquaSense — Sentinel Water Intelligence

Real-time SAR water body detection dashboard using Sentinel-1 GRD via Google Earth Engine, visualised on Mapbox GL.

---

## Project Structure

```
aquasense/
├── index.html        ← Frontend dashboard
├── style.css         ← Styles (dark industrial theme)
├── app.js            ← Mapbox GL + UI logic
├── main.py           ← FastAPI backend (GEE integration)
├── requirements.txt  ← Python dependencies
└── README.md
```

---

## Setup & Run

### 1. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 2. Authenticate with Google Earth Engine

Run this once to authenticate:

```bash
earthengine authenticate
```

Or for service accounts, set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable pointing to your JSON key file.

### 3. Start the backend

```bash
python main.py
# or
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`
- Docs: `http://localhost:8000/docs`
- Health: `http://localhost:8000/health`

### 4. Open the frontend

Serve the frontend with any static file server:

```bash
# Python built-in
python -m http.server 3000

# or Node.js
npx serve . -p 3000
```

Then open `http://localhost:3000` in your browser.

---

## How It Works

1. **Select date range** and polarization (VV recommended for water)
2. **Select Study Area** on the map (Rectangle, Circle, Polygon, or Freeform) to constrain analysis to your AOI
3. **Adjust threshold** — water pixels typically have backscatter below −14 to −18 dB
4. **Click "Analyze Water Bodies"** — the backend:
   - Queries `COPERNICUS/S1_GRD` ImageCollection
  - Filters by date, polarization, IW instrument mode, and selected AOI bounds
   - Computes a mean composite (reduces speckle)
   - Applies a focal mean smoothing filter
  - Clips imagery to the selected AOI
   - Generates a colour-mapped tile URL via GEE
5. The thresholded water-mask tile is overlaid on the Mapbox dark basemap
6. Pixels below threshold appear as **deep blue** water detections; non-water pixels stay transparent
7. Use **Download Water Bodies (Shapefile)** to export detected polygons for GIS workflows

---

## API Reference

### `GET /api/sentinel`

| Parameter     | Type   | Default | Description                        |
|---------------|--------|---------|------------------------------------|
| start_date    | string | —       | ISO date, e.g. `2024-01-01`        |
| end_date      | string | —       | ISO date, e.g. `2024-02-01`        |
| polarization  | string | `VV`    | `VV` or `VH`                       |
| threshold     | float  | `-16.0` | Water/land threshold in dB         |
| bbox          | string | —       | `minLng,minLat,maxLng,maxLat` AOI bounds (fallback) |
| aoi_geojson   | string | —       | GeoJSON geometry (`Polygon`/`MultiPolygon`) for precise AOI |

**Response:**
```json
{
  "tile_url":        "https://earthengine.googleapis.com/...",
  "image_count":     24,
  "water_area_km2":  12450.3,
  "backscatter_min": -24.1,
  "backscatter_max": 2.3,
  "bounds":          [[60.8, 23.6], [77.8, 37.1]],
  "start_date":      "2024-01-01",
  "end_date":        "2024-02-01",
  "polarization":    "VV",
  "threshold_db":    -16.0
}
```

### `GET /api/sentinel/shapefile`

Exports detected water bodies as a zipped ESRI Shapefile (`.zip` containing `.shp/.shx/.dbf/.prj`).

Uses the same parameters as `/api/sentinel`.
- `aoi_geojson` (or `bbox`) is required to define the study area.

---

## Tips for Water Detection

- **VV polarization** is generally best for open water detection
- **VH polarization** can be better for flooded vegetation
- Threshold of **−16 dB** works well for most regions
- Wider date ranges produce more stable composites
- For flood mapping, use a narrow window (7–14 days)

---

## Requirements

- Python 3.9+
- Google Earth Engine account with project `snow-cover-473111`
- Modern browser (Chrome, Firefox, Edge)
