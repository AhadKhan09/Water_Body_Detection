"""
AquaSense — main.py
FastAPI backend for Sentinel-1 GRD water body analysis via Google Earth Engine
"""

import ee
import io
import json
import logging
import tempfile
import zipfile
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import shapefile  # type: ignore[reportMissingImports]

# ═══════════════════════════════════════
# Logging
# ═══════════════════════════════════════
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("aquasense")

# ═══════════════════════════════════════
# GEE Configuration
# ═══════════════════════════════════════
GEE_PROJECT = "snow-cover-473111"

def init_earth_engine():
    """Authenticate & initialise Google Earth Engine."""
    try:
        # Try service-account / Application Default Credentials first
        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/earthengine"]
        )
        ee.Initialize(credentials=credentials, project=GEE_PROJECT)
        log.info("✓ GEE initialised with Application Default Credentials")
    except Exception:
        # Fall back to interactive auth (works on developer machines)
        try:
            ee.Authenticate()
            ee.Initialize(project=GEE_PROJECT)
            log.info("✓ GEE initialised via interactive auth")
        except Exception as exc:
            log.error("✗ GEE initialisation failed: %s", exc)
            raise RuntimeError(f"GEE init failed: {exc}") from exc

# Initialise at startup
try:
    import google.auth
    init_earth_engine()
except ImportError:
    # google-auth not installed — fall back to ee.Authenticate only
    try:
        ee.Initialize(project=GEE_PROJECT)
        log.info("✓ GEE initialised (no google-auth)")
    except Exception as exc:
        log.warning("GEE deferred init: %s", exc)

# ═══════════════════════════════════════
# FastAPI App
# ═══════════════════════════════════════
app = FastAPI(
    title="AquaSense API",
    description="Sentinel-1 SAR water body detection via Google Earth Engine",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],        # tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ═══════════════════════════════════════
# Response Schema
# ═══════════════════════════════════════
class SentinelResponse(BaseModel):
    tile_url:         str
    image_count:      int
    water_area_km2:   Optional[float]
    backscatter_min:  Optional[float]
    backscatter_max:  Optional[float]
    bounds:           Optional[list]   # [[minLng, minLat], [maxLng, maxLat]]
    start_date:       str
    end_date:         str
    polarization:     str
    threshold_db:     float

WGS84_PRJ = (
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
    'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]'
)

def _validate_common_inputs(start_date: str, end_date: str, polarization: str, threshold: float):
    """Validate date, polarization, and threshold query parameters."""
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {exc}")

    if start_dt >= end_dt:
        raise HTTPException(status_code=400, detail="start_date must be before end_date")

    if polarization not in ("VV", "VH"):
        raise HTTPException(status_code=400, detail="polarization must be VV or VH")

    if not (-30 <= threshold <= 0):
        raise HTTPException(status_code=400, detail="threshold must be between -30 and 0 dB")

