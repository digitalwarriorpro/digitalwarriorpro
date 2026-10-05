// VIN lookups from NHTSA's free public databases (no key needed):
// vPIC decodes a VIN into year / make / model / trim; the Recalls API lists recalls on file
// for that year, make and model.

const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export const cleanVin = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// "ok" | "length" | "letters" | "check". The check digit applies to North American VINs; imports
// can fail it legitimately, so callers treat "check" as a warning, not a block.
export function vinStatus(vin) {
  if (vin.length !== 17) return "length";
  if (/[IOQ]/.test(vin)) return "letters";
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? +c : TRANSLIT[c] || 0) * WEIGHTS[i];
  }
  const check = sum % 11 === 10 ? "X" : String(sum % 11);
  return vin[8] === check ? "ok" : "check";
}

const titleMake = (s) => String(s || "").toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase()).replace(/\b(Bmw|Gmc|Ram|Mini|Kia|Vw)\b/g, (m) => (m === "Ram" || m === "Mini" || m === "Kia" ? m : m.toUpperCase()));

export async function decodeVin(vin) {
  const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
  if (!res.ok) throw new Error(`VIN lookup failed (${res.status}).`);
  const r = (await res.json()).Results?.[0] || {};
  if (!r.Make || !r.ModelYear) throw new Error("NHTSA didn't recognize that VIN. Check the characters.");
  const make = titleMake(r.Make);
  return {
    year: r.ModelYear, make, model: r.Model || "", trim: r.Trim || r.Series || "",
    body: r.BodyClass || "",
    ymm: [r.ModelYear, make, r.Model, r.Trim].filter(Boolean).join(" "),
  };
}

export async function recallsFor(year, make, model) {
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Recall lookup failed (${res.status}).`);
  const j = await res.json();
  return (j.results || []).map((x) => ({ id: x.NHTSACampaignNumber, component: x.Component, summary: x.Summary }));
}
