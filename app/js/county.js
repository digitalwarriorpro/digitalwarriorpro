// Free homeowner and home value lookups straight from the counties' own public parcel maps
// (ArcGIS REST services). Each county names its layers and fields differently, so the app
// finds the parcel layer and its owner / value / year-built fields on its own the first time,
// then remembers what it found (per phone, and shared with the team through Supabase).

export const COUNTIES = [
  {
    key: "johnson", name: "Johnson County, KS", state: "KS",
    root: "https://maps.jocogov.org/arcgis/rest/services",
    bbox: [38.73, -95.06, 39.06, -94.6],       // south, west, north, east
    test: { lat: 38.9590, lng: -94.6700 },      // Overland Park
  },
  {
    key: "wyandotte", name: "Wyandotte County, KS", state: "KS",
    root: "https://gisweb.wycokck.org/arcgis/rest/services",
    hint: "https://gisweb.wycokck.org/arcgis/rest/services/GISPUB/UGMAPS_4_V02/MapServer",
    bbox: [39.03, -94.91, 39.2, -94.588],
    test: { lat: 39.1125, lng: -94.7000 },      // Kansas City, KS
  },
  {
    key: "jackson", name: "Jackson County, MO", state: "MO",
    root: "https://jcgis.jacksongov.org/arcgis/rest/services",
    // the current Parcel Viewer data is hosted on the county's ArcGIS Online account
    extraRoots: ["https://services3.arcgis.com/4LOAHoFXfea6Y3Et/ArcGIS/rest/services"],
    bbox: [38.83, -94.612, 39.22, -94.1],
    test: { lat: 39.0912, lng: -94.4155 },      // Independence
  },
];

const FIELD_RULES = {
  owner:   [/^own(er)?_?(name|nm)?1?$/i, /owner.?name/i, /^own.?nam/i, /^owner/i, /taxpayer/i, /^own/i],
  owner2:  [/^own(er)?_?(name|nm)?2$/i, /owner.?name.?2/i],
  mail:    [/(mail|own(er)?).?(addr|add|adr|street|line1)/i, /^mail/i],
  mailCity:[/(mail|own(er)?).?(city|cty)/i],
  mailState:[/(mail|own(er)?).?(state|st)$/i],
  situs:   [/situs|site.?add|prop(erty)?.?add|^address$|^addr$|full.?add/i],
  value:   [/(mkt|market).?(val|tot)|(tot|total).?(mkt|market)/i, /apprais.*(tot|val)|(tot|total).?apprais/i, /(tot|total).?(val|value)$/i, /^appr/i, /^(total|tot)_?val/i, /assess.*tot|tot.*assess/i],
  land:    [/land.?(val|mkt|appr)/i],
  impr:    [/(impr|bldg|building).?(val|mkt|appr)/i],
  year:    [/(yr|year).?(blt|built|bui)/i, /^yrblt$/i, /eff.?yr/i],
  sqft:    [/(liv|living|bldg|building|fin|heated).?(area|sq|sf)/i, /^sq.?ft/i, /^sqft/i, /gla$/i],
  saleDate:[/(sale|deed|sold).?(dt|date)/i],
  salePrice:[/(sale|sold).?(pr|price|amt|amount|val)/i],
  parcel:  [/^(parcel|parcel_?id|parcelid|parcel_?num|pin|kup|apn|parcel_number|parcelno)$/i, /parcel/i],
  homestead:[/homestead/i],
};

const j = async (url) => {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(url + sep + "f=json");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "ArcGIS error");
  return data;
};

export function countyFor(lat, lng) {
  return COUNTIES.filter(({ bbox: [s, w, n, e] }) => lat >= s && lat <= n && lng >= w && lng <= e);
}

function mapFields(fields) {
  const names = fields.map((f) => f.name);
  const used = new Set(), map = {};
  for (const [k, rules] of Object.entries(FIELD_RULES)) {
    for (const r of rules) {
      const hit = names.find((n) => r.test(n) && !used.has(n));
      if (hit) { map[k] = hit; used.add(hit); break; }
    }
  }
  map._dates = fields.filter((f) => f.type === "esriFieldTypeDate").map((f) => f.name);
  return map;
}
const THIS_YEAR = new Date().getFullYear();
function scoreLayer(layer, map, url = "") {
  let s = 0;
  const n = layer.name || "";
  if (/past.?year|archive|history|backup|test/i.test(url)) s -= 8;
  if (/pool|restroom|recreation|park|trail|bike|facilit|school|library|hydrant|sign|point of interest|poi\b|church|hospital|fire|police|address.?point/i.test(n)) s -= 12;
  if (/parcel/i.test(n)) s += 4;
  if (/tax|cadastr|real.?estate|ownership|apprais|assess(ed|ment)?\b(?!.*not)/i.test(n)) s += 2;
  if (/current|^tax ?parcels?$|^parcels?$/i.test(n.trim())) s += 2;
  // old snapshots ("Parcels 2019") and special-purpose layers rank last
  const years = (n.match(/\b(19|20)\d\d\b/g) || []).map(Number);
  if (years.some((y) => y < THIS_YEAR - 1)) s -= 8;
  if (/benefit|district|not assessed|land ?bank|exempt|vacant|tif|annex|zoning|plat|subdiv|easement|historic|past|history|anno|label|line|dimension|\blots?\b|condo|common|right.?of.?way|tax ?sale|delinq/i.test(n)) s -= 8;
  if (layer.geometryType === "esriGeometryPolygon") s += 3;
  else if (layer.geometryType && !/parcel/i.test(n)) s -= 4;
  if (map.owner) s += 6;
  if (map.value) s += 4;
  if (map.year) s += 1;
  if (map.situs) s += 1;
  return s;
}

