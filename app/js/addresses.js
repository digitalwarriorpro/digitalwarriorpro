// Turning places into doors: OpenStreetMap address points for the area on screen,
// a reverse lookup for a single dropped pin, and CSV lists (county parcels, Hail Recon exports).
import { CONFIG } from "./config.js";
import { fromCsvRow } from "./property.js";

export async function addressesInView(bounds, limit = 800) {
  const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(node["addr:housenumber"]["addr:street"](${bbox});way["addr:housenumber"]["addr:street"](${bbox}););out center ${limit};`;
  const json = await overpass(q);
  return json.elements
    .map((el) => {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
      if (lat == null || !t["addr:housenumber"]) return null;
      return {
        id: `osm:${el.type}/${el.id}`,
        lat, lng,
        address: `${t["addr:housenumber"]} ${t["addr:street"]}`,
        street: t["addr:street"],
        city: t["addr:city"] || "",
        zip: t["addr:postcode"] || "",
        _unit: t["addr:unit"] || "",
      };
    })
    .filter(Boolean);
}

// The free address servers are often busy (429/504, or a dropped connection that Safari reports as
// "Load failed"), so try each server in turn with a time limit.
async function overpass(q) {
  if (!navigator.onLine) throw new Error("No signal. Load doors when you have signal, or drop doors with +.");
  for (const url of CONFIG.overpassUrls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.elements)) return json;
      }
    } catch {} finally { clearTimeout(timer); }
  }
  throw new Error("The address servers are busy. Wait a minute and tap the house again, or drop doors with +.");
}

export async function reverseLookup(lat, lng) {
  const url = `${CONFIG.nominatimUrl}?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("lookup failed");
  const j = await res.json();
  const a = j.address || {};
  const street = a.road || "";
  return {
    address: [a.house_number, street].filter(Boolean).join(" ") || j.display_name?.split(",").slice(0, 2).join(",") || "",
    street,
    city: a.city || a.town || a.village || a.suburb || "",
    zip: a.postcode || "",
  };
}

// CSV with a header row. Needs address + lat + lng (or latitude/longitude). Optional: city, zip, name, phone, notes,
// and county record columns: owner, mailing address, home value, year built, sqft, sale date, sale price, parcel.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
  const idx = (...names) => head.findIndex((h) => names.includes(h));
  const iA = idx("address", "street address", "site address", "situs address"), iLat = idx("lat", "latitude", "y"), iLng = idx("lng", "lon", "long", "longitude", "x");
  const iCity = idx("city"), iZip = idx("zip", "zipcode", "postal code", "postcode"), iName = idx("name", "owner"), iPhone = idx("phone"), iNotes = idx("notes");
  if (iA < 0 || iLat < 0 || iLng < 0) throw new Error("The CSV needs columns named address, lat and lng.");
  return rows
    .filter((r) => r.length > 1 && r[iA])
    .map((r) => {
      const lat = parseFloat(r[iLat]), lng = parseFloat(r[iLng]);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      const address = r[iA].trim();
      const get = (...names) => { const i = head.findIndex((h) => names.includes(h)); return i >= 0 ? String(r[i] ?? "").trim() : ""; };
      return {
        ...fromCsvRow(get),
        id: "csv:" + address.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ":" + lat.toFixed(5) + "," + lng.toFixed(5),
        lat, lng, address,
        street: address.replace(/^\d+[a-z]?\s+/i, ""),
        city: iCity >= 0 ? r[iCity] : "", zip: iZip >= 0 ? r[iZip] : "",
        name: iName >= 0 ? r[iName] : "", phone: iPhone >= 0 ? r[iPhone] : "", notes: iNotes >= 0 ? r[iNotes] : "",
      };
    })
    .filter(Boolean);
}

export function toCsv(rows, cols) {
  const cell = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}
