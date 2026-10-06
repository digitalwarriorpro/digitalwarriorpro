// Roof size estimate from the building outline on the map (OpenStreetMap), free and instant.
// Roof area = (footprint + 1 ft overhang around the edge) × pitch factor; a square is 100 sq ft.
// Typically within about 15% of a measured report; good for quoting ranges, not for ordering material.
import { overpass } from "./addresses.js";

const SQFT_PER_M2 = 10.7639;
export const PITCHES = [4, 6, 8, 10, 12];
export const pitchFactor = (rise) => Math.sqrt(1 + (rise / 12) ** 2);

// Re-figure for another pitch without going back to the map
export function atPitch(baseSqft, pitch, waste = 0.1) {
  const roof = baseSqft * pitchFactor(pitch);
  return { roof_sqft: Math.round(roof), squares: Math.round(roof / 10) / 10, squares_with_waste: Math.round((roof * (1 + waste)) / 10) / 10 };
}

// Local flat projection around the house: metres east/north of the first corner
function project(pts) {
  const lat0 = pts[0].lat * Math.PI / 180, R = 6371008.8;
  return pts.map((p) => [(p.lon - pts[0].lon) * Math.PI / 180 * R * Math.cos(lat0), (p.lat - pts[0].lat) * Math.PI / 180 * R]);
}
function areaAndPerimeter(pts) {
  const xy = project(pts);
  let a = 0, per = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    a += xy[j][0] * xy[i][1] - xy[i][0] * xy[j][1];
    per += Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
  }
  return { m2: Math.abs(a) / 2, m: per };
}
function contains(pts, lat, lng) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.lat > lat) !== (b.lat > lat) && lng < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
const centroid = (pts) => ({ lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lon, 0) / pts.length });
const metres = (a, b) => Math.hypot((a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180), (a.lat - b.lat) * 110540);

// The house at this spot: the outline that contains the door pin, else the nearest house-sized outline within 40 m
export function pickBuilding(elements, lat, lng) {
  const ways = (elements || []).filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 4)
    .map((e) => ({ id: e.id, tags: e.tags || {}, pts: e.geometry.slice(0, -1) }))
    .filter((w) => !/^(garage|garages|shed|carport|roof)$/.test(w.tags.building || ""));
  const hit = ways.find((w) => contains(w.pts, lat, lng));
  if (hit) return hit;
  return ways.map((w) => ({ ...w, d: metres({ lat, lng }, centroid(w.pts)) }))
    .filter((w) => w.d <= 40 && areaAndPerimeter(w.pts).m2 >= 50)
    .sort((a, b) => a.d - b.d)[0] || null;
}

export function estimate(building, { pitch = 6, waste = 0.1 } = {}) {
  const { m2, m } = areaAndPerimeter(building.pts);
  const footprint = m2 * SQFT_PER_M2;
  const withOverhang = footprint + m * 3.28084 * 1; // 1 ft overhang along the perimeter
  const roof = withOverhang * pitchFactor(pitch);
  return {
    footprint_sqft: Math.round(footprint),
    base_sqft: Math.round(withOverhang),
    roof_sqft: Math.round(roof),
    squares: Math.round(roof / 10) / 10,
    squares_with_waste: Math.round((roof * (1 + waste)) / 10) / 10,
    pitch, waste,
    levels: Number(building.tags["building:levels"]) || null,
    outline: building.pts.map((p) => [p.lat, p.lon]),
  };
}

export async function roofAt(lat, lng, opts) {
  const json = await overpass(`[out:json][timeout:15];way(around:45,${lat},${lng})["building"];out geom 20;`);
  const b = pickBuilding(json.elements, lat, lng);
  if (!b) return null;
  return { building_id: `osm:way/${b.id}`, ...estimate(b, opts) };
}
