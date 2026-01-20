/* ui/apps/postgis/js/map.js
 *
 * Multi-layer, map-first Leaflet wrapper.
 * Back-compat API:
 *   - window.GCMap.init(opts)
 *   - window.GCMap.onMoveEnd(fn)
 *   - window.GCMap.getBounds4326()
 *   - window.GCMap.setFeatures(fc, {layerId, layerName})
 *   - window.GCMap.clear(layerId?) // if no id: clears all
 *   - window.GCMap.setLayerVisible(layerId, visible)
 *   - window.GCMap.applyOrder(orderIds) // bottom->top
 *   - window.GCMap.setBasemap(key)
 *   - window.GCMap.setBasemapOpacity(alpha)
 *   - window.GCMap.invalidateSize()
 *   - window.GCMap.fitBounds4326(bbox)
 */

(function () {
  "use strict";

  function clamp01(x) {
    x = Number(x);
    if (Number.isNaN(x)) return 1;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  const BASEMAPS = {
    osm: {
      name: "OSM",
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    satellite: {
      name: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: {
        maxZoom: 19,
        attribution:
          "Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      },
    },
    topo: {
      name: "Topo",
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 17,
        attribution:
          'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
          'SRTM | Map style: © <a href="https://opentopomap.org">OpenTopoMap</a>',
      },
    },
  };

  function safePaneId(layerId) {
    return "gc-" + String(layerId).replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  class GCMapCore {
    constructor(mapDivId, opts = {}) {
      this.mapDivId = mapDivId || "map";
      const center = opts.center || [32.5, -85.9];
      const zoom = opts.zoom || 11;

      this.map = L.map(this.mapDivId, {
        zoomControl: true,
        preferCanvas: true,
      }).setView(center, zoom);

      this._basemapKey = null;
      this._basemapLayer = null;
      this._basemapOpacity = 1;

      // layerId -> { paneId, layer (L.GeoJSON), visible, layerName }
      this._layers = new Map();

      this.setBasemap(opts.basemapKey || "osm");
      this.setBasemapOpacity(
        typeof opts.basemapOpacity === "number" ? opts.basemapOpacity : 1
      );
    }

    setBasemap(key) {
      const k = String(key || "").toLowerCase();
      const bm = BASEMAPS[k] || BASEMAPS.osm;
      const newKey = BASEMAPS[k] ? k : "osm";

      if (this._basemapLayer) {
        try { this.map.removeLayer(this._basemapLayer); } catch (e) {}
        this._basemapLayer = null;
      }

      this._basemapLayer = L.tileLayer(bm.url, bm.options).addTo(this.map);
      this._basemapLayer.setOpacity(this._basemapOpacity);

      this._basemapKey = newKey;
      return newKey;
    }

    setBasemapOpacity(alpha) {
      this._basemapOpacity = clamp01(alpha);
      if (this._basemapLayer) this._basemapLayer.setOpacity(this._basemapOpacity);
      return this._basemapOpacity;
    }

    getBounds4326() {
      const b = this.map.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      return { west: sw.lng, south: sw.lat, east: ne.lng, north: ne.lat };
    }

    fitBounds4326(bbox) {
      if (!bbox) return;
      const west = Number(bbox.west);
      const south = Number(bbox.south);
      const east = Number(bbox.east);
      const north = Number(bbox.north);
      if ([west, south, east, north].some(Number.isNaN)) return;
      const bounds = L.latLngBounds(L.latLng(south, west), L.latLng(north, east));
      this.map.fitBounds(bounds, { padding: [20, 20] });
    }

    invalidateSizeSafe() {
      try { this.map.invalidateSize(); } catch (e) {}
    }

    onMoveEnd(handler) {
      this.map.on("moveend", handler);
      return () => this.map.off("moveend", handler);
    }

    _ensureLayer(layerId, layerName) {
      const id = String(layerId || "default");
      if (this._layers.has(id)) return this._layers.get(id);

      const paneId = safePaneId(id);
      if (!this.map.getPane(paneId)) {
        this.map.createPane(paneId);
      }

      const emitClick = (feature) => {
        try {
          window.dispatchEvent(
            new CustomEvent("gc:featureclick", {
              detail: { layerName: layerName || id, feature },
            })
          );
        } catch (e) {}
      };

      const styleFn = () => ({ weight: 2, opacity: 0.9, fillOpacity: 0.25 });
      const pointToLayer = (feature, latlng) =>
        L.circleMarker(latlng, { radius: 6, weight: 2, fillOpacity: 0.35 });

      const gj = L.geoJSON(
        { type: "FeatureCollection", features: [] },
        {
          pane: paneId,
          style: styleFn,
          pointToLayer,
          onEachFeature: (feature, layer) => {
            layer.on("click", () => emitClick(feature));
          },
        }
      );

      const entry = { paneId, layer: gj, visible: true, layerName: layerName || id };
      this._layers.set(id, entry);
      gj.addTo(this.map);
      return entry;
    }

    setFeatures(featureCollection, opts = {}) {
      const layerId = String(opts.layerId || opts.layerName || "default");
      const layerName = opts.layerName || layerId;

      const entry = this._ensureLayer(layerId, layerName);

      // clear then add
      entry.layer.clearLayers();
      entry.layer.addData(featureCollection || { type: "FeatureCollection", features: [] });

      // respect visibility state
      if (!entry.visible) {
        try { this.map.removeLayer(entry.layer); } catch (e) {}
      } else {
        try { entry.layer.addTo(this.map); } catch (e) {}
      }
    }

    setLayerVisible(layerId, visible) {
      const id = String(layerId || "default");
      const entry = this._layers.get(id);
      if (!entry) return;

      entry.visible = !!visible;
      if (entry.visible) {
        try { entry.layer.addTo(this.map); } catch (e) {}
      } else {
        try { this.map.removeLayer(entry.layer); } catch (e) {}
      }
    }

    applyOrder(orderIds) {
      // orderIds: bottom -> top
      const ids = Array.isArray(orderIds) ? orderIds.map(String) : [];
      ids.forEach((id, i) => {
        const entry = this._layers.get(id);
        if (!entry) return;

        const pane = this.map.getPane(entry.paneId);
        if (pane) pane.style.zIndex = String(400 + i); // keep above tiles

        // also bring visible ones forward in Leaflet internal ordering
        if (entry.visible && entry.layer && entry.layer.bringToFront) {
          try { entry.layer.bringToFront(); } catch (e) {}
        }
      });
    }

    clear(layerId) {
      if (!layerId) {
        // clear all
        for (const [id, entry] of this._layers.entries()) {
          try { this.map.removeLayer(entry.layer); } catch (e) {}
        }
        this._layers.clear();
        return;
      }

      const id = String(layerId);
      const entry = this._layers.get(id);
      if (!entry) return;
      try { this.map.removeLayer(entry.layer); } catch (e) {}
      this._layers.delete(id);
    }
  }

  window.GCMapClass = GCMapCore;

  window.GCMap = {
    init: function (opts = {}) {
      if (window.gcMap && window.gcMap.map) return window.gcMap;

      const targetId = opts.mapDivId || "map";
      const el = document.getElementById(targetId);
      if (!el) throw new Error(`Map container #${targetId} not found`);

      window.gcMap = new GCMapCore(targetId, opts);

      // sync UI if present
      try {
        const sel = document.getElementById("basemapSelect");
        const slider = document.getElementById("basemapOpacity");
        const label = document.getElementById("basemapOpacityLabel");

        if (sel) sel.value = window.gcMap._basemapKey || "osm";
        if (slider) {
          const pct = Math.round((window.gcMap._basemapOpacity || 1) * 100);
          slider.value = String(pct);
          if (label) label.textContent = `${pct}%`;
        }
      } catch (e) {}

      setTimeout(() => window.gcMap.invalidateSizeSafe(), 0);
      return window.gcMap;
    },

    onMoveEnd: function (handler) {
      if (!window.gcMap) window.GCMap.init({ mapDivId: "map" });
      return window.gcMap.onMoveEnd(handler);
    },

    getBounds4326: function () {
      if (!window.gcMap) window.GCMap.init({ mapDivId: "map" });
      return window.gcMap.getBounds4326();
    },

    setFeatures: function (fc, opts = {}) {
      if (!window.gcMap) window.GCMap.init({ mapDivId: "map" });
      return window.gcMap.setFeatures(fc, opts);
    },

    clear: function (layerId) {
      if (!window.gcMap) return;
      return window.gcMap.clear(layerId);
    },

    setLayerVisible: function (layerId, visible) {
      if (!window.gcMap) return;
      return window.gcMap.setLayerVisible(layerId, visible);
    },

    applyOrder: function (orderIds) {
      if (!window.gcMap) return;
      return window.gcMap.applyOrder(orderIds);
    },

    setBasemap: function (key) {
      if (!window.gcMap) window.GCMap.init({ mapDivId: "map" });
      return window.gcMap.setBasemap(key);
    },

    setBasemapOpacity: function (alpha) {
      if (!window.gcMap) window.GCMap.init({ mapDivId: "map" });
      return window.gcMap.setBasemapOpacity(alpha);
    },

    invalidateSize: function () {
      if (window.gcMap) return window.gcMap.invalidateSizeSafe();
    },

    fitBounds4326: function (bbox) {
      if (!window.gcMap) window.GCMap.init({ mapDivId: "map" });
      return window.gcMap.fitBounds4326(bbox);
    },
  };

  function wireBasemapUI() {
    const sel = document.getElementById("basemapSelect");
    const slider = document.getElementById("basemapOpacity");
    const label = document.getElementById("basemapOpacityLabel");

    if (sel) {
      sel.addEventListener("change", () => window.GCMap.setBasemap(sel.value));
    }

    if (slider) {
      const setLabel = (pct) => { if (label) label.textContent = `${pct}%`; };
      slider.addEventListener("input", () => {
        const pct = Number(slider.value || 100);
        setLabel(pct);
        window.GCMap.setBasemapOpacity(pct / 100);
      });
    }

    window.addEventListener("resize", () => window.GCMap.invalidateSize());
  }

  document.addEventListener("DOMContentLoaded", wireBasemapUI);
})();
