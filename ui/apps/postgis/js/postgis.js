// /PostGIS/js/postgis.js
// Multi-layer PostGIS browser (map-first) with:
// - per-layer geometry column support
// - empty-layer detection (COUNT(geomCol))
// - auto pick first non-empty layer
// - auto-fit to active layer extent if viewport returns 0
// - checkbox visibility + Up/Down reorder + active highlight
// - debounced reload on pan/zoom for active layer

(() => {
  const $ = (sel, el = document) => el.querySelector(sel);

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  async function postJson(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      throw new Error(data?.detail || data?.message || `Request failed: ${resp.status}`);
    }
    return data;
  }

  async function getJson(url) {
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.detail || `Request failed: ${resp.status}`);
    return data;
  }

  function rowsToFeatureCollection(rows) {
    const features = [];
    for (const r of rows || []) {
      if (!r || !r.geojson) continue;
      try {
        const geom = typeof r.geojson === "string" ? JSON.parse(r.geojson) : r.geojson;
        const props = { ...r };
        delete props.geojson;
        features.push({ type: "Feature", geometry: geom, properties: props });
      } catch {}
    }
    return { type: "FeatureCollection", features };
  }

  function setInspector(layerName, feature) {
    const props = feature?.properties || {};
    $("#insLayer").textContent = layerName || "—";
    const id = props.id ?? props.gid ?? props.objectid ?? props.fid ?? "—";
    $("#insId").textContent = String(id);
    $("#insGeom").textContent = feature?.geometry?.type || "—";

    let preview = "—";
    try {
      const s = JSON.stringify(props);
      preview = s.length > 120 ? s.slice(0, 120) + "…" : s;
    } catch {}
    $("#insProps").textContent = preview;
  }

  async function loadLayerCatalog() {
    const c = await getJson("/api/v1/postgis/catalog");
    const out = [];
    const schemas = c.schemas || Object.keys(c.tables_by_schema || {});
    for (const schema of schemas) {
      const tables = c.tables_by_schema?.[schema] || [];
      for (const t of tables) {
        if (!t.has_geom) continue;
        const geomCol = (t.geom_cols && t.geom_cols[0]) || t.geom_col || "geom";
        out.push({
          schema: t.schema || schema,
          name: t.name,
          full: `${t.schema || schema}.${t.name}`,
          geomCol,
          geomCount: null, // filled later
        });
      }
    }
    return out;
  }

  // Uses COUNT(geomCol) (nonnull count). Fast-ish, index helps, but usually fine.
  async function hydrateGeomCounts(layers) {
    if (!layers.length) return layers;

    // Build one SQL with subselects to avoid round trips.
    // SELECT (SELECT COUNT(boundary) FROM public.fields WHERE boundary IS NOT NULL) AS "public.fields", ...
    const parts = layers.map((l) => {
      const col = l.geomCol;
      const tbl = l.full;
      // Alias must be a valid identifier; we quote it.
      const alias = l.full.replaceAll('"', '""');
      return `(SELECT COUNT(${col}) FROM ${tbl} WHERE ${col} IS NOT NULL) AS "${alias}"`;
    });

    const sql = `SELECT ${parts.join(", ")};`;
    const data = await postJson("/api/v1/postgis/query", { sql });

    const row = data?.rows?.[0] || {};
    for (const l of layers) {
      const v = row[l.full];
      l.geomCount = (v == null) ? 0 : Number(v);
      if (!Number.isFinite(l.geomCount)) l.geomCount = 0;
    }
    return layers;
  }

  window.GCPostgisApp = (() => {
    let layers = [];
    let active = null;

    const visible = new Set();
    const loaded = new Set();
    let order = [];

    const sridCache = new Map();

    function applyOrderToMap() {
      try { window.GCMap.applyOrder(order.slice()); } catch {}
    }

    function ensureOrderInitialized() {
      if (order.length) return;
      order = layers.map((l) => l.full);
      applyOrderToMap();
    }

    function moveLayer(layerId, dir) {
      const idx = order.indexOf(layerId);
      if (idx < 0) return;
      const j = idx + dir;
      if (j < 0 || j >= order.length) return;
      const tmp = order[idx];
      order[idx] = order[j];
      order[j] = tmp;
      applyOrderToMap();
      renderLayerList($("#layerSearch")?.value || "");
    }

    async function getLayerSrid(layer) {
      const layerId = layer.full;
      if (sridCache.has(layerId)) return sridCache.get(layerId);

      const g = layer.geomCol;
      const sql = `
        SELECT ST_SRID(${g}) AS srid
        FROM ${layer.full}
        WHERE ${g} IS NOT NULL
        LIMIT 1;
      `.trim();

      const data = await postJson("/api/v1/postgis/query", { sql });
      const srid = Number(data?.rows?.[0]?.srid);
      const safe = Number.isFinite(srid) && srid > 0 ? srid : 4326;
      sridCache.set(layerId, safe);
      return safe;
    }

    async function getLayerExtent4326(layer) {
      const g = layer.geomCol;
      const srid = await getLayerSrid(layer);
      const geomExpr = srid === 4326 ? g : `ST_Transform(${g}, 4326)`;

      const sql = `
        SELECT
          ST_XMin(e) AS west,
          ST_YMin(e) AS south,
          ST_XMax(e) AS east,
          ST_YMax(e) AS north
        FROM (
          SELECT ST_Extent(${geomExpr})::box2d AS e
          FROM ${layer.full}
          WHERE ${g} IS NOT NULL
        ) q;
      `.trim();

      const data = await postJson("/api/v1/postgis/query", { sql });
      return data?.rows?.[0] || null;
    }

    function buildViewportSQL(layer, bbox, srid, limit = 600) {
      const g = layer.geomCol;
      const geomExpr = srid === 4326 ? g : `ST_Transform(${g}, 4326)`;

      return `
        SELECT
          *,
          ST_AsGeoJSON(${geomExpr}) AS geojson
        FROM ${layer.full}
        WHERE ${g} IS NOT NULL
          AND ST_Intersects(
            ${geomExpr},
            ST_MakeEnvelope(${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north}, 4326)
          )
        LIMIT ${limit};
      `.trim();
    }

    async function loadLayerInViewport(layer, { updateCounters } = { updateCounters: false }) {
      const bbox = window.GCMap.getBounds4326();
      const srid = await getLayerSrid(layer);
      const sql = buildViewportSQL(layer, bbox, srid, 600);

      const sqlEditor = $("#sqlEditor");
      if (sqlEditor) sqlEditor.value = sql;

      const t0 = performance.now();
      const data = await postJson("/api/v1/postgis/query", { sql });
      const t1 = performance.now();

      const fc = rowsToFeatureCollection(data.rows || []);
      // IMPORTANT: layerId is stable id for visibility/order ops
      window.GCMap.setFeatures(fc, { layerId: layer.full, layerName: layer.full });

      loaded.add(layer.full);

      // enforce visibility + order after setting features
      window.GCMap.setLayerVisible(layer.full, visible.has(layer.full));
      applyOrderToMap();

      if (updateCounters) {
        $("#activeLayerLabel").textContent = layer.full;
        $("#featureCount").textContent = String(fc.features.length);
        $("#loadMs").textContent = `${data.elapsed_ms ?? Math.round(t1 - t0)} ms`;
        $("#srcBadge").textContent = "viewport";
      }

      return fc;
    }

    async function runActiveViewportLoad() {
      if (!active) return null;
      if (!visible.has(active.full)) return null;
      return await loadLayerInViewport(active, { updateCounters: true });
    }

    function renderLayerList(filterText = "") {
      const host = $("#layersHost");
      const badge = $("#layersBadge");
      if (badge) badge.textContent = String(layers.length);
      if (!host) return;

      host.innerHTML = "";

      const ft = (filterText || "").toLowerCase().trim();
      const shown = layers.filter((l) => !ft || l.full.toLowerCase().includes(ft));

      if (!shown.length) {
        const empty = document.createElement("div");
        empty.style.opacity = ".7";
        empty.textContent = "No matching layers.";
        host.appendChild(empty);
        return;
      }

      shown.forEach((layer) => {
        const layerId = layer.full;
        const isActive = active && active.full === layerId;

        const row = document.createElement("div");
        row.className = "row" + (isActive ? " active" : "");

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = visible.has(layerId);
        cb.style.marginRight = "10px";
        cb.addEventListener("click", (e) => e.stopPropagation());

        // Disable empty layers; make it obvious
        const emptyGeom = (layer.geomCount != null && layer.geomCount <= 0);
        if (emptyGeom) {
          cb.checked = false;
          cb.disabled = true;
          cb.title = "No geometries present in this table.";
        }

        cb.addEventListener("change", async () => {
          if (cb.checked) {
            visible.add(layerId);

            if (!loaded.has(layerId)) {
              try {
                await loadLayerInViewport(layer, { updateCounters: isActive });
              } catch (e) {
                visible.delete(layerId);
                cb.checked = false;
                alert(e.message || String(e));
                return;
              }
            } else {
              window.GCMap.setLayerVisible(layerId, true);
              applyOrderToMap();
            }
          } else {
            visible.delete(layerId);
            window.GCMap.setLayerVisible(layerId, false);
          }
        });

        const name = document.createElement("span");
        name.textContent = layerId;
        name.style.flex = "1";
        name.style.overflow = "hidden";
        name.style.textOverflow = "ellipsis";
        name.style.whiteSpace = "nowrap";
        name.style.marginRight = "10px";

        const upBtn = document.createElement("button");
        upBtn.className = "btn";
        upBtn.textContent = "Up";
        upBtn.style.padding = "6px 10px";
        upBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveLayer(layerId, -1);
        });

        const downBtn = document.createElement("button");
        downBtn.className = "btn";
        downBtn.textContent = "Down";
        downBtn.style.padding = "6px 10px";
        downBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveLayer(layerId, +1);
        });

        const geomBadge = document.createElement("span");
        geomBadge.className = "badge";
        geomBadge.textContent = layer.geomCol;

        // Add empty badge if needed
        if (emptyGeom) {
          const emptyBadge = document.createElement("span");
          emptyBadge.className = "badge";
          emptyBadge.style.marginLeft = "8px";
          emptyBadge.textContent = "empty";
          row.appendChild(cb);
          row.appendChild(name);
          row.appendChild(upBtn);
          row.appendChild(downBtn);
          row.appendChild(geomBadge);
          row.appendChild(emptyBadge);
        } else {
          row.appendChild(cb);
          row.appendChild(name);
          row.appendChild(upBtn);
          row.appendChild(downBtn);
          row.appendChild(geomBadge);
        }

        row.addEventListener("click", async () => {
          active = layer;
          renderLayerList($("#layerSearch")?.value || "");

          // If layer has no geom, don't try to load
          if (emptyGeom) {
            $("#activeLayerLabel").textContent = layer.full;
            $("#featureCount").textContent = "0";
            $("#loadMs").textContent = "0 ms";
            $("#srcBadge").textContent = "viewport";
            return;
          }

          visible.add(layerId);

          try {
            if (!loaded.has(layerId)) {
              await loadLayerInViewport(layer, { updateCounters: true });
              // If still empty, try to fit to extent (if any)
              const cnt = Number($("#featureCount")?.textContent || "0");
              if (!cnt) {
                const ext = await getLayerExtent4326(layer);
                if (ext && ext.west != null) {
                  window.GCMap.fitBounds4326(ext);
                  await loadLayerInViewport(layer, { updateCounters: true });
                }
              }
            } else {
              window.GCMap.setLayerVisible(layerId, true);
              const fc = await runActiveViewportLoad();
              if (!fc?.features?.length) {
                const ext = await getLayerExtent4326(layer);
                if (ext && ext.west != null) {
                  window.GCMap.fitBounds4326(ext);
                  await runActiveViewportLoad();
                }
              }
            }
          } catch (e) {
            alert(e.message || String(e));
          }
        });

        host.appendChild(row);
      });
    }

    function bindUI() {
      $("#layerSearch")?.addEventListener("input", (e) => {
        renderLayerList(e.target.value);
      });

      $("#btnReload")?.addEventListener("click", async () => {
        try { await runActiveViewportLoad(); } catch (e) { alert(e.message || String(e)); }
      });

      $("#btnClear")?.addEventListener("click", () => {
        try { window.GCMap.clear(); } catch {}
        loaded.clear();
        visible.clear();
        sridCache.clear();

        $("#featureCount").textContent = "0";
        $("#loadMs").textContent = "0 ms";
        $("#activeLayerLabel").textContent = "—";
        $("#srcBadge").textContent = "viewport";

        $("#insLayer").textContent = "—";
        $("#insId").textContent = "—";
        $("#insGeom").textContent = "—";
        $("#insProps").textContent = "—";

        renderLayerList($("#layerSearch")?.value || "");
      });

      $("#btnAdvanced")?.addEventListener("click", () => {
        const d = $("#advancedDrawer");
        if (!d) return;
        d.classList.toggle("open");
        try { window.GCMap.invalidateSize(); } catch {}
      });

      $("#btnRunSql")?.addEventListener("click", async () => {
        const sql = ($("#sqlEditor")?.value || "").trim();
        if (!sql) return;

        try {
          const t0 = performance.now();
          const data = await postJson("/api/v1/postgis/query", { sql });
          const t1 = performance.now();

          const fc = rowsToFeatureCollection(data.rows || []);
          if (!fc.features.length) {
            alert("SQL ran, but no geojson column was returned. This mode expects geojson to draw.");
            return;
          }

          const advId = "advanced-sql";
          visible.add(advId);
          loaded.add(advId);
          if (!order.includes(advId)) order.push(advId);

          window.GCMap.setFeatures(fc, { layerId: advId, layerName: advId });
          window.GCMap.setLayerVisible(advId, true);
          applyOrderToMap();

          $("#srcBadge").textContent = "advanced";
          $("#featureCount").textContent = String(fc.features.length);
          $("#loadMs").textContent = `${data.elapsed_ms ?? Math.round(t1 - t0)} ms`;
          $("#activeLayerLabel").textContent = advId;
        } catch (e) {
          alert(e.message || String(e));
        }
      });

      $("#btnFillViewportSql")?.addEventListener("click", async () => {
        try { await runActiveViewportLoad(); } catch (e) { alert(e.message || String(e)); }
      });

      window.addEventListener("gc:featureclick", (evt) => {
        const layerName = evt?.detail?.layerName || (active ? active.full : "—");
        const feature = evt?.detail?.feature;
        setInspector(layerName, feature);
      });

      window.GCMap.onMoveEnd(
        debounce(async () => {
          try { await runActiveViewportLoad(); } catch {}
        }, 350)
      );
    }

    async function init() {
      window.GCMap.init();

      layers = await loadLayerCatalog();
      if (!layers.length) {
        $("#layersHost").innerHTML = `<div style="opacity:.7;">No geometry layers found.</div>`;
        return;
      }

      // Fill geom counts so we can skip empty layers automatically
      try { await hydrateGeomCounts(layers); } catch {}

      ensureOrderInitialized();

      // Pick first non-empty layer as active
      active = layers.find((l) => (l.geomCount == null ? true : l.geomCount > 0)) || layers[0];

      // Default visible: active only if it has data
      if (active && (active.geomCount == null || active.geomCount > 0)) {
        visible.add(active.full);
      }

      renderLayerList("");
      bindUI();

      // initial load if active is non-empty
      if (active && (active.geomCount == null || active.geomCount > 0)) {
        const fc = await loadLayerInViewport(active, { updateCounters: true });
        if (!fc?.features?.length) {
          try {
            const ext = await getLayerExtent4326(active);
            if (ext && ext.west != null) {
              window.GCMap.fitBounds4326(ext);
              await loadLayerInViewport(active, { updateCounters: true });
            }
          } catch {}
        }
      } else if (active) {
        $("#activeLayerLabel").textContent = active.full;
        $("#featureCount").textContent = "0";
        $("#loadMs").textContent = "0 ms";
        $("#srcBadge").textContent = "viewport";
      }
    }

    return { init };
  })();
})();
