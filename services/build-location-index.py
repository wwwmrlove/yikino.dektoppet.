from __future__ import annotations

import json
import sqlite3
import sys
import zipfile
from pathlib import Path


def geometry_center(geometry: dict) -> tuple[float, float]:
    if geometry.get("type") == "Polygon":
        polygons = [geometry.get("coordinates", [])]
    elif geometry.get("type") == "MultiPolygon":
        polygons = geometry.get("coordinates", [])
    else:
        polygons = []

    weighted_longitude = 0.0
    weighted_latitude = 0.0
    total_area = 0.0
    all_points: list[list[float]] = []
    for polygon in polygons:
        ring = polygon[0] if polygon else []
        twice_area = 0.0
        longitude_numerator = 0.0
        latitude_numerator = 0.0
        for current, following in zip(ring, ring[1:]):
            all_points.append(current)
            cross = current[0] * following[1] - following[0] * current[1]
            twice_area += cross
            longitude_numerator += (current[0] + following[0]) * cross
            latitude_numerator += (current[1] + following[1]) * cross
        if abs(twice_area) < 1e-10:
            continue
        area = abs(twice_area / 2.0)
        weighted_longitude += longitude_numerator / (3.0 * twice_area) * area
        weighted_latitude += latitude_numerator / (3.0 * twice_area) * area
        total_area += area

    if total_area:
        return weighted_longitude / total_area, weighted_latitude / total_area
    if not all_points:
        raise ValueError("geometry contains no usable points")
    longitudes = [point[0] for point in all_points]
    latitudes = [point[1] for point in all_points]
    return (
        (min(longitudes) + max(longitudes)) / 2.0,
        (min(latitudes) + max(latitudes)) / 2.0,
    )


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: build-location-index.py DATABASE SOURCE_ZIP OUTPUT_JSON")
    database_path, archive_path, output_path = map(Path, sys.argv[1:])
    with sqlite3.connect(database_path) as database:
        database.row_factory = sqlite3.Row
        rows = database.execute(
            """
            SELECT province, city, district, path, level
            FROM ADMINISTRATIVE
            WHERE iso3 = 'CHN'
              AND source = '高德'
              AND kind = '陆地'
              AND level IN ('省', '市', '区县')
            ORDER BY province, city, district
            """
        ).fetchall()

    records = []
    missing = []
    archive_prefix = (
        "cnmaps-data-main/cnmaps_data/data/datasets/"
    )
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        for row in rows:
            archive_name = archive_prefix + row["path"]
            if archive_name not in names:
                missing.append(row["path"])
                continue
            with archive.open(archive_name) as source:
                geometry = json.load(source)
            longitude, latitude = geometry_center(geometry)
            records.append(
                {
                    "province": row["province"],
                    "city": row["city"],
                    "district": row["district"],
                    "level": row["level"],
                    "longitude": round(longitude, 6),
                    "latitude": round(latitude, 6),
                }
            )

    result = {
        "source": "cnmetlab/cnmaps-data",
        "license": "MIT",
        "coordinateSource": "Amap administrative boundaries",
        "records": records,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"records={len(records)} missing={len(missing)} bytes={output_path.stat().st_size}")
    if missing:
        print("missing paths:", *missing[:20], sep="\n")


if __name__ == "__main__":
    main()
