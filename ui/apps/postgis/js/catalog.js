// /PostGIS/js/catalog.js
(() => {
  const $ = (sel, el=document) => el.querySelector(sel);

  window.GCPostgisCatalog = (() => {
    async function loadCatalog(){
      const resp = await fetch("/api/v1/postgis/catalog");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.detail || "Catalog fetch failed");
      return data;
    }

    function badgeFor(t){
      if (t.has_raster) return "raster";
      if (t.has_geom) return "geom";
      return t.reltype || "table";
    }

    function render(catalog){
      const host = $("#catalog");
      if (!host) return;

      host.innerHTML = "";

      const title1 = document.createElement("div");
      title1.style.fontWeight = "700";
      title1.style.marginBottom = "6px";
      title1.textContent = "Tables / Views";
      host.appendChild(title1);

      const all = [];
      for (const schema of catalog.schemas || []) {
        for (const t of (catalog.tables_by_schema?.[schema] || [])) {
          all.push(t);
        }
      }

      all.forEach((t, idx) => {
        const row = document.createElement("div");
        row.className = "row" + (idx === 0 ? " active" : "");
        row.dataset.src = `${t.schema}.${t.name}`;
        row.innerHTML = `<span>${t.schema}.${t.name}</span><span class="badge">${badgeFor(t)}</span>`;
        row.addEventListener("click", () => {
          host.querySelectorAll(".row[data-src]").forEach(r => r.classList.remove("active"));
          row.classList.add("active");
          window.GCPostgis.setCurrentTable(row.dataset.src);
        });
        host.appendChild(row);
      });

      const spacer = document.createElement("div");
      spacer.style.height = "12px";
      host.appendChild(spacer);

      const title2 = document.createElement("div");
      title2.style.fontWeight = "700";
      title2.style.marginBottom = "6px";
      title2.textContent = "Quick actions";
      host.appendChild(title2);

      const qa = [
        {key:"gist", label:"Create spatial index (GiST)", badge:"SQL"},
        {key:"analyze", label:"ANALYZE selected table", badge:"Stats"},
      ];

      qa.forEach((a) => {
        const row = document.createElement("div");
        row.className = "row";
        row.dataset.action = a.key;
        row.innerHTML = `<span>${a.label}</span><span class="badge">${a.badge}</span>`;
        row.addEventListener("click", () => {
          const current = $("#srcBadge")?.textContent;
          const sql = $("#sqlEditor");
          if (!current || !sql) return;
          if (a.key === "gist") sql.value = `CREATE INDEX ON ${current} USING GIST (geom);`;
          if (a.key === "analyze") sql.value = `ANALYZE ${current};`;
        });
        host.appendChild(row);
      });
    }

    async function init(){
      const data = await loadCatalog();
      render(data);
      const first = document.querySelector("#catalog .row[data-src]");
      if (first) window.GCPostgis.setCurrentTable(first.dataset.src);
    }

    return { init };
  })();
})();
