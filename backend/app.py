import os
from flask import Flask, jsonify, request
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from shapely.geometry import shape

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL not set")

engine = create_engine(DATABASE_URL, future=True)
app = Flask(__name__)

@app.get("/health")
def health():
    with engine.connect() as conn:
        v = conn.execute(text("SELECT 1")).scalar_one()
        pv = conn.execute(text("SELECT postgis_version()")).scalar_one()
    return jsonify(ok=True, db=v, postgis=pv)

@app.post("/fields")
def create_field():
    data = request.get_json(force=True)
    name = data.get("name")
    geom = data.get("boundary")
    if not name or not geom:
        return jsonify(error="name and boundary required"), 400

    # validate GeoJSON polygon
    g = shape(geom)
    if g.geom_type != "Polygon":
        return jsonify(error="boundary must be GeoJSON Polygon"), 400

    with engine.begin() as conn:
        row = conn.execute(text("""
            INSERT INTO fields (name, boundary)
            VALUES (:name, ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326))
            RETURNING id
        """), {"name": name, "geojson": g.to_json()}).mappings().first()

    return jsonify(ok=True, id=row["id"])

@app.get("/fields")
def list_fields():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, name,
                   ST_AsGeoJSON(boundary) AS boundary,
                   ST_Area(boundary::geography) AS area_m2,
                   created_at
            FROM fields
            ORDER BY id DESC
            LIMIT 100
        """)).mappings().all()
    return jsonify(fields=[dict(r) for r in rows])

@app.post("/observations")
def create_observation():
    data = request.get_json(force=True)
    kind = data.get("kind")
    field_id = data.get("field_id")
    geom = data.get("geom")          # optional
    accuracy_m = data.get("accuracy_m")
    payload = data.get("payload", {})

    if not kind:
        return jsonify(error="kind required"), 400

    geojson = None
    if geom is not None:
        g = shape(geom)
        geojson = g.to_json()

    with engine.begin() as conn:
        row = conn.execute(text("""
            INSERT INTO observations (field_id, kind, geom, accuracy_m, payload)
            VALUES (
              :field_id,
              :kind,
              CASE WHEN :geojson IS NULL THEN NULL
                   ELSE ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326)
              END,
              :accuracy_m,
              :payload::jsonb
            )
            RETURNING id
        """), {
            "field_id": field_id,
            "kind": kind,
            "geojson": geojson,
            "accuracy_m": accuracy_m,
            "payload": payload
        }).mappings().first()

    return jsonify(ok=True, id=row["id"])

@app.get("/observations")
def list_observations():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, field_id, observed_at, kind,
                   CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom) END AS geom,
                   accuracy_m, payload
            FROM observations
            ORDER BY id DESC
            LIMIT 200
        """)).mappings().all()
    return jsonify(observations=[dict(r) for r in rows])

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

