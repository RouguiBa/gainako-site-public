const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "indices", bands: 4, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 },
    ],
  };
}

function evaluatePixel(sample) {
  const excluded = [3, 6, 8, 9, 10, 11].includes(sample.SCL);
  const denominator = sample.B08 + sample.B04;
  const ndvi = denominator === 0 ? 0 : (sample.B08 - sample.B04) / denominator;
  return {
    indices: [
      ndvi,
      ndvi >= 0.2 && ndvi < 0.4 ? 1 : 0,
      ndvi >= 0.4 ? 1 : 0,
      ndvi < 0.2 ? 1 : 0,
    ],
    dataMask: [sample.dataMask && !excluded ? 1 : 0],
  };
}`;

const NDVI_LAYER_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" },
  };
}

function evaluatePixel(sample) {
  const excluded = [3, 6, 8, 9, 10, 11].includes(sample.SCL);
  const denominator = sample.B08 + sample.B04;
  if (excluded || !sample.dataMask || denominator === 0) return [0, 0, 0, 0];
  const ndvi = (sample.B08 - sample.B04) / denominator;
  if (ndvi < 0.2) return [189, 130, 81, 220];
  if (ndvi < 0.4) return [240, 207, 88, 220];
  if (ndvi < 0.6) return [163, 201, 87, 220];
  return [39, 133, 74, 220];
}`;

const TRUE_COLOR_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B02", "B03", "B04", "SCL", "dataMask"] }],
    output: { bands: 4, sampleType: "UINT8" },
  };
}