def _parse_aoi_params(bbox: Optional[str], aoi_geojson: Optional[str]):
    """Parse AOI input from GeoJSON geometry or bbox and return EE geometry and bounds."""
    aoi = None
    explicit_bounds = None

    if aoi_geojson:
        try:
            parsed_geometry = json.loads(aoi_geojson)
            if not isinstance(parsed_geometry, dict):
                raise ValueError("AOI GeoJSON must be a JSON object")
            if parsed_geometry.get("type") not in ("Polygon", "MultiPolygon"):
                raise ValueError("AOI type must be Polygon or MultiPolygon")
            aoi = ee.Geometry(parsed_geometry)
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid aoi_geojson: {exc}")

        try:
            aoi_bounds = aoi.bounds().coordinates().getInfo()[0]
            lngs = [coord[0] for coord in aoi_bounds]
            lats = [coord[1] for coord in aoi_bounds]
            explicit_bounds = [[min(lngs), min(lats)], [max(lngs), max(lats)]]
        except Exception:
            explicit_bounds = None

    elif bbox:
        try:
            parts = [float(v.strip()) for v in bbox.split(",")]
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="bbox must be comma-separated floats: minLng,minLat,maxLng,maxLat",
            )

        if len(parts) != 4:
            raise HTTPException(
                status_code=400,
                detail="bbox must contain exactly 4 values: minLng,minLat,maxLng,maxLat",
            )

        min_lng, min_lat, max_lng, max_lat = parts

        if not (-180 <= min_lng <= 180 and -180 <= max_lng <= 180):
            raise HTTPException(status_code=400, detail="bbox longitude must be within [-180, 180]")
        if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
            raise HTTPException(status_code=400, detail="bbox latitude must be within [-90, 90]")
        if min_lng >= max_lng or min_lat >= max_lat:
            raise HTTPException(
                status_code=400,
                detail="bbox must satisfy minLng < maxLng and minLat < maxLat",
            )

        aoi = ee.Geometry.Rectangle([min_lng, min_lat, max_lng, max_lat], geodesic=False)
        explicit_bounds = [[min_lng, min_lat], [max_lng, max_lat]]

    return aoi, explicit_bounds

# ═══════════════════════════════════════
# Health endpoint
# ═══════════════════════════════════════
@app.get("/health")
def health():
    return {"status": "ok", "service": "AquaSense", "gee_project": GEE_PROJECT}