// Walks the county's services directories (every folder) and returns its parcel-like layers, best first.
export async function discover(county, log = () => {}) {
  const candidates = [], inventory = [];
  const svcs = [];
  if (county.hint) svcs.push(county.hint);
  for (const root of [county.root, ...(county.extraRoots || [])]) {
    try {
      const top = await j(root);
      const add = (list) => list.filter((s) => /MapServer|FeatureServer/.test(s.type)).forEach((s) => svcs.push(`${root}/${s.name}/${s.type}`));
      add(top.services || []);
      for (const f of (top.folders || []).slice(0, 40)) {
        try { add((await j(`${root}/${f}`)).services || []); } catch {}
      }
    } catch (e) { log(`Couldn't list ${root}: ${e.message}`); }
  }
  const rank = (u) => (/parcel|cadastr|tax|apprais|assess|property|ugmaps|ownership|real.?estate|land.?records|aims/i.test(u) ? 0 : 1) + (/past.?year|archive|backup|history/i.test(u) ? 1 : 0);
  // FeatureServer and MapServer copies of the same service hold the same layers; keep one
  const seen = new Set();
  const ranked = [...new Set(svcs)].filter((u) => { const k = u.replace(/\/(MapServer|FeatureServer)$/, ""); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => rank(a) - rank(b)).slice(0, 45);
  for (const svc of ranked) {
    try {
      const { layers = [] } = await j(`${svc}/layers`);
      for (const layer of layers) {
        if (!layer.fields?.length) continue;
        const map = mapFields(layer.fields);
        const url = `${svc}/${layer.id}`;
        inventory.push(`${url} | ${layer.name} | ${layer.geometryType || "table"} | owner=${map.owner || "-"} value=${map.value || "-"} year=${map.year || "-"}`);
        if (!(map.owner || map.value || map.year)) continue;
        const score = scoreLayer(layer, map, url);
        candidates.push({ url, name: layer.name, map, score, fields: layer.fields.map((f) => f.name) });
      }
    } catch {}
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? { layers: candidates.slice(0, 8), inventory } : (inventory.length ? { layers: [], inventory } : null);
}

const EMPTY = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
// Queries the best-ranked layers at a point and fills owner / value / year from whichever has them.
export async function lookupCounty(county, found, lat, lng, titleCase, norm) {
  const merged = {}, used = [];
  for (const layer of found.layers.filter((l) => l.score > 0).slice(0, 4)) {
    let attrs = null;
    try { attrs = await queryPoint(layer, lat, lng); } catch { continue; }
    if (!attrs) continue;
    const info = fromCounty(attrs, layer, county, titleCase, norm);
    let added = false;
    for (const [k, v] of Object.entries(info)) if (EMPTY(merged[k]) && !EMPTY(v)) { merged[k] = v; if (!/^prop_|value_type/.test(k)) added = true; }
    if (added) used.push(layer.name);
    if (merged.owner && merged.home_value && merged.year_built) break;
  }
  if (!used.length) return null;
  return { ...merged, prop_source: county.name, prop_layers: used };
}

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,]/g, "")); return isFinite(n) && n > 0 ? n : null; };

export async function queryPoint(layer, lat, lng) {
  const q = `${layer.url}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false`;
  const data = await j(q);
  return data.features?.[0]?.attributes || null;
}

export function fromCounty(attrs, layer, county, titleCase, norm) {
  const m = layer.map, g = (k) => { const v = m[k] ? attrs[m[k]] : null; return v == null || v === "" || v === " " ? null : v; };
  const date = (k) => { const v = g(k); if (v == null) return ""; if (typeof v === "number" && v > 1e10) return new Date(v).toISOString().slice(0, 10); return String(v); };
  const owner = [g("owner"), g("owner2")].filter(Boolean).map((s) => String(s).trim()).join(" & ");
  const mail = g("mail") ? String(g("mail")).trim() : "";
  const situs = g("situs") ? String(g("situs")).trim() : "";
  const hs = g("homestead");
  let occupied = null;
  if (hs != null) occupied = /^(y|yes|true|1|h)$/i.test(String(hs).trim());
  else if (mail && situs) occupied = norm(mail).startsWith(norm(situs)) || norm(situs).startsWith(norm(mail));
  const land = num(g("land")), impr = num(g("impr"));
  const value = num(g("value")) || (land || impr ? (land || 0) + (impr || 0) : null);
  const yr = num(g("year"));
  return {
    owner: titleCase(owner),
    owner_occupied: occupied,
    mailing_address: occupied === false ? [mail, g("mailCity"), g("mailState")].filter(Boolean).join(", ") : "",
    home_value: value,
    value_type: m.value ? `${county.state === "MO" ? "Market" : "Appraised"} value` : value ? "Land + building value" : "",
    year_built: yr && yr > 1800 && yr < 2100 ? Math.round(yr) : null,
    sqft: num(g("sqft")) ? Math.round(num(g("sqft"))) : null,
    last_sale_date: date("saleDate"),
    last_sale_price: num(g("salePrice")),
    parcel_id: g("parcel") ? String(g("parcel")) : "",
    land_use: "",
    prop_source: county.name,
    prop_checked_at: new Date().toISOString(),
  };
}
