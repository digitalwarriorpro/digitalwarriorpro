// Free storm data for a storm date, from the Iowa Environmental Mesonet's copy of NWS feeds:
// hail Local Storm Reports (spotter, police and NWS reports with stone size) and severe
// thunderstorm / tornado warning polygons with the hail size the warning called for.
// Results are kept on the phone so the layer still shows with no signal.
import { CONFIG } from "./config.js";
import { store } from "./store.js";

const IEM = "https://mesonet.agron.iastate.edu/geojson";

// A storm "day" runs from 5am to 5am the next morning Central time, so overnight storms stay together.
function dayWindow(date) {
  const start = new Date(`${date}T10:00:00Z`); start.setUTCHours(start.getUTCHours() - 5);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 16) + "Z";
  return { sts: iso(start), ets: iso(end) };
}

async function getJson(url, ms = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Storm data service answered ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

export function parseReports(gj) {
  return (gj?.features || [])
    .filter((f) => f.geometry?.type === "Point" && (f.properties?.type === "H" || /hail/i.test(f.properties?.typetext || "")))
    .map((f) => {
      const p = f.properties || {}, [lng, lat] = f.geometry.coordinates;
      return { lat, lng, size: num(p.magnitude), at: p.valid || "", place: [p.city, p.st || p.state].filter(Boolean).join(", "), remark: p.remark || "", source: p.source || "" };
    });
}

export function parseWarnings(gj) {
  const out = [];
  for (const f of gj?.features || []) {
    const p = f.properties || {};
    const ph = p.phenomena || (p.ps || "").split(".")[0];
    const sig = p.significance || (p.ps || "").split(".")[1] || "W";
    if (!["SV", "TO"].includes(ph) || sig !== "W") continue;
    const g = f.geometry; if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      out.push({ ring: poly[0].map(([lng, lat]) => [lat, lng]), size: Math.max(num(p.max_hailtag), num(p.hailtag)), kind: ph === "TO" ? "Tornado" : "Severe storm", at: p.issue || p.utc_issue || "" });
    }
  }
  return out;
}

// Storm data for one date: fresh from the feed when online, otherwise (or on failure) the saved copy.
export async function hailFor(date, { force = false } = {}) {
  const key = `storm:${date}`;
  const saved = await store.getMeta(key).catch(() => null);
  const old = Date.now() - new Date(`${date}T12:00:00Z`).getTime() > 3 * 86400000; // settled after a few days
  if (saved && !force && (old || !navigator.onLine)) return saved;
  if (!navigator.onLine) { if (saved) return saved; throw new Error("No signal. Open the storm layer once with signal to save it on this phone."); }
  const { sts, ets } = dayWindow(date), a = CONFIG.stormArea;
  try {
    const [lsr, sbw] = await Promise.all([
      getJson(`${IEM}/lsr.geojson?sts=${sts}&ets=${ets}&west=${a.west}&east=${a.east}&south=${a.south}&north=${a.north}`),
      getJson(`${IEM}/sbw.geojson?sts=${sts}&ets=${ets}&wfos=${CONFIG.stormOffices.join(",")}`),
    ]);
    const data = { date, reports: parseReports(lsr), warnings: parseWarnings(sbw), fetchedAt: new Date().toISOString() };
    await store.setMeta(key, data).catch(() => {});
    return data;
  } catch (e) {
    if (saved) return saved;
    throw new Error(e.name === "AbortError" ? "The storm data service didn't answer. Try again in a minute." : e.message || "Couldn't load storm data.");
  }
}

function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const miles = (a, b) => {
  const R = 3958.8, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// What hit this spot: the biggest hail size of any warning covering it, and the biggest report within 3 miles.
export function hailAt(data, p) {
  if (!data) return null;
  let warned = null;
  for (const w of data.warnings) if (inRing(p.lat, p.lng, w.ring) && (!warned || w.size > warned.size)) warned = w;
  let near = null;
  for (const r of data.reports) {
    const d = miles(p, r);
    if (d <= 3 && (!near || r.size > near.size || (r.size === near.size && d < near.miles))) near = { ...r, miles: d };
  }
  return warned || near ? { warned, near } : null;
}

// Doors worth knocking for this storm: inside a warning, or within 1 mile of a 1"+ report
export function inHailArea(data, p) {
  const h = hailAt(data, p); if (!h) return false;
  return !!h.warned || (h.near && h.near.size >= 1 && h.near.miles <= 1);
}

export const hailColor = (s) => s >= 2.5 ? "#9B51E0" : s >= 1.75 ? "#E5484D" : s >= 1 ? "#F2994A" : "#F2C94C";
export const inches = (s) => s ? `${s % 1 ? s.toFixed(2).replace(/0$/, "") : s}″` : "";