# ═══════════════════════════════════════
# Main Sentinel-1 analysis endpoint
# ═══════════════════════════════════════
@app.get("/api/sentinel", response_model=SentinelResponse)
def fetch_sentinel(
    start_date:   str   = Query(..., description="ISO date string, e.g. 2024-01-01"),
    end_date:     str   = Query(..., description="ISO date string, e.g. 2024-02-01"),
    polarization: str   = Query("VV", description="VV or VH"),
    threshold:    float = Query(-16.0, description="Water/land threshold in dB"),
    bbox:         Optional[str] = Query(
        None,
        description="Optional bbox as minLng,minLat,maxLng,maxLat",
    ),
    aoi_geojson:  Optional[str] = Query(
        None,
        description="Optional GeoJSON geometry string for precise AOI clipping",
    ),
):
    """
    Fetch Sentinel-1 GRD imagery for the given date range, compute a
    mean SAR backscatter composite, and return a Mapbox-compatible XYZ
    tile URL for visualisation.

    Water bodies typically show very low backscatter (dark in SAR),
    so pixels below `threshold` dB are classified as water.
    """

    _validate_common_inputs(start_date, end_date, polarization, threshold)
    aoi, explicit_bounds = _parse_aoi_params(bbox, aoi_geojson)

    log.info(
        "Request: %s → %s | pol=%s | thr=%.1f dB | bbox=%s | aoi=%s",
        start_date,
        end_date,
        polarization,
        threshold,
        bbox or "global",
        "yes" if aoi_geojson else "no",
    )

    # ── Earth Engine processing ───────────────────
    try:
        # 1. Load Sentinel-1 GRD ImageCollection
        collection = (
            ee.ImageCollection("COPERNICUS/S1_GRD")
            .filterDate(start_date, end_date)
            .filter(ee.Filter.listContains("transmitterReceiverPolarisation", polarization))
            .filter(ee.Filter.eq("instrumentMode", "IW"))
        )

        if aoi is not None:
            collection = collection.filterBounds(aoi)

        collection = collection.select(polarization)

        image_count = int(collection.size().getInfo())
        log.info("Found %d Sentinel-1 images", image_count)

        if image_count == 0:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"No Sentinel-1 images found for {start_date} to {end_date} "
                    f"with {polarization} polarization. Try a wider date range."
                ),
            )

        # 2. Compute mean composite (reduces speckle)
        composite = collection.mean()
        if aoi is not None:
            composite = composite.clip(aoi)

        # 3. Apply refined Lee speckle filter (3×3 focal mean as proxy)
        smoothed = composite.focal_mean(radius=1, kernelType="square", units="pixels")

        # 4. Create water mask (low backscatter = water)
        water_mask = smoothed.lt(threshold)

        # 5. Visualisation — composite coloured for water/land distinction
        #    Water = deep blue ramp, land = green-grey
        vis_image = smoothed.visualize(
            min=-25,
            max=0,
            palette=[
                "020d1f",   # very dark (deepest water)
                "0a2a5e",   # dark navy
                "1a5fa8",   # mid blue (water)
                "4eb3ff",   # bright cyan-blue
                "a8d5ff",   # light blue (shallow/wet)
                "c8c8a0",   # grey-green (transition)
                "7a9a5a",   # land green
                "e8d08a",   # dry land
                "f0ead8",   # very dry / bare soil
            ],
        )

        # 6. Generate tile URL via getMapId
        map_id_dict = vis_image.getMapId()
        raw_tile_url: str = map_id_dict["tile_fetcher"].url_format

        # 7. Compute approximate bounds from GEE
        if explicit_bounds is not None:
            bounds = explicit_bounds
        else:
            try:
                bounds_geom  = composite.geometry().bounds()
                coords       = bounds_geom.getInfo()["coordinates"][0]
                lngs = [c[0] for c in coords]
                lats = [c[1] for c in coords]
                bounds = [[min(lngs), min(lats)], [max(lngs), max(lats)]]
            except Exception:
                bounds = None

        # 8. Approximate water area (optional — skip if too slow)
        water_area_km2 = None
        try:
            pixel_area     = ee.Image.pixelArea().divide(1e6)   # km²
            water_area_img = pixel_area.updateMask(water_mask)
            water_stats_kwargs = {
                "reducer": ee.Reducer.sum(),
                "scale": 1000,
                "maxPixels": 1e9,
                "bestEffort": True,
            }
            if aoi is not None:
                water_stats_kwargs["geometry"] = aoi

            stats = water_area_img.reduceRegion(**water_stats_kwargs)
            area_val = stats.getInfo().get("area", None)
            if area_val is not None:
                water_area_km2 = round(float(area_val), 1)
        except Exception as e:
            log.warning("Could not compute water area: %s", e)

        # 9. Backscatter stats (min/max)
        backscatter_min = backscatter_max = None
        try:
            backscatter_stats_kwargs = {
                "reducer": ee.Reducer.minMax(),
                "scale": 1000,
                "maxPixels": 1e9,
                "bestEffort": True,
            }
            if aoi is not None:
                backscatter_stats_kwargs["geometry"] = aoi

            bstats = smoothed.reduceRegion(**backscatter_stats_kwargs)
            info = bstats.getInfo()
            mn = info.get(f"{polarization}_min")
            mx = info.get(f"{polarization}_max")
            if mn is not None: backscatter_min = round(float(mn), 1)
            if mx is not None: backscatter_max = round(float(mx), 1)
        except Exception as e:
            log.warning("Could not compute backscatter stats: %s", e)

        log.info(
            "Done — tile_url=%s... | area=%.1f km²",
            raw_tile_url[:60],
            water_area_km2 or 0,
        )

        return SentinelResponse(
            tile_url        = raw_tile_url,
            image_count     = image_count,
            water_area_km2  = water_area_km2,
            backscatter_min = backscatter_min,
            backscatter_max = backscatter_max,
            bounds          = bounds,
            start_date      = start_date,
            end_date        = end_date,
            polarization    = polarization,
            threshold_db    = threshold,
        )

    except HTTPException:
        raise
    except Exception as exc:
        log.exception("GEE processing error")
        raise HTTPException(
            status_code=500,
            detail=f"Earth Engine processing failed: {str(exc)}",
        ) from exc