function evaluatePixel(sample) {
  const excluded = [3, 6, 8, 9, 10, 11].includes(sample.SCL);
  if (excluded || !sample.dataMask) return [0, 0, 0, 0];
  const stretch = (value) => Math.max(0, Math.min(255, Math.round(value * 2.5 * 255)));
  return [stretch(sample.B04), stretch(sample.B03), stretch(sample.B02), 255];
}`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

async function readJson(response: Response, service: string) {
  try {
    return await response.json();
  } catch (error) {
    console.error(`${service} returned invalid JSON.`, error);
    throw new Error(`${service} returned an invalid response.`);
  }
}

async function requestProcessImage(
  accessToken: string,
  evalscript: string,
  timeRange: { from: string; to: string },
  bbox: number[],
  width: number,
  height: number,
) {
  const response = await fetch("https://sh.dataspace.copernicus.eu/process/v1", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "image/png",
    },
    body: JSON.stringify({
      input: {
        bounds: {
          bbox,
          properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
        },
        data: [{
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange,
            maxCloudCoverage: 30,
            mosaickingOrder: "leastCC",
          },
        }],
      },
      output: {
        width,
        height,
        responses: [{ identifier: "default", format: { type: "image/png" } }],
      },
      evalscript,
    }),
  });
  if (!response.ok) throw new Error(`Sentinel Hub Process API returned HTTP ${response.status}`);
  if (!response.headers.get("Content-Type")?.includes("image/png")) {
    throw new Error("Sentinel Hub Process API returned a non-PNG image.");
  }

  const imageBytes = new Uint8Array(await response.arrayBuffer());
  let binaryImage = "";
  for (let offset = 0; offset < imageBytes.length; offset += 0x6000) {
    binaryImage += String.fromCharCode(...imageBytes.subarray(offset, offset + 0x6000));
  }
  return btoa(binaryImage);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST")   return jsonResponse({ error: "Méthode non autorisée." }, 405);

  const authorization = request.headers.get("Authorization");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const clientId = Deno.env.get("COPERNICUS_CLIENT_ID");
  const clientSecret = Deno.env.get("COPERNICUS_CLIENT_SECRET");
  if (!projectUrl || !publishableKey || !authorization?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Une session Supabase valide est nécessaire." }, 401);
  }
  if (!clientId || !clientSecret) {
    console.error("Copernicus OAuth secrets are not configured.");
    return jsonResponse({ error: "L’accès à Sentinel Hub n’est pas configuré." }, 500);
  }

  let body: { fieldId?: unknown; from?: unknown; to?: unknown };
  try {
    body = await request.json();
  } catch (error) {
    console.error("Sentinel analysis request body is invalid.", error);
    return jsonResponse({ error: "La demande d’analyse est invalide." }, 400);
  }
  if (!body || typeof body !== "object" || !isUuid(body.fieldId)) {
    return jsonResponse({ error: "L’identifiant de la parcelle est invalide." }, 400);
  }
  const fromDate = parseDateOnly(body.from);
  const toDate = parseDateOnly(body.to);
  if (!fromDate || !toDate) {
    return jsonResponse({ error: "Choisissez une date de début et une date de fin valides." }, 400);
  }
  const from = fromDate.toISOString().slice(0, 10);
  const to = toDate.toISOString().slice(0, 10);
  if (from > to) {
    return jsonResponse({ error: "La date de début doit précéder ou être égale à la date de fin." }, 400);
  }
  if (to > new Date().toISOString().slice(0, 10)) {
    return jsonResponse({ error: "La date de fin ne peut pas être dans le futur." }, 400);
  }
  const durationDays = Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
  if (durationDays > 366) {
    return jsonResponse({ error: "La période d’analyse ne peut pas dépasser un an." }, 400);
  }

  const authHeaders = { apikey: publishableKey, Authorization: authorization };
  let userResponse: Response;
  try {
    userResponse = await fetch(`${projectUrl}/auth/v1/user`, { headers: authHeaders });
  } catch (error) {
    console.error("Supabase user verification failed.", error);
    return jsonResponse({ error: "Impossible de vérifier la session Supabase." }, 502);
  }
  if (!userResponse.ok) return jsonResponse({ error: "La session Supabase est invalide ou a expiré." }, 401);

  const fieldUrl = new URL(`${projectUrl}/rest/v1/fields`);
  fieldUrl.searchParams.set("id", `eq.${body.fieldId}`);
  fieldUrl.searchParams.set("select", "id,boundary");
  let fieldResponse: Response;
  try {
    fieldResponse = await fetch(fieldUrl, { headers: authHeaders });
  } catch (error) {
    console.error("Could not load the parcel boundary for NDVI analysis.", error);
    return jsonResponse({ error: "Impossible de charger le contour de la parcelle." }, 502);
  }
  if (!fieldResponse.ok) {
    console.error("Supabase rejected the parcel boundary request with HTTP", fieldResponse.status);
    return jsonResponse({ error: "Impossible de lire le contour de cette parcelle." }, 403);
  }
  const fields = await readJson(fieldResponse, "Supabase");
  const boundary = Array.isArray(fields) && fields.length === 1 ? fields[0].boundary : null;
  if (!Array.isArray(boundary) || boundary.length < 3 || boundary.length > 500
      || !boundary.every((point) => Array.isArray(point)
        && point.length === 2
        && Number.isFinite(point[0])
        && Number.isFinite(point[1])
        && point[0] >= -90
        && point[0] <= 90
        && point[1] >= -180
        && point[1] <= 180)) {
    return jsonResponse({ error: "Le contour de la parcelle est absent ou invalide." }, 422);
  }

  const ring = boundary.map(([lat, lng]: [number, number]) => [lng, lat]);
  ring.push([...ring[0]]);
  const geometry = { type: "Polygon", coordinates: [ring] };
  const exclusiveToDate = new Date(toDate);
  exclusiveToDate.setUTCDate(exclusiveToDate.getUTCDate() + 1);
  const timeRange = {
    from: `${from}T00:00:00Z`,
    to: `${exclusiveToDate.toISOString().slice(0, 10)}T00:00:00Z`,
  };

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );
  } catch (error) {
    console.error("Copernicus OAuth request failed.", error);
    return jsonResponse({ error: "Impossible de joindre le service d’authentification Copernicus." }, 502);
  }
  if (!tokenResponse.ok) {
    console.error("Copernicus OAuth returned HTTP", tokenResponse.status);
    return jsonResponse({ error: "Copernicus a refusé la configuration du client OAuth." }, 502);
  }
  const token = await readJson(tokenResponse, "Copernicus OAuth");
  if (typeof token.access_token !== "string") {
    console.error("Copernicus OAuth response is missing an access token.");
    return jsonResponse({ error: "Copernicus a renvoyé un jeton d’accès invalide." }, 502);
  }

  const statisticsRequest = {
    input: {
      bounds: {
        geometry,
        properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: { maxCloudCoverage: 30, mosaickingOrder: "leastCC" },
      }],
    },
    aggregation: {
      timeRange,
      aggregationInterval: { of: `P${durationDays}D` },
      evalscript: EVALSCRIPT,
    },
  };

  let statisticsResponse: Response;
  try {
    statisticsResponse = await fetch("https://sh.dataspace.copernicus.eu/statistics/v1", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token.access_token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(statisticsRequest),
    });
  } catch (error) {
    console.error("Sentinel Hub Statistics API request failed.", error);
    return jsonResponse({ error: "Impossible de joindre Sentinel Hub." }, 502);
  }
  if (!statisticsResponse.ok) {
    console.error("Sentinel Hub Statistics API returned HTTP", statisticsResponse.status);
    return jsonResponse(
      { error: statisticsResponse.status === 429
        ? "Le quota Copernicus mensuel ou par minute est atteint."
        : "Sentinel Hub n’a pas pu calculer les statistiques de la parcelle." },
      statisticsResponse.status === 429 ? 429 : 502,
    );
  }

  const statistics = await readJson(statisticsResponse, "Sentinel Hub Statistics API");
  const result = statistics.data?.[0];
  const bands = result?.outputs?.indices?.bands;
  const means = bands
    ? ["B0", "B1", "B2", "B3"].map((name) => bands[name]?.stats?.mean)
    : [];
  const validPixels = bands?.B0?.stats?.sampleCount;
  if (statistics.status !== "OK" || means.length !== 4
      || !means.every((value) => typeof value === "number" && Number.isFinite(value))
      || !Number.isFinite(validPixels) || validPixels <= 0) {
    return jsonResponse({
      error: `Aucune observation Sentinel‑2 exploitable n’a été trouvée pour cette parcelle entre le ${from} et le ${to}.`,
    }, 404);
  }

  const longitudes = boundary.map((point: [number, number]) => point[1]);
  const latitudes = boundary.map((point: [number, number]) => point[0]);
  const centerLongitude = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const centerLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const halfWidth = Math.max((Math.max(...longitudes) - Math.min(...longitudes)) / 2, 0.005);
  const halfHeight = Math.max((Math.max(...latitudes) - Math.min(...latitudes)) / 2, 0.005);
  const bbox = [
    centerLongitude - halfWidth,
    centerLatitude - halfHeight,
    centerLongitude + halfWidth,
    centerLatitude + halfHeight,
  ];
  const meanLatitude = (bbox[1] + bbox[3]) / 2;
  const widthMeters = (bbox[2] - bbox[0]) * 111320 * Math.cos(meanLatitude * Math.PI / 180);
  const heightMeters = (bbox[3] - bbox[1]) * 111320;
  const imageWidth = Math.max(1, Math.min(512, Math.ceil(widthMeters / 10)));
  const imageHeight = Math.max(1, Math.min(512, Math.ceil(heightMeters / 10)));
  let ndviLayer: { image: string; bbox: number[] } | null = null;
  let layerError: string | null = null;
  try {
    ndviLayer = {
      image: await requestProcessImage(
        token.access_token,
        NDVI_LAYER_EVALSCRIPT,
        timeRange,
        bbox,
        imageWidth,
        imageHeight,
      ),
      bbox,
    };
  } catch (error) {
    console.error("Sentinel Hub could not create the NDVI layer.", error);
    layerError = "La couche colorée n’a pas pu être générée.";
  }
  let copernicusLayer: { image: string; bbox: number[] } | null = null;
  let copernicusLayerError: string | null = null;
  try {
    copernicusLayer = {
      image: await requestProcessImage(
        token.access_token,
        TRUE_COLOR_EVALSCRIPT,
        timeRange,
        bbox,
        imageWidth,
        imageHeight,
      ),
      bbox,
    };
  } catch (error) {
    console.error("Sentinel Hub could not create the natural-color layer.", error);
    copernicusLayerError = "L’image satellite Copernicus n’a pas pu être générée.";
  }

  return jsonResponse({
    from,
    to,
    meanNdvi: means[0],
    sparseCoverFraction: means[1],
    denseCoverFraction: means[2],
    lowCoverFraction: means[3],
    validPixels,
    ndviLayer,
    layerError,
    copernicusLayer,
    copernicusLayerError,
  });
});
