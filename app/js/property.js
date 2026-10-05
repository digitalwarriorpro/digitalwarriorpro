// Homeowner and home value lookups from public property records.
// 1. Free: Johnson County KS, Wyandotte County KS and Jackson County MO parcel maps (county.js).
// 2. Optional fallback for anywhere else: Regrid (paid nationwide parcel API).
// A lookup runs once per door; the result is saved on the door and shared with the team.
import { CONFIG } from "./config.js";
import { countyFor, discover, queryPoint, fromCounty } from "./county.js";

const pick = (o, ...keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== "") return v; } return null; };
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,]/g, "")); return isFinite(n) && n > 0 ? n : null; };
export const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\b(STREET|ST|TERRACE|TER|TERR|AVENUE|AVE|DRIVE|DR|ROAD|RD|LANE|LN|COURT|CT|PLACE|PL|CIRCLE|CIR|PARKWAY|PKWY|BOULEVARD|BLVD|WEST|W|EAST|E|NORTH|N|SOUTH|S)\b/g, "").replace(/\s+/g, " ").trim();

export function propertyEnabled(settings) { return CONFIG.countyRecords !== false || !!settings?.regridToken; }

// settings: { regridToken, countyLayers: { [countyKey]: {url, name, map} }, onDiscover(key, layer) }
// Returns the fields to save on the door, or null when no source covers this spot.
export async function lookupProperty(lat, lng, settings) {
  if (CONFIG.countyRecords !== false) {
    for (const county of countyFor(lat, lng)) {
      let layer = settings.countyLayers?.[county.key];
      if (!layer) {
        layer = await discover(county);
        if (!layer) continue;
        settings.countyLayers = { ...(settings.countyLayers || {}), [county.key]: layer };
        settings.onDiscover?.(county.key, layer);
      }
      const attrs = await queryPoint(layer, lat, lng);
      if (attrs) return fromCounty(attrs, layer, county, titleCase, norm);
    }
  }
  if (settings.regridToken) return lookupRegrid(lat, lng, settings);
  return countyFor(lat, lng).length ? { prop_source: "County records", prop_checked_at: new Date().toISOString() } : null;
}

async function lookupRegrid(lat, lng, settings) {
  const url = `https://app.regrid.com/api/v2/parcels/point?lat=${lat}&lon=${lng}&limit=1&token=${encodeURIComponent(settings.regridToken)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 401 || res.status === 403) throw new Error("The Regrid key was refused. Check it in Settings.");
  if (res.status === 429) throw new Error("Regrid lookups are over the plan's limit for now.");
  if (!res.ok) throw new Error(`Property lookup failed (${res.status}).`);
  const json = await res.json();
  const feats = json?.parcels?.features || json?.features || [];
  const f = feats[0]?.properties;
  if (!f) return { prop_source: "Regrid", prop_checked_at: new Date().toISOString() };
  return fromRegrid(f.fields || f);
}

export function fromRegrid(p) {
  const situs = pick(p, "address", "saddress");
  const mail = pick(p, "mailadd", "mail_address");
  const mailCity = [pick(p, "mail_city"), pick(p, "mail_state2", "mail_state")].filter(Boolean).join(", ");
  const owner = [pick(p, "owner"), pick(p, "owner2")].filter(Boolean).join(" & ");
  const homestead = pick(p, "homestead_exemption", "homestead");
  let occupied = null;
  if (homestead != null) occupied = /^(y|yes|true|1)$/i.test(String(homestead));
  else if (mail && situs) occupied = norm(mail) === norm(situs);
  const land = num(pick(p, "landval")), impr = num(pick(p, "improvval"));
  return {
    owner: titleCase(owner),
    owner_occupied: occupied,
    mailing_address: occupied === false ? [mail, mailCity].filter(Boolean).join(", ") : "",
    home_value: num(pick(p, "parval")) || (land || impr ? (land || 0) + (impr || 0) : null),
    value_type: pick(p, "parvaltype") || "County value",
    year_built: num(pick(p, "yearbuilt")) ? Math.round(num(pick(p, "yearbuilt"))) : null,
    sqft: num(pick(p, "area_building", "sqft_building", "bldg_sqft")) ? Math.round(num(pick(p, "area_building", "sqft_building", "bldg_sqft"))) : null,
    last_sale_date: pick(p, "saledate") || "",
    last_sale_price: num(pick(p, "saleprice")),
    parcel_id: pick(p, "parcelnumb", "parcel_id", "ll_uuid") || "",
    land_use: pick(p, "usedesc", "zoning_description") || "",
    prop_source: "Regrid",
    prop_checked_at: new Date().toISOString(),
  };
}

// Columns accepted from county parcel exports (CSV import), mapped onto the same fields.
export function fromCsvRow(get) {
  const owner = get("owner", "owner name", "owner_name", "ownername", "owner1");
  const mail = get("mailing address", "mail address", "mailadd", "owner address", "mailing_address");
  const situs = get("address", "site address", "situs address");
  const occ = get("owner occupied", "owner_occupied", "homestead");
  const value = num(get("home value", "home_value", "market value", "appraised value", "total value", "parval", "value"));
  const out = {
    owner: owner ? titleCase(owner) : "",
    owner_occupied: occ ? /^(y|yes|true|1)$/i.test(occ) : mail && situs ? norm(mail).startsWith(norm(situs)) : null,
    mailing_address: mail || "",
    home_value: value,
    value_type: value ? "County value" : "",
    year_built: num(get("year built", "year_built", "yearbuilt")),
    sqft: num(get("sqft", "square feet", "living area", "building sqft", "area_building")),
    last_sale_date: get("sale date", "last sale date", "saledate") || "",
    last_sale_price: num(get("sale price", "last sale price", "saleprice")),
    parcel_id: get("parcel", "parcel id", "parcel_id", "apn", "pin", "kup") || "",
  };
  if (out.owner_occupied) out.mailing_address = "";
  const any = out.owner || out.home_value || out.year_built;
  return any ? { ...out, prop_source: "CSV", prop_checked_at: new Date().toISOString() } : {};
}

export function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Llc|Lp|Inc|Ii|Iii|Iv|Tr|Trust)\b/g, (m) => m.toUpperCase()).replace(/\bMc([a-z])/g, (m, c) => "Mc" + c.toUpperCase());
}

export const money = (n) => (n == null ? "" : n >= 1e6 ? `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, "")}M` : `$${Math.round(n / 1000)}K`);