@app.get("/api/sentinel/shapefile")
def download_sentinel_shapefile(
    start_date: str = Query(..., description="ISO date string, e.g. 2024-01-01"),
    end_date: str = Query(..., description="ISO date string, e.g. 2024-02-01"),
    polarization: str = Query("VV", description="VV or VH"),
    threshold: float = Query(-16.0, description="Water/land threshold in dB"),
    bbox: Optional[str] = Query(None, description="Optional bbox as minLng,minLat,maxLng,maxLat"),
    aoi_geojson: Optional[str] = Query(
        None,
        description="Optional GeoJSON geometry string for precise AOI clipping",
    ),
):
    """Export detected water bodies as a zipped ESRI Shapefile."""
    _validate_common_inputs(start_date, end_date, polarization, threshold)
    aoi, _ = _parse_aoi_params(bbox, aoi_geojson)

    if aoi is None:
        raise HTTPException(status_code=400, detail="Study area is required for shapefile export")

    try:
        collection = (
            ee.ImageCollection("COPERNICUS/S1_GRD")
            .filterDate(start_date, end_date)
            .filter(ee.Filter.listContains("transmitterReceiverPolarisation", polarization))
            .filter(ee.Filter.eq("instrumentMode", "IW"))
            .filterBounds(aoi)
            .select(polarization)
        )

        image_count = int(collection.size().getInfo())
        if image_count == 0:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"No Sentinel-1 images found for {start_date} to {end_date} "
                    f"with {polarization} polarization in selected area."
                ),
            )

        composite = collection.mean().clip(aoi)
        smoothed = composite.focal_mean(radius=1, kernelType="square", units="pixels")
        water_mask = smoothed.lt(threshold).selfMask()

        vectors = water_mask.reduceToVectors(
            geometry=aoi,
            scale=30,
            geometryType="polygon",
            reducer=ee.Reducer.countEvery(),
            maxPixels=1e9,
            bestEffort=True,
            labelProperty="class",
        )

        vectors = vectors.map(lambda f: f.set("area_m2", f.geometry().area(1)))
        vectors = vectors.filter(ee.Filter.gte("area_m2", 5000))

        features_info = vectors.getInfo().get("features", [])
        if not features_info:
            raise HTTPException(status_code=404, detail="No water bodies found in selected area")

        with tempfile.TemporaryDirectory() as tmpdir:
            shp_base = f"{tmpdir}/water_bodies"
            writer = shapefile.Writer(shp_base, shapeType=shapefile.POLYGON)
            writer.autoBalance = 1
            writer.field("ID", "N", 10, 0)
            writer.field("AREA_M2", "F", 18, 2)

            row_id = 1
            for feature in features_info:
                geom = feature.get("geometry", {})
                props = feature.get("properties", {})
                geom_type = geom.get("type")
                coords = geom.get("coordinates", [])

                polygon_list = []
                if geom_type == "Polygon":
                    polygon_list = [coords]
                elif geom_type == "MultiPolygon":
                    polygon_list = coords

                area_m2 = float(props.get("area_m2") or 0.0)
                for polygon in polygon_list:
                    parts = []
                    for ring in polygon:
                        parts.append([[pt[0], pt[1]] for pt in ring])

                    if not parts:
                        continue

                    writer.poly(parts)
                    writer.record(row_id, round(area_m2, 2))
                    row_id += 1

            writer.close()

            with open(f"{shp_base}.prj", "w", encoding="utf-8") as prj_file:
                prj_file.write(WGS84_PRJ)

            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zipf:
                for ext in ("shp", "shx", "dbf", "prj"):
                    file_path = f"{shp_base}.{ext}"
                    zipf.write(file_path, arcname=f"water_bodies.{ext}")

            zip_buffer.seek(0)

        filename = f"water_bodies_{start_date}_to_{end_date}.zip"
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        return StreamingResponse(zip_buffer, media_type="application/zip", headers=headers)

    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Shapefile export error")
        raise HTTPException(status_code=500, detail=f"Shapefile export failed: {str(exc)}") from exc


# ═══════════════════════════════════════
# Run
# ═══════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
