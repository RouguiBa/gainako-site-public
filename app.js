"use strict";

(() => {
  const WAYBACK_SEARCH_URL = "https://www.arcgis.com/sharing/rest/search";
  const WEB_MERCATOR_RADIUS = 6378137;
  const CURRENT_SATELLITE_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const CATEGORY_LABELS = {
    culture: "Culture",
    batiment: "Bâtiment",
    eau: "Eau / irrigation",
    travaux: "Travaux",
    observation: "Observation",
  };
  const CATEGORY_COLORS = {
    culture: "#64864b",
    batiment: "#886a99",
    eau: "#4d91a0",
    travaux: "#d28445",
    observation: "#6b7d87",
  };

  const form = document.querySelector("#record-form");
  const list = document.querySelector("#records-list");
  const notice = document.querySelector("#notice");
  const latitudeInput = document.querySelector("#record-latitude");
  const longitudeInput = document.querySelector("#record-longitude");
  const boundaryButton = document.querySelector("#boundary-button");
  const finishBoundaryButton = document.querySelector("#finish-boundary");
  const mapHint = document.querySelector("#map-hint");
  const authGate = document.querySelector("#auth-gate");
  const authMessage = document.querySelector("#auth-message");
  const loginForm = document.querySelector("#login-form");
  const loginButton = document.querySelector("#login-button");
  const appShell = document.querySelector("#app-shell");
  let state = { records: [], boundary: [] };
  let field = null;
  let supabaseClient = null;
  let map = null;
  let ndviOverlay = null;
  let copernicusOverlay = null;
  let authenticatedUserId = null;
  let sessionOperation = 0;
  let drawingBoundary = false;
  let draftBoundary = [];
  let boundaryLayer = null;
  let draftLayer = null;
  let recordLayers = [];
  let noticeTimeout;

  function isValidPoint(point) {
    return Array.isArray(point)
      && point.length === 2
      && Number.isFinite(point[0])
      && Number.isFinite(point[1])
      && point[0] >= -90
      && point[0] <= 90
      && point[1] >= -180
      && point[1] <= 180;
  }

  function isValidRecord(record) {
    return Boolean(record)
      && typeof record.id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)
      && typeof record.title === "string"
      && record.title.trim().length > 0
      && record.title.length <= 80
      && typeof record.date === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
      && typeof record.category === "string"
      && Object.hasOwn(CATEGORY_LABELS, record.category)
      && Number.isFinite(record.latitude)
      && record.latitude >= -90
      && record.latitude <= 90
      && Number.isFinite(record.longitude)
      && record.longitude >= -180
      && record.longitude <= 180
      && (record.description === undefined
        || (typeof record.description === "string" && record.description.length <= 500));
  }

  function observationFromRow(row) {
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      date: row.date,
      description: row.description || "",
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    };
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.classList.add("visible");
    window.clearTimeout(noticeTimeout);
    noticeTimeout = window.setTimeout(() => notice.classList.remove("visible"), 4200);
  }

  function setCoordinates(lat, lng) {
    latitudeInput.value = lat.toFixed(6);
    longitudeInput.value = lng.toFixed(6);
  }

  async function updateFieldBoundary(boundary) {
    const { data, error } = await supabaseClient
      .from("fields")
      .update({ boundary })
      .eq("id", field.id)
      .select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("La limite de la parcelle n’a pas pu être enregistrée.");
  }

  function createMap(privateField) {
    if (!window.L) {
      showNotice("La carte ne s’est pas chargée. Vérifiez votre connexion puis actualisez la page.");
      return;
    }

    const map = L.map("map", { scrollWheelZoom: true, maxZoom: 24 });
    const satelliteLayer = L.tileLayer(CURRENT_SATELLITE_TILE_URL, {
      maxZoom: 24,
      maxNativeZoom: 19,
      attribution: 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Vantor, Earthstar Geographics, and the GIS User Community',
    });
    const streetLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 24,
      maxNativeZoom: 24,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    let satelliteErrorShown = false;
    satelliteLayer.on("tileerror", () => {
      if (satelliteErrorShown) return;
      satelliteErrorShown = true;
      showNotice("Certaines images satellite Esri sont indisponibles à cet endroit ou à ce niveau de zoom.");
    });
    function selectBaseLayer(layerName) {
      if (layerName === "copernicus" && !copernicusOverlay) {
        showNotice("Lance d’abord une analyse pour préparer l’image Copernicus de cette période.");
        document.querySelector('input[name="base-layer"][value="esri"]').checked = true;
        return;
      }
      for (const layer of [satelliteLayer, streetLayer, copernicusOverlay]) {
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
      }
      if (layerName === "street") {
        streetLayer.addTo(map);
      } else if (layerName === "copernicus") {
        copernicusOverlay.addTo(map);
      } else {
        satelliteLayer.addTo(map);
      }
      if (ndviOverlay && document.querySelector("#layer-ndvi").checked) {
        if (map.hasLayer(ndviOverlay)) map.removeLayer(ndviOverlay);
        ndviOverlay.addTo(map);
      }
      if (boundaryLayer && document.querySelector("#layer-boundary").checked) {
        if (map.hasLayer(boundaryLayer)) map.removeLayer(boundaryLayer);
        boundaryLayer.addTo(map);
      }
      const creditLink = document.querySelector("#map-credit-link");
      const credits = {
        esri: ["https://livingatlas.arcgis.com/wayback/", "Source Esri World Imagery Wayback"],
        copernicus: ["https://dataspace.copernicus.eu/", "Source Sentinel‑2 · Copernicus"],
        street: ["https://www.openstreetmap.org/fixthemap", "Signaler une erreur"],
      };
      [creditLink.href, creditLink.textContent] = credits[layerName];
    }
    document.querySelectorAll('input[name="base-layer"]').forEach((input) => {
      input.addEventListener("change", (event) => {
        if (event.currentTarget.checked) selectBaseLayer(event.currentTarget.value);
      });
    });
    document.querySelector("#layer-boundary").addEventListener("change", (event) => {
      if (!boundaryLayer) return;
      if (event.currentTarget.checked) boundaryLayer.addTo(map);
      else map.removeLayer(boundaryLayer);
    });
    document.querySelector("#layer-ndvi").addEventListener("change", (event) => {
      if (!ndviOverlay) return;
      if (event.currentTarget.checked) ndviOverlay.addTo(map);
      else map.removeLayer(ndviOverlay);
      if (event.currentTarget.checked && boundaryLayer
          && document.querySelector("#layer-boundary").checked) {
        boundaryLayer.bringToFront();
      }
    });
    document.querySelector("#map-credit-link").href = "https://livingatlas.arcgis.com/wayback/";
    document.querySelector("#map-credit-link").textContent = "Source Esri World Imagery Wayback";
    document.querySelector("#imagery-source").textContent =
      "Fond Esri World Imagery courant. Chargement des versions historiques…";

    const logMapZoom = () => console.log("Zoom de la carte GAINAKO :", map.getZoom());
    map.on("zoomend", logMapZoom);
    setCoordinates(privateField.center_lat, privateField.center_lng);
    drawBoundary(map);
    renderRecords(map);
    if (state.boundary.length >= 3) {
      map.fitBounds(L.latLngBounds(state.boundary), { padding: [70, 70], maxZoom: 17 });
    } else {
      map.setView([privateField.center_lat, privateField.center_lng], 17);
    }
    satelliteLayer.addTo(map);
    map.whenReady(logMapZoom);
    setupImageryTimeline(satelliteLayer, privateField);

    map.on("click", (event) => {
      const { lat, lng } = event.latlng;
      if (drawingBoundary) {
        draftBoundary.push([lat, lng]);
        drawDraftBoundary(map);
        finishBoundaryButton.disabled = draftBoundary.length < 3;
        mapHint.textContent = `${draftBoundary.length} point(s) placé(s). Il en faut au moins 3 pour terminer le contour.`;
        return;
      }
      setCoordinates(lat, lng);
      document.querySelector("#record-title").focus();
      showNotice("Emplacement choisi pour la prochaine note.");
    });

    document.querySelector("#locate-button").addEventListener("click", () => {
      if (state.boundary.length >= 3) {
        map.fitBounds(L.latLngBounds(state.boundary), { padding: [45, 45], maxZoom: 17 });
      } else {
        map.setView([privateField.center_lat, privateField.center_lng], 17);
      }
    });
    document.querySelector("#fullscreen-button").addEventListener("click", async () => {
      const target = document.querySelector(".map-workspace");
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await target.requestFullscreen();
        window.setTimeout(() => map.invalidateSize(), 100);
      } catch (error) {
        console.error("Impossible de passer la carte en plein écran.", error);
        showNotice("Le plein écran n’est pas disponible dans ce navigateur.");
      }
    });
    boundaryButton.addEventListener("click", () => {
      if (drawingBoundary) {
        drawingBoundary = false;
        draftBoundary = [];
        if (draftLayer) map.removeLayer(draftLayer);
        draftLayer = null;
        boundaryButton.textContent = state.boundary.length >= 3 ? "Modifier le contour" : "Tracer le contour";
        finishBoundaryButton.disabled = true;
        mapHint.textContent = "Tracé annulé. Cliquez sur la carte pour placer la prochaine note.";
        return;
      }
      drawingBoundary = true;
      draftBoundary = [];
      finishBoundaryButton.disabled = true;
      boundaryButton.textContent = "Annuler le tracé";
      mapHint.textContent = "Cliquez sur la carte autour de la parcelle, puis choisissez « Terminer » (3 points minimum).";
      if (draftLayer) map.removeLayer(draftLayer);
    });
    finishBoundaryButton.addEventListener("click", async () => {
      if (draftBoundary.length < 3) return;
      const nextBoundary = draftBoundary.map((point) => [...point]);
      finishBoundaryButton.disabled = true;
      try {
        await updateFieldBoundary(nextBoundary);
      } catch (error) {
        console.error("Impossible d’enregistrer le contour dans Supabase.", error);
        showNotice("Contour non enregistré. Vérifiez la connexion et réessayez.");
        finishBoundaryButton.disabled = false;
        return;
      }
      state.boundary = nextBoundary;
      drawingBoundary = false;
      draftBoundary = [];
      if (draftLayer) map.removeLayer(draftLayer);
      draftLayer = null;
      boundaryButton.textContent = "Modifier le contour";
      finishBoundaryButton.disabled = true;
      mapHint.textContent = "Contour enregistré. Cliquez sur la carte pour placer la prochaine note.";
      drawBoundary(map);
      renderSummary();
    });

    return map;
  }

  function formatImageryDate(date) {
    const parsed = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return date;
    return new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(parsed);
  }

  function getSourceDate(attributes) {
    const compactDate = typeof attributes.SRC_DATE === "string" ? attributes.SRC_DATE : "";
    const displayDate = typeof attributes.SRC_DATE2 === "string" ? attributes.SRC_DATE2 : "";
    if (/^\d{8}$/.test(compactDate)) {
      const isoDate = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
      return { value: isoDate, timestamp: Date.parse(`${isoDate}T00:00:00Z`) };
    }
    const timestamp = Date.parse(displayDate);
    return Number.isNaN(timestamp)
      ? null
      : { value: new Date(timestamp).toISOString().slice(0, 10), timestamp };
  }

  function getImagerySourceQuery(metadataLayerUrl, privateField) {
    const x = privateField.center_lng * WEB_MERCATOR_RADIUS / 180;
    const y = Math.log(Math.tan((90 + privateField.center_lat) * Math.PI / 360)) * WEB_MERCATOR_RADIUS;
    const params = new URLSearchParams({
      f: "json",
      geometry: JSON.stringify({ x, y, spatialReference: { wkid: 3857 } }),
      geometryType: "esriGeometryPoint",
      sr: "3857",
      mapExtent: `${x - 1000},${y - 1000},${x + 1000},${y + 1000}`,
      imageDisplay: "800,600,96",
      tolerance: "3",
      returnGeometry: "false",
      layers: "all:0,1,2,3,4,5,6,7,8,9,10,11,12,13",
    });
    return `${metadataLayerUrl}/identify?${params}`;
  }

  let imagerySourceLookupNumber = 0;

  async function updateImagerySourceDate(release, lookupNumber, privateField) {
    const sourceLabel = document.querySelector("#imagery-source");
    sourceLabel.textContent = "Recherche de la date de prise de vue sur la parcelle…";
    try {
      const response = await fetch(getImagerySourceQuery(release.metadataLayerUrl, privateField));
      if (!response.ok) throw new Error(`Esri a répondu ${response.status}.`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || "Réponse invalide du service Esri.");
      if (lookupNumber !== imagerySourceLookupNumber) return;

      const sources = (Array.isArray(data.results) ? data.results : [])
        .map((item) => {
          const attributes = item.attributes || {};
          return {
            date: getSourceDate(attributes),
            provider: attributes.NICE_DESC,
            resolution: Number(attributes.SRC_RES),
          };
        })
        .filter((source) => source.date)
        .sort((a, b) => b.date.timestamp - a.date.timestamp);
      const latestSource = sources[0];
      if (!latestSource) {
        sourceLabel.textContent = "Esri ne fournit pas de date de prise de vue pour ce secteur.";
        return;
      }

      const details = [latestSource.provider, Number.isFinite(latestSource.resolution)
        ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(latestSource.resolution)} m`
        : ""].filter(Boolean);
      sourceLabel.textContent =
        `Prise de vue source indiquée : ${formatImageryDate(latestSource.date.value)}${details.length ? ` · ${details.join(" · ")}` : ""}.`;
    } catch (error) {
      if (lookupNumber !== imagerySourceLookupNumber) return;
      console.error("Impossible de récupérer les métadonnées d’imagerie Esri.", error);
      sourceLabel.textContent = "Date de prise de vue indisponible pour cette version.";
    }
  }

  function setupImageryTimeline(satelliteLayer, privateField) {
    const slider = document.querySelector("#imagery-timeline");
    const releaseLabel = document.querySelector("#imagery-release");
    const sourceLabel = document.querySelector("#imagery-source");
    const newestLabel = document.querySelector("#imagery-newest");
    const oldestLabel = document.querySelector("#imagery-oldest");
    let releases = [];
    let activeReleaseIndex = -1;
    let changeTimeout;

    function selectRelease(index) {
      if (!Number.isInteger(index) || index < 0 || index >= releases.length || index === activeReleaseIndex) return;
      activeReleaseIndex = index;
      const release = releases[index];
      releaseLabel.textContent = `Version du fond : ${formatImageryDate(release.date)}`;
      imagerySourceLookupNumber += 1;
      void updateImagerySourceDate(release, imagerySourceLookupNumber, privateField);
      void updateSatelliteLayer(release, index);
    }

    async function updateSatelliteLayer(release, index) {
      try {
        const response = await fetch(
          `https://www.arcgis.com/sharing/rest/content/items/${encodeURIComponent(release.itemId)}/data?f=json`,
        );
        if (!response.ok) throw new Error(`ArcGIS a répondu ${response.status}.`);
        const itemData = await response.json();
        if (typeof itemData.templateUrl !== "string") {
          throw new Error("Cette version Esri ne fournit pas de modèle de tuiles.");
        }
        if (index !== activeReleaseIndex) return;
        const tileTemplate = itemData.templateUrl
          .replace(/^http:/, "https:")
          .replace("{level}", "{z}")
          .replace("{row}", "{y}")
          .replace("{col}", "{x}");
        satelliteLayer.setUrl(tileTemplate);
      } catch (error) {
        if (index !== activeReleaseIndex) return;
        console.error("Impossible de charger cette version des images Esri.", error);
        showNotice("Cette version satellite ne peut pas être affichée pour le moment.");
      }
    }

    async function loadWaybackReleases() {
      const allItems = [];
      let start = 1;
      do {
        const params = new URLSearchParams({
          q: 'owner:esri_imagery AND title:"World Imagery (Wayback"',
          num: "100",
          start: String(start),
          sortField: "created",
          sortOrder: "desc",
          f: "json",
        });
        const response = await fetch(`${WAYBACK_SEARCH_URL}?${params}`);
        if (!response.ok) throw new Error(`ArcGIS a répondu ${response.status}.`);
        const result = await response.json();
        if (typeof result.error?.message === "string") throw new Error(result.error.message);
        if (!Array.isArray(result.results)) throw new Error("Réponse du catalogue Esri invalide.");
        allItems.push(...result.results);
        start = result.nextStart;
      } while (Number.isInteger(start) && start > 0);

      const releasesByDate = new Map();
      for (const item of allItems) {
        const match = item.title?.match(/World Imagery \(Wayback (\d{4}-\d{2}-\d{2})\)/);
        if (!match) continue;
        const date = match[1];
        const release = releasesByDate.get(date) || { date };
        if (item.type === "WMTS") release.itemId = item.id;
        if (item.type === "Map Service" && item.title.endsWith(" Metadata")) {
          release.metadataLayerUrl = item.url;
        }
        releasesByDate.set(date, release);
      }
      return [...releasesByDate.values()]
        .filter((release) => release.itemId && release.metadataLayerUrl)
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    slider.addEventListener("input", () => {
      const selectedIndex = Number(slider.value);
      const selectedRelease = releases[selectedIndex];
      if (selectedRelease) {
        releaseLabel.textContent = `Version du fond : ${formatImageryDate(selectedRelease.date)}`;
      }
      window.clearTimeout(changeTimeout);
      changeTimeout = window.setTimeout(() => selectRelease(selectedIndex), 350);
    });
    slider.addEventListener("change", () => {
      window.clearTimeout(changeTimeout);
      selectRelease(Number(slider.value));
    });

    loadWaybackReleases()
      .then((catalogReleases) => {
        releases = catalogReleases;
        if (!releases.length) throw new Error("Le catalogue Esri ne contient aucune version datée.");

        slider.min = "0";
        slider.max = String(releases.length - 1);
        slider.value = String(releases.length - 1);
        slider.disabled = false;
        oldestLabel.textContent = formatImageryDate(releases[0].date);
        newestLabel.textContent = formatImageryDate(releases.at(-1).date);
        selectRelease(releases.length - 1);
      })
      .catch((error) => {
        console.error("Impossible de charger les versions historiques Esri.", error);
        releaseLabel.textContent = "Dates historiques indisponibles";
        sourceLabel.textContent = "Le fond satellite courant reste disponible sans le curseur.";
        showNotice("Impossible de charger les dates des images. Le fond courant reste disponible.");
      });
  }

  function drawDraftBoundary(map) {
    if (draftLayer) map.removeLayer(draftLayer);
    if (draftBoundary.length === 1) {
      draftLayer = L.circleMarker(draftBoundary[0], { radius: 5, color: "#d28445" }).addTo(map);
      return;
    }
    draftLayer = L.polyline(draftBoundary, { color: "#d28445", dashArray: "5 7", weight: 3 }).addTo(map);
    if (draftBoundary.length >= 3) {
      draftLayer = L.polygon(draftBoundary, { color: "#d28445", fillColor: "#d28445", fillOpacity: 0.12, weight: 2 }).addTo(map);
    }
  }

  function drawBoundary(map) {
    if (boundaryLayer) map.removeLayer(boundaryLayer);
    if (state.boundary.length >= 3) {
      boundaryLayer = L.polygon(state.boundary, {
        color: "#f2c230",
        fillColor: "#ffe16c",
        fillOpacity: 0,
        weight: 4,
      });
      if (document.querySelector("#layer-boundary").checked) boundaryLayer.addTo(map);
      boundaryLayer.bindPopup(`<strong>Contour du champ</strong><br>${formatArea(areaInHectares(state.boundary))}`);
      boundaryButton.textContent = "Modifier le contour";
    } else {
      boundaryLayer = null;
    }
  }

  function areaInHectares(points) {
    const radius = 6378137;
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
      const [lat1, lon1] = points[i];
      const [lat2, lon2] = points[(i + 1) % points.length];
      const lat1Rad = lat1 * Math.PI / 180;
      const lat2Rad = lat2 * Math.PI / 180;
      const lonDiff = (lon2 - lon1) * Math.PI / 180;
      area += lonDiff * (2 + Math.sin(lat1Rad) + Math.sin(lat2Rad));
    }
    return Math.abs(area * radius * radius / 2) / 10000;
  }

  function formatArea(value) {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value)} ha`;
  }

  function renderSummary() {
    const count = state.records.length;
    document.querySelector("#record-count").textContent = `${count} ${count === 1 ? "note" : "notes"}`;
    document.querySelector("#record-total").textContent = String(count);
    document.querySelector("#area-value").textContent = state.boundary.length >= 3
      ? formatArea(areaInHectares(state.boundary))
      : "À mesurer";
  }

  function renderRecords(map) {
    for (const layer of recordLayers) map.removeLayer(layer);
    recordLayers = [];
    list.replaceChildren();
    if (!state.records.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Aucune observation. Ajoutez un premier point de suivi sur la parcelle.";
      list.append(empty);
      renderSummary();
      return;
    }

    const sortedRecords = [...state.records].sort((a, b) => b.date.localeCompare(a.date));
    for (const record of sortedRecords) {
      const card = document.createElement("article");
      card.className = "record-card";
      const topline = document.createElement("div");
      topline.className = "record-topline";
      const title = document.createElement("p");
      title.className = "record-title";
      title.textContent = record.title;
      const category = document.createElement("span");
      category.className = "category-tag";
      category.textContent = CATEGORY_LABELS[record.category];
      category.style.backgroundColor = `${CATEGORY_COLORS[record.category]}18`;
      category.style.color = CATEGORY_COLORS[record.category];
      topline.append(title, category);

      const meta = document.createElement("p");
      meta.className = "record-meta";
      meta.textContent = `${formatDate(record.date)} · ${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`;
      card.append(topline, meta);
      if (record.description) {
        const description = document.createElement("p");
        description.className = "record-description";
        description.textContent = record.description;
        card.append(description);
      }

      const actions = document.createElement("div");
      actions.className = "record-topline";
      actions.style.marginTop = "8px";
      const mapLink = document.createElement("a");
      mapLink.className = "record-meta";
      mapLink.href = `https://www.openstreetmap.org/?mlat=${record.latitude}&mlon=${record.longitude}#map=18/${record.latitude}/${record.longitude}`;
      mapLink.target = "_blank";
      mapLink.rel = "noopener noreferrer";
      mapLink.textContent = "Voir sur la carte ↗";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-record";
      remove.textContent = "Supprimer";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Supprimer la note « ${record.title} » ?`)) return;
        remove.disabled = true;
        try {
          const { data, error } = await supabaseClient
            .from("observations")
            .delete()
            .eq("id", record.id)
            .eq("field_id", field.id)
            .select("id");
          if (error) throw error;
          if (!data?.length) throw new Error("Aucune observation supprimée.");
        } catch (error) {
          console.error("Impossible de supprimer l’observation dans Supabase.", error);
          showNotice("Observation non supprimée. Vérifiez la connexion et réessayez.");
          remove.disabled = false;
          return;
        }
        state.records = state.records.filter((item) => item.id !== record.id);
        renderRecords(map);
      });
      actions.append(mapLink, remove);
      card.append(actions);
      list.append(card);

      const marker = L.circleMarker([record.latitude, record.longitude], {
        radius: 7,
        color: "#fffefa",
        weight: 2,
        fillColor: CATEGORY_COLORS[record.category],
        fillOpacity: 1,
      }).addTo(map);
      recordLayers.push(marker);
      const popup = document.createElement("div");
      const popupTitle = document.createElement("p");
      popupTitle.className = "popup-title";
      popupTitle.textContent = record.title;
      const popupDescription = document.createElement("p");
      popupDescription.className = "popup-content";
      popupDescription.textContent = record.description || CATEGORY_LABELS[record.category];
      popup.append(popupTitle, popupDescription);
      marker.bindPopup(popup);
    }
    renderSummary();
  }

  function formatDate(date) {
    const parsed = new Date(`${date}T12:00:00`);
    return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" }).format(parsed);
  }

  function setToday() {
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    document.querySelector("#record-date").value = localDate;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const record = {
      id: crypto.randomUUID(),
      title: String(data.get("title")).trim(),
      category: String(data.get("category")),
      date: String(data.get("date")),
      description: String(data.get("description")).trim(),
      latitude: Number(data.get("latitude")),
      longitude: Number(data.get("longitude")),
    };
    if (!isValidRecord(record)) {
      showNotice("Vérifiez le type de note et les coordonnées indiquées.");
      return;
    }

    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      const { data: row, error } = await supabaseClient
        .from("observations")
        .insert({ ...record, field_id: field.id })
        .select("*")
        .single();
      if (error) throw error;
      state.records.push(observationFromRow(row));
    } catch (error) {
      console.error("Impossible d’enregistrer l’observation dans Supabase.", error);
      showNotice("Observation non enregistrée. Vérifiez la connexion et réessayez.");
      submitButton.disabled = false;
      return;
    }
    renderRecords(map);
    form.reset();
    setToday();
    setCoordinates(field.center_lat, field.center_lng);
    document.querySelector("#form-status").textContent = "Observation enregistrée et synchronisée.";
    submitButton.disabled = false;
  });

  document.querySelector("#export-button").addEventListener("click", () => {
    const file = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const download = document.createElement("a");
    download.href = URL.createObjectURL(file);
    download.download = "gainako-suivi.json";
    download.click();
    URL.revokeObjectURL(download.href);
    showNotice("Copie des données de suivi téléchargée.");
  });

  document.querySelector("#import-file").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!imported || !Array.isArray(imported.records) || !Array.isArray(imported.boundary)
        || !imported.records.every(isValidRecord) || imported.boundary.length < 3
        || !imported.boundary.every(isValidPoint)) {
        throw new Error("Le fichier ne correspond pas au format attendu.");
      }
      const observations = imported.records.map((record) => ({ ...record, field_id: field.id }));
      if (observations.length) {
        const { error } = await supabaseClient
          .from("observations")
          .upsert(observations, { onConflict: "id" });
        if (error) throw error;
      }
      await updateFieldBoundary(imported.boundary);
      state = { records: [...state.records], boundary: imported.boundary };
      if (observations.length) {
        const { data, error } = await supabaseClient
          .from("observations")
          .select("*")
          .eq("field_id", field.id)
          .order("date", { ascending: false });
        if (error) throw error;
        state.records = data.map(observationFromRow);
      }
      drawBoundary(map);
      renderRecords(map);
      showNotice("Données importées et synchronisées. Les observations existantes ont été conservées.");
    } catch (error) {
      console.error("Import des données impossible.", error);
      showNotice("Import impossible : choisissez un fichier JSON exporté depuis GAINAKO.");
    } finally {
      event.target.value = "";
    }
  });

  let installPrompt;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    document.querySelector("#install-button").hidden = false;
  });

  document.querySelector("#install-button").addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    document.querySelector("#install-button").hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    document.querySelector("#install-button").hidden = true;
    showNotice("GAINAKO a été installé sur cet appareil.");
  });

  function setAuthMessage(message, kind = "") {
    authMessage.textContent = message;
    authMessage.classList.toggle("error", kind === "error");
    authMessage.classList.toggle("success", kind === "success");
  }

  async function loadFieldData() {
    const { data: fieldRow, error: fieldError } = await supabaseClient
      .from("fields")
      .select("id,name,center_lat,center_lng,boundary")
      .limit(1)
      .maybeSingle();
    if (fieldError) throw fieldError;
    if (!fieldRow) throw new Error("Ce compte n’a pas encore accès à une parcelle GAINAKO.");
    if (typeof fieldRow.name !== "string"
      || !Number.isFinite(Number(fieldRow.center_lat))
      || !Number.isFinite(Number(fieldRow.center_lng))
      || !Array.isArray(fieldRow.boundary)
      || fieldRow.boundary.length < 3
      || !fieldRow.boundary.every(isValidPoint)) {
      throw new Error("La parcelle enregistrée dans Supabase est incomplète ou invalide.");
    }

    const { data: rows, error: recordsError } = await supabaseClient
      .from("observations")
      .select("id,title,category,date,description,latitude,longitude")
      .eq("field_id", fieldRow.id)
      .order("date", { ascending: false });
    if (recordsError) throw recordsError;
    const records = rows.map(observationFromRow);
    if (!records.every(isValidRecord)) throw new Error("Une observation enregistrée est invalide.");
    return {
      field: {
        ...fieldRow,
        center_lat: Number(fieldRow.center_lat),
        center_lng: Number(fieldRow.center_lng),
      },
      state: { records, boundary: fieldRow.boundary },
    };
  }

  async function applySession(session) {
    const operation = ++sessionOperation;
    if (!session?.user?.id) {
      authenticatedUserId = null;
      field = null;
      state = { records: [], boundary: [] };
      if (map) map.remove();
      map = null;
      recordLayers = [];
      boundaryLayer = null;
      draftLayer = null;
      authGate.hidden = false;
      appShell.hidden = true;
      document.querySelector("#auth-signout").hidden = true;
      loginForm.hidden = false;
      loginButton.disabled = false;
      setAuthMessage("Connectez-vous avec un compte autorisé.");
      return;
    }

    if (session.user.id === authenticatedUserId && map) return;
    if (authenticatedUserId && session.user.id !== authenticatedUserId) {
      window.location.reload();
      return;
    }
    if (map) map.remove();
    map = null;
    authenticatedUserId = session.user.id;
    authGate.hidden = false;
    appShell.hidden = true;
    loginForm.hidden = true;
    document.querySelector("#auth-signout").hidden = false;
    setAuthMessage("Chargement sécurisé des données du champ…");
    try {
      const result = await loadFieldData();
      if (operation !== sessionOperation) return;
      field = result.field;
      state = result.state;
      document.querySelector("#field-name").textContent = field.name;
      document.querySelector("#field-name-header").textContent = field.name;
      document.querySelector("#map-field-name").textContent = field.name;
      document.querySelector("#field-location").textContent =
        `${field.center_lat.toFixed(6)}°, ${field.center_lng.toFixed(6)}°`;
      document.querySelector("#imagery-source").textContent = "Chargement du fond Esri World Imagery…";
      appShell.hidden = false;
      authGate.hidden = true;
      map = createMap(field);
      setAuthMessage("");
    } catch (error) {
      if (operation !== sessionOperation) return;
      console.error("Impossible de charger les données privées de GAINAKO.", error);
      setAuthMessage(error instanceof Error
        ? error.message
        : "Connexion impossible. Vérifiez les droits et la configuration Supabase.", "error");
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabaseClient || !loginForm.reportValidity()) return;
    loginButton.disabled = true;
    setAuthMessage("Vérification des identifiants…");
    const values = new FormData(loginForm);
    try {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email: String(values.get("email")).trim(),
        password: String(values.get("password")),
      });
      if (!error) return;
      console.error("Échec de connexion à Supabase.", error);
      setAuthMessage("Connexion refusée. Vérifiez l’adresse e-mail et le mot de passe.", "error");
      loginButton.disabled = false;
    } catch (error) {
      console.error("La connexion à Supabase a échoué.", error);
      setAuthMessage("Connexion impossible. Vérifiez votre accès à Internet et réessayez.", "error");
      loginButton.disabled = false;
    }
  });

  async function signOut() {
    if (!supabaseClient) return;
    try {
      const { error } = await supabaseClient.auth.signOut();
      if (!error) return;
      console.error("Impossible de fermer la session Supabase.", error);
      showNotice("Déconnexion impossible. Réessayez.");
    } catch (error) {
      console.error("La déconnexion Supabase a échoué.", error);
      showNotice("Déconnexion impossible. Vérifiez la connexion et réessayez.");
    }
  }

  function setNdviFraction(prefix, fraction) {
    const percentage = Math.max(0, Math.min(100, fraction * 100));
    const label = `${Math.round(percentage)} %`;
    document.querySelector(`#ndvi-${prefix}-value`).textContent = label;
    document.querySelector(`#ndvi-${prefix}-bar`).style.width = label;
  }

  function interpretNdvi(meanNdvi, validPixels) {
    let title;
    let description;
    if (meanNdvi < 0.2) {
      title = "Peu de végétation détectée";
      description = "Le signal observé est faible. Cela peut correspondre à un sol peu couvert, une période après récolte, une végétation sèche ou clairsemée. Le NDVI ne permet pas d’en déterminer la cause.";
    } else if (meanNdvi < 0.4) {
      title = "Couvert végétal intermédiaire";
      description = "Le signal indique un mélange de végétation et de surfaces moins couvertes, ou une végétation en début de croissance. Ce résultat ne suffit pas à évaluer la santé de la culture.";
    } else {
      title = "Signal de végétation marqué";
      description = "La parcelle présente un signal compatible avec une végétation active ou un couvert important. Cela ne prouve pas à lui seul que la culture est saine ou que le sol est fertile.";
    }
    if (validPixels < 10) {
      description += " Peu de pixels ont été exploitables : interprétation particulièrement incertaine.";
    }
    return { title, description };
  }

  function showNdviLayer(layer) {
    if (!map || !window.L || !Array.isArray(layer?.bbox) || layer.bbox.length !== 4
        || !layer.bbox.every(Number.isFinite)
        || typeof layer.image !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(layer.image)) {
      return false;
    }
    if (ndviOverlay && map.hasLayer(ndviOverlay)) map.removeLayer(ndviOverlay);
    const [west, south, east, north] = layer.bbox;
    if (west >= east || south >= north || state.boundary.length < 3) return false;

    ndviOverlay = L.imageOverlay(
      `data:image/png;base64,${layer.image}`,
      [[south, west], [north, east]],
      { opacity: 0.8, className: "ndvi-overlay", interactive: false },
    );
    ndviOverlay.addTo(map);
    const clipPoints = state.boundary.map(([lat, lng]) => {
      const x = ((lng - west) / (east - west)) * 100;
      const y = ((north - lat) / (north - south)) * 100;
      return `${x}% ${y}%`;
    });
    ndviOverlay.getElement().style.clipPath = `polygon(${clipPoints.join(", ")})`;
    const toggle = document.querySelector("#layer-ndvi");
    toggle.disabled = false;
    toggle.checked = true;
    if (boundaryLayer && document.querySelector("#layer-boundary").checked) {
      boundaryLayer.bringToFront();
    }
    return true;
  }

  function showCopernicusLayer(layer, from, to) {
    if (!map || !window.L || !Array.isArray(layer?.bbox) || layer.bbox.length !== 4
        || !layer.bbox.every(Number.isFinite)
        || typeof layer.image !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(layer.image)) {
      return false;
    }
    const [west, south, east, north] = layer.bbox;
    if (west >= east || south >= north) return false;
    if (copernicusOverlay && map.hasLayer(copernicusOverlay)) map.removeLayer(copernicusOverlay);
    copernicusOverlay = L.imageOverlay(
      `data:image/png;base64,${layer.image}`,
      [[south, west], [north, east]],
      { opacity: 1, className: "sentinel-overlay", interactive: false },
    );
    const dateLabel = from === to
      ? formatImageryDate(from)
      : `${formatImageryDate(from)} – ${formatImageryDate(to)}`;
    document.querySelector("#base-layer-copernicus").disabled = false;
    document.querySelector("#copernicus-layer-help").textContent =
      `Image Sentinel‑2 · ${dateLabel} · env. 500 m de marge ; couverture locale.`;
    if (document.querySelector('input[name="base-layer"][value="copernicus"]').checked) {
      copernicusOverlay.addTo(map);
    }
    return true;
  }

  function dateInputValue(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  const ndviDateTo = document.querySelector("#ndvi-date-to");
  const ndviDateFrom = document.querySelector("#ndvi-date-from");
  const today = new Date();
  const sixtyDaysAgo = new Date(today);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  ndviDateTo.max = dateInputValue(today);
  ndviDateFrom.max = dateInputValue(today);
  ndviDateTo.value = dateInputValue(today);
  ndviDateFrom.value = dateInputValue(sixtyDaysAgo);

  document.querySelector("#ndvi-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const status = document.querySelector("#ndvi-status");
    if (!supabaseClient || !field?.id) {
      status.textContent = "Connectez-vous à GAINAKO pour analyser la parcelle.";
      return;
    }

    const from = ndviDateFrom.value;
    const to = ndviDateTo.value;
    const fromTime = Date.parse(`${from}T00:00:00Z`);
    const toTime = Date.parse(`${to}T00:00:00Z`);
    if (!from || !to || !Number.isFinite(fromTime) || !Number.isFinite(toTime)) {
      status.textContent = "Choisis une date de début et une date de fin valides.";
      return;
    }
    if (from > to) {
      status.textContent = "La date de début doit être antérieure ou égale à la date de fin.";
      return;
    }
    const durationDays = Math.floor((toTime - fromTime) / 86400000) + 1;
    if (durationDays > 366) {
      status.textContent = "La période d’analyse ne peut pas dépasser un an.";
      return;
    }
    if (to > dateInputValue(new Date())) {
      status.textContent = "La date de fin ne peut pas être dans le futur.";
      return;
    }

    button.disabled = true;
    if (ndviOverlay && map?.hasLayer(ndviOverlay)) map.removeLayer(ndviOverlay);
    if (copernicusOverlay && map?.hasLayer(copernicusOverlay)) map.removeLayer(copernicusOverlay);
    if (document.querySelector('input[name="base-layer"][value="copernicus"]').checked) {
      const esriBase = document.querySelector('input[name="base-layer"][value="esri"]');
      esriBase.checked = true;
      esriBase.dispatchEvent(new Event("change"));
    }
    ndviOverlay = null;
    copernicusOverlay = null;
    const ndviLayerCheckbox = document.querySelector("#layer-ndvi");
    ndviLayerCheckbox.checked = false;
    ndviLayerCheckbox.disabled = true;
    document.querySelector("#base-layer-copernicus").disabled = true;
    status.textContent = from === to
      ? `Analyse Sentinel‑2 pour le ${formatImageryDate(from)}…`
      : `Analyse Sentinel‑2 du ${formatImageryDate(from)} au ${formatImageryDate(to)}…`;
    try {
      const { data, error } = await supabaseClient.functions.invoke("sentinel-analysis", {
        body: { fieldId: field.id, from, to },
      });
      if (error) {
        let message = error.message;
        if (typeof error.context?.json === "function") {
          try {
            const details = await error.context.json();
            if (typeof details.error === "string") message = details.error;
          } catch (parseError) {
            console.error("Impossible de lire l’erreur de la fonction NDVI.", parseError);
          }
        }
        throw new Error(message);
      }
      if (!Number.isFinite(data?.meanNdvi)
          || !Number.isFinite(data?.sparseCoverFraction)
          || !Number.isFinite(data?.denseCoverFraction)
          || !Number.isFinite(data?.lowCoverFraction)
          || !Number.isFinite(data?.validPixels)
          || typeof data.from !== "string"
          || typeof data.to !== "string") {
        throw new Error("La fonction NDVI a renvoyé un résultat incomplet.");
      }

      document.querySelector("#ndvi-mean").textContent =
        new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          .format(data.meanNdvi);
      const interpretation = interpretNdvi(data.meanNdvi, data.validPixels);
      document.querySelector("#ndvi-interpretation-title").textContent = interpretation.title;
      document.querySelector("#ndvi-interpretation-description").textContent = interpretation.description;
      setNdviFraction("dense", data.denseCoverFraction);
      setNdviFraction("sparse", data.sparseCoverFraction);
      setNdviFraction("bare", data.lowCoverFraction);
      const formatDate = (date) => new Intl.DateTimeFormat("fr-FR").format(new Date(`${date}T12:00:00Z`));
      document.querySelector("#ndvi-period").textContent = data.from === data.to
        ? `Date analysée : ${formatDate(data.from)}.`
        : `Période analysée : ${formatDate(data.from)} – ${formatDate(data.to)}.`;
      document.querySelector("#ndvi-pixels").textContent =
        `Calcul basé sur ${Math.round(data.validPixels)} pixels Sentinel‑2 valides (environ 10 m chacun).`;
      document.querySelector("#ndvi-results").hidden = false;
      const hasNdviLayer = Boolean(data.ndviLayer && showNdviLayer(data.ndviLayer));
      const hasCopernicusLayer = Boolean(
        data.copernicusLayer && showCopernicusLayer(data.copernicusLayer, data.from, data.to),
      );
      if (!hasNdviLayer && data.ndviLayer) {
        status.textContent = "Analyse terminée, mais la couche NDVI reçue est invalide.";
      } else if (data.layerError || data.copernicusLayerError) {
        status.textContent = [
          "Analyse terminée.",
          data.layerError,
          data.copernicusLayerError,
        ].filter(Boolean).join(" ");
      } else {
        status.textContent = hasNdviLayer && hasCopernicusLayer
          ? "Analyse terminée. La couche NDVI est affichée ; tu peux choisir Sentinel‑2 Copernicus dans les fonds."
          : "Analyse terminée, mais les couches cartographiques n’ont pas pu être préparées.";
      }
    } catch (error) {
      console.error("Impossible de calculer l’analyse NDVI de la parcelle.", error);
      status.textContent = error instanceof Error
        ? `Analyse indisponible : ${error.message}`
        : "Analyse indisponible. Vérifiez la connexion Supabase et la configuration Copernicus.";
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#signout-button").addEventListener("click", signOut);
  document.querySelector("#auth-signout").addEventListener("click", signOut);

  const config = window.GAINAKO_SUPABASE_CONFIG;
  if (!window.supabase?.createClient || !config?.url || !config?.publishableKey) {
    setAuthMessage("Connexion non configurée. Ajoutez l’URL du projet et sa clé Publishable dans supabase-config.js.", "error");
    loginButton.disabled = true;
  } else {
    try {
      supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
      supabaseClient.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
          window.location.reload();
          return;
        }
        if (["INITIAL_SESSION", "SIGNED_IN"].includes(event)) {
          window.setTimeout(() => void applySession(session), 0);
        }
      });
    } catch (error) {
      console.error("Impossible d’initialiser Supabase.", error);
      loginButton.disabled = true;
      setAuthMessage("Configuration Supabase invalide. Vérifiez l’URL et la clé Publishable.", "error");
    }
  }

  if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js")
        .catch((error) => {
          console.error("Impossible d’activer le mode application.", error);
          showNotice("Le mode application n’a pas pu être activé sur cet appareil.");
        });
    });
  }

  setToday();
})();
