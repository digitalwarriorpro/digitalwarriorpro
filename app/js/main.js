import { CONFIG } from "./config.js";
import { store } from "./store.js";
import { sync, connection, saveConnection } from "./sync.js";
import { addressesInView, reverseLookup, parseCsv, toCsv } from "./addresses.js";
import { lookupProperty, propertyEnabled, money, titleCase, norm } from "./property.js";
import { COUNTIES, discover, queryPoint, lookupCounty } from "./county.js";
import { cleanVin, vinStatus, decodeVin, recallsFor } from "./vehicles.js";

/* ================= constants ================= */
const S = {
  none:    { l: "Not knocked",        c: "--s-none" },
  nothome: { l: "Not home",           c: "--s-nothome" },
  no:      { l: "Not interested",     c: "--s-no" },
  back:    { l: "Come back",          c: "--s-back" },
  lead:    { l: "Lead · wants quote", c: "--s-lead" },
  booked:  { l: "Inspection booked",  c: "--s-booked" },
  dnk:     { l: "Do not knock",       c: "--s-dnk" },
};
const OUTCOMES = ["booked", "lead", "back", "no"];
const CAR_TYPES = ["Truck", "SUV", "Car", "Van"];
const PANELS = ["Hood", "Roof", "Trunk", "L doors", "R doors", "L fender", "R fender", "Glass"];
const NO_REASONS = ["No damage", "Already repaired", "Using another shop", "Doesn't want a claim", "Renter / not the owner", "Other"];
const BACK_WHEN = ["Later today", "Tonight", "Tomorrow AM", "Tomorrow PM", "This weekend"];
const INSURERS = ["", "State Farm", "Progressive", "Allstate", "GEICO", "American Family", "Farmers", "Shelter", "USAA", "Liberty Mutual", "Travelers", "Other", "Doesn't know"];
const OBJ = [
  ["Will my rates go up?", "Hail usually goes through comprehensive coverage, which typically isn't treated like an at-fault accident. Your agent can confirm how your policy handles it."],
  ["I don't see any damage", "Hail dents are hard to spot in daylight. We check under a light board, it takes about 15 minutes, and there's no cost to look."],
  ["I'll use my own body shop", "You can choose any shop. Paintless repair keeps the factory paint, and we work with your insurer directly."],
  ["What about my deductible?", "We'll walk you through your coverage. Repairs may be covered after your deductible. We don't waive deductibles."],
  ["Now's not a good time", "No problem. When's a better time to swing back? The inspection only takes 15 minutes."],
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "x" + Date.now().toString(36) + Math.random().toString(36).slice(2));
const nowIso = () => new Date().toISOString();
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const colorOf = (k) => cssVar(S[k]?.c || "--s-none");
const timeShort = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const isToday = (iso) => { const d = new Date(iso), n = new Date(); return d.toDateString() === n.toDateString(); };
const digits = (p) => String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";

/* ================= state ================= */
const doors = new Map();
let visits = [];
let rep = { id: "", name: "" };
let me = null;
let follow = true;
let sel = null, sheet = null, draft = null, step = 0, openObj = -1, slotPage = 0;
let tab = "map", mode = "map", filter = "all", leadScope = "mine", leadFilter = "all";
let adding = false, importList = null, importTurf = "", importRep = "";
let undo = null, lastSaved = null;
let reps = [];
const vinBusy = new Set();
const photoUrls = new Map();
let outboxN = 0;
let propSettings = { regridToken: "", countyLayers: {}, onDiscover: (key, layer) => saveCountyLayers() };
function saveCountyLayers() {
  const v = JSON.stringify(propSettings.countyLayers || {});
  try { localStorage.setItem("knock.countyLayers4", v); } catch {}
  if (sync.enabled && sync.user) sync.setTeamSetting("county_layers_v4", v).catch(() => {});
}
const lookingUp = new Set();
const PROP_FIELDS = ["owner", "owner_occupied", "mailing_address", "home_value", "value_type", "year_built", "sqft", "last_sale_date", "last_sale_price", "parcel_id", "land_use", "prop_source", "prop_checked_at"];

/* ================= slots ================= */
function slotList() {
  const out = [], { daysAhead, openDays, times } = CONFIG.inspection;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 0; out.length < daysAhead && i < 21; i++) {
    const day = new Date(d.getTime() + i * 864e5);
    if (!openDays.includes(day.getDay())) continue;
    const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    out.push({ ymd, label: day.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }), times: times.map((t) => {
      const at = new Date(`${ymd}T${t}:00`);
      return { key: `${ymd}T${t}`, t: at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), past: at.getTime() < Date.now() + 45 * 60e3 };
    }) });
  }
  return out;
}
const slotLabel = (key) => { if (!key) return ""; const d = new Date(key + ":00"); return d.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
const takenSlots = (exceptId) => new Set([...doors.values()].filter((d) => d.status === "booked" && d.slot && d.id !== exceptId).map((d) => d.slot));

/* ================= door helpers ================= */
function newDoor(base) {
  return {
    id: base.id || "pin:" + uuid(), lat: base.lat, lng: base.lng,
    address: base.address || "", street: base.street || "", city: base.city || "", zip: base.zip || "",
    turf: base.turf || "", assigned_to: base.assigned_to || "",
    status: "none", attempts: 0, hanger: false, back_when: "", reason: "", vehicles: [],
    name: base.name || "", phone: base.phone || "", email: "", contact_pref: "Text", consent: false,
    slot: null, notes: base.notes || "", storm: CONFIG.storms[0] || "", photos: [], driveway: null,
    ...Object.fromEntries(PROP_FIELDS.map((k) => [k, base[k] ?? (["owner_occupied", "home_value", "year_built", "sqft", "last_sale_price", "prop_checked_at"].includes(k) ? null : "")])),
    created_at: nowIso(), updated_at: nowIso(), updated_by: rep.id || null, updated_by_name: rep.name,
  };
}
const isMine = (d) => !d.assigned_to || d.assigned_to === rep.name;
const matches = (d, f = filter) => f === "all" ? true : f === "mine" ? isMine(d) : f === "todo" ? d.status === "none" : f === "revisit" ? (d.status === "back" || d.status === "nothome") : f === "leads" ? (d.status === "lead" || d.status === "booked") : f === "owners" ? d.owner_occupied === true : f === "value" ? (d.home_value || 0) >= CONFIG.valueFilter : f === "cars" ? (d.driveway?.count || 0) > 0 : true;
function dist(a, b) {
  const R = 6371e3, t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtDist = (m) => { const ft = m * 3.281; return ft < 1000 ? `${Math.round(ft / 10) * 10} ft` : `${(ft / 5280).toFixed(1)} mi`; };
const origin = () => me || (map ? { lat: map.getCenter().lat, lng: map.getCenter().lng } : CONFIG.startView);
function nextDoor(excludeId) {
  const o = origin();
  const pool = [...doors.values()].filter((d) => d.id !== excludeId && isMine(d));
  const pick = (st) => pool.filter((d) => d.status === st).sort((a, b) => dist(o, a) - dist(o, b))[0];
  const n = pick("none") || pick("back");
  return n && dist(o, n) < 3000 ? n : null;
}

async function saveDoor(d, visit) {
  d.updated_at = nowIso(); d.updated_by = rep.id || null; d.updated_by_name = rep.name;
  doors.set(d.id, d);
  await store.putDoors([d]);
  await store.enqueue({ type: "door", door: d });
  if (visit) {
    visits.push(visit);
    await store.putVisits([visit]);
    await store.enqueue({ type: "visit", visit });
  }
  paintDoor(d);
  kick();
}
function makeVisit(d, outcome, details = {}) {
  return { id: uuid(), door_id: d.id, rep_id: rep.id || null, rep_name: rep.name, outcome, at: nowIso(), details: { address: d.address, ...details } };
}
async function kick() { outboxN = await store.outboxCount(); renderNet(); sync.push(); }

/* ================= map ================= */
let map, layer, meMarker, meAcc, watchId = null;
const markers = new Map();
function initMap() {
  map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([CONFIG.startView.lat, CONFIG.startView.lng], CONFIG.startView.zoom);
  L.tileLayer(CONFIG.tiles.url, { maxZoom: CONFIG.tiles.maxZoom, attribution: CONFIG.tiles.attribution, crossOrigin: "" }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on("dragstart", () => { if (follow) { follow = false; renderCtrls(); } });
  map.on("zoomend", () => markers.forEach((m, id) => paintDoor(doors.get(id))));
  map.on("moveend", () => { if (mode === "list") renderWalk(); renderNext(); });
  map.on("click", () => { if (sheet === "peek" || sheet === "import") closeSheet(); });
}
const radius = () => { const z = map.getZoom(); return z >= 18 ? 11 : z >= 17 ? 9 : z >= 16 ? 7 : z >= 14 ? 5 : 3.5; };
function paintDoor(d) {
  if (!d || !map) return;
  let m = markers.get(d.id);
  const on = matches(d), isSel = sel && sel.id === d.id;
  const hollow = d.status === "none"; // unknocked doors are rings, so they stand out from logged ones
  const style = {
    radius: isSel ? radius() + 4 : radius(), fillColor: hollow ? cssVar("--surface") : colorOf(d.status), fillOpacity: on ? 0.95 : 0.18,
    color: isSel ? cssVar("--ink") : hollow ? colorOf("none") : "#fff", weight: isSel ? 3 : hollow ? 2.5 : 1.5, opacity: on ? 1 : 0.25,
  };
  if (!m) {
    m = L.circleMarker([d.lat, d.lng], style).addTo(layer);
    m.on("click", (e) => { L.DomEvent.stopPropagation(e); if (!adding) openPeek(d.id); });
    markers.set(d.id, m);
  } else { m.setStyle(style); m.setRadius(style.radius); }
  if (isSel) m.bringToFront();
}
const paintAll = () => doors.forEach(paintDoor);

function startGps() {
  if (!("geolocation" in navigator)) { toast("This phone can't share its location with the app."); return; }
  let warned = false;
  watchId = navigator.geolocation.watchPosition((p) => {
    me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    if (!meMarker) {
      meMarker = L.marker([me.lat, me.lng], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meAcc = L.circle([me.lat, me.lng], { radius: me.acc, color: "#2457C5", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
      if (follow) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17));
    } else { meMarker.setLatLng([me.lat, me.lng]); meAcc.setLatLng([me.lat, me.lng]).setRadius(me.acc); }
    if (follow && !sheet) map.panTo([me.lat, me.lng], { animate: true });
    renderNext();
  }, (err) => {
    if (warned) return; warned = true;
    toast(err.code === 1 ? "Location is off. Allow location for this site in your phone's settings to see where you are." : "Can't get a GPS fix yet. Step outside or wait a moment.");
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

/* ================= header / overlay ================= */
function myToday() {
  const mine = visits.filter((v) => isToday(v.at) && (v.rep_id ? v.rep_id === rep.id : v.rep_name === rep.name));
  const doorsK = new Set(mine.map((v) => v.door_id)).size;
  const booked = mine.filter((v) => v.outcome === "booked").length;
  const first = mine.map((v) => v.at).sort()[0];
  return { mine, doorsK, booked, first };
}
function renderShift() {
  const t = myToday(), g = CONFIG.goals;
  const mins = t.first ? Math.round((Date.now() - new Date(t.first)) / 60000) : 0;
  $("#shift").innerHTML = `${t.first ? `<span>On doors <b class="num">${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}</b></span>` : `<span>No doors yet today</span>`}<span><b class="num">${t.doorsK}</b>/${g.doors} doors</span><span><b class="num">${t.booked}</b>/${g.booked} booked</span><div class="goal" aria-hidden="true"><span style="width:${Math.min(100, (t.doorsK / g.doors) * 100)}%"></span></div>`;
  $("#rep-name").textContent = rep.name || "Set up";
  $("#rep-av").textContent = (rep.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}
function renderNet() {
  const nb = $("#netbar");
  if (!navigator.onLine) { nb.hidden = false; nb.textContent = outboxN ? `Offline · ${outboxN} change${outboxN > 1 ? "s" : ""} saved on this phone, will send when you have signal` : "Offline · keep knocking, everything saves on this phone"; }
  else if (outboxN && sync.enabled && sync.user) { nb.hidden = false; nb.textContent = `Sending ${outboxN} change${outboxN > 1 ? "s" : ""}…`; }
  else nb.hidden = true;
}
// Owner and value filters only show when lookups are on or doors already carry owner data (e.g. a CSV import)
const ownerData = () => propertyEnabled(propSettings) || [...doors.values()].some((d) => d.owner || d.home_value);
function renderFilters() {
  const all = [...doors.values()];
  const n = (f) => all.filter((d) => matches(d, f)).length;
  $("#filters").innerHTML = [["all", "All"], ["mine", "My turf"], ["todo", "To knock"], ["revisit", "Revisit"], ["leads", "Leads"], ["cars", "Cars outside"], ...(ownerData() ? [["owners", "Owner lives here"], ["value", `${money(CONFIG.valueFilter)}+ homes`]] : [])]
    .map(([k, l]) => `<button class="chip" data-f="${k}" aria-pressed="${filter === k}">${l} <span class="n">${n(k)}</span></button>`).join("");
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  $("#walk").hidden = mode !== "list";
}
function renderCtrls() {
  $("[data-c=me]").setAttribute("aria-pressed", follow && !!me);
  $("[data-c=add]").setAttribute("aria-pressed", adding);
  $("#crosshair").hidden = !adding;
  $("#ctrls").hidden = mode !== "map";
}
function renderNext() {
  const bar = $("#nextbar");
  bar.hidden = !!sheet;
  if (sheet) return;
  if (adding) {
    bar.innerHTML = `<button class="nextbtn" id="drop-pin"><span><small>Move the map under the circle</small><strong>Add door here</strong></span></button><button class="sidebtn" id="cancel-pin">Cancel</button>`;
    return;
  }
  if (!doors.size) {
    bar.innerHTML = `<button class="nextbtn" id="go-load"><span><small>No doors yet</small><strong>Zoom to a street, then load doors</strong></span></button>`;
    return;
  }
  const nx = nextDoor(sel?.id);
  bar.innerHTML = nx
    ? `<button class="nextbtn" id="go-next"><span><small>Next door${nx.status === "back" ? " · revisit" : ""} · ${fmtDist(dist(origin(), nx))}</small><strong>${esc(nx.address)}</strong></span><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 10h12M11 5l5 5-5 5"/></svg></button>`
    : `<button class="nextbtn plain" id="go-load"><span><small>Nothing left to knock nearby</small><strong>Load more doors on screen</strong></span></button>`;
}
function renderWalk() {
  if (mode !== "list") return;
  const o = origin();
  const list = [...doors.values()].filter((d) => matches(d)).map((d) => ({ d, m: dist(o, d) })).sort((a, b) => a.m - b.m).slice(0, 80);
  $("#walk").innerHTML = (list.length ? list.map(({ d, m }) => `
    <div class="wrow"><div style="min-width:0"><button class="waddr" data-open="${esc(d.id)}">${esc(d.address)}</button>
      <div class="wsub"><span class="pill"><i style="background:${colorOf(d.status)}"></i>${S[d.status].l}${d.status === "nothome" ? ` ×${d.attempts}` : ""}</span><span>· ${fmtDist(m)}</span>${d.driveway?.count ? `<span>· ${carsLabel(d.driveway)}</span>` : ""}${d.home_value ? `<span>· ${money(d.home_value)}</span>` : ""}${d.owner ? `<span>· ${esc(d.owner)}</span>` : ""}${d.back_when && d.status === "back" ? `<span>· ${esc(d.back_when)}</span>` : ""}${d.slot && d.status === "booked" ? `<span>· ${esc(slotLabel(d.slot))}</span>` : ""}</div></div>
      ${["none", "nothome", "back"].includes(d.status) ? `<button class="qbtn" data-nh="${esc(d.id)}">Not home</button>` : `<button class="qbtn" data-open="${esc(d.id)}">Open</button>`}
    </div>`).join("") : `<div class="empty">No doors match. Switch to the map, zoom to a street and tap the house button to load doors.</div>`)
    + `<p class="note">Sorted by distance from ${me ? "you" : "the map center"}.</p>`;
}

/* ================= sheet ================= */
function openPeek(id) {
  const old = sel;
  sel = doors.get(id); if (!sel) return;
  if (old && old.id !== sel.id) paintDoor(doors.get(old.id));
  paintDoor(sel);
  sheet = "peek"; openObj = -1; draft = null;
  if (tab !== "map") setTab("map");
  follow = false;
  if (!sel.prop_checked_at && propertyEnabled(propSettings)) lookupDoor(sel, true).catch(() => {});
  const pt = map.project([sel.lat, sel.lng], Math.max(map.getZoom(), 17));
  map.setView(map.unproject(pt.add([0, map.getSize().y * 0.25]), Math.max(map.getZoom(), 17)), Math.max(map.getZoom(), 17));
  renderAll();
}
function closeSheet() { const old = sel; sheet = null; draft = null; sel = null; importList = null; if (old) paintDoor(old); renderAll(); }
function startFlow() {
  draft = clone(sel);
  if (!draft.vehicles?.length) {
    const n = Math.max(1, Math.min(draft.driveway?.count || 1, 4)), types = draft.driveway?.types || [];
    draft.vehicles = Array.from({ length: n }, (_, i) => ({ ymm: "", vin: "", panels: [], sev: "", insurer: "", claim: "", seen: types[i] || "" }));
  }
  if (!OUTCOMES.includes(draft.status)) draft.status = "";
  sheet = "flow"; step = 0; slotPage = 0; renderSheet();
}
const flowSteps = () => ["Pitch", "Vehicles", "Outcome", ...(draft && (draft.status === "lead" || draft.status === "booked") ? ["Contact"] : [])];

function head(d, editable) {
  return `<div class="sheet-head"><div style="min-width:0">
      ${editable && sheet === "edit-addr" ? `<input type="text" id="addr-in" value="${esc(d.address)}" aria-label="Address">` : `<div class="addr">${esc(d.address || "Unnamed door")}</div>`}
      <div class="addr-sub">${esc([d.city, d.zip].filter(Boolean).join(", ") || "Kansas City metro")} · <span class="pill" style="font-size:12px"><i style="background:${colorOf(d.status)}"></i>${S[d.status].l}</span>${editable && sheet !== "edit-addr" ? ` · <button class="btn link" style="padding:0;font-size:12px" data-a="edit-addr">Edit address</button>` : ""}</div></div>
    <button class="x" data-a="close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="2" fill="none"><path d="M2 2l10 10M12 2 2 12"/></svg></button></div>`;
}
function facts(d) {
  return `<div class="facts">
    <span class="fact hot">Storm ${esc(stormLabel(d.storm))}</span>
    <span class="fact">${d.attempts ? `${d.attempts} visit${d.attempts > 1 ? "s" : ""}` : "First visit"}</span>
    ${d.hanger ? `<span class="fact">Door hanger left</span>` : ""}
    ${d.assigned_to ? `<span class="fact">${esc(d.turf ? d.turf + " · " : "")}${esc(d.assigned_to)}</span>` : ""}
    ${me ? `<span class="fact">${fmtDist(dist(me, d))} away</span>` : ""}
  </div>`;
}
function homeInfo(d) {
  if (lookingUp.has(d.id)) return `<div class="home"><div class="label">Homeowner</div><p class="note">Looking up county records…</p></div>`;
  if (!d.prop_checked_at) {
    return propertyEnabled(propSettings)
      ? `<div class="home"><div class="label">Homeowner</div><button class="btn" data-a="lookup">Look up owner and home value</button><p class="note">Free for Johnson, Wyandotte and Jackson counties.</p></div>`
      : "";
  }
  if (!d.owner && !d.home_value && !d.year_built) return `<div class="home"><div class="label">Homeowner</div><p class="note">No county record found for this spot.${propertyEnabled(propSettings) ? ` <button class="btn link" style="padding:0" data-a="lookup">Try again</button>` : ""}</p></div>`;
  const stats = [
    d.home_value ? `<div><b>${money(d.home_value)}</b><span>${esc(d.value_type || "Value")}</span></div>` : "",
    d.year_built ? `<div><b>${d.year_built}</b><span>Built</span></div>` : "",
    d.sqft ? `<div><b>${Number(d.sqft).toLocaleString()}</b><span>Sq ft</span></div>` : "",
    d.beds ? `<div><b>${d.beds}</b><span>Bedrooms</span></div>` : "",
    d.last_sale_price || d.last_sale_date ? `<div><b>${d.last_sale_price ? money(d.last_sale_price) : "—"}</b><span>Sold ${esc(fmtSale(d.last_sale_date))}</span></div>` : "",
  ].filter(Boolean).join("");
  const occ = d.owner_occupied === true ? `<span class="fact hot">Owner lives here</span>` : d.owner_occupied === false ? `<span class="fact">Owner lives elsewhere · likely a rental</span>` : "";
  return `<div class="home">
    <div class="label">Homeowner</div>
    <div class="owner">${esc(d.owner || (d.owner_hidden ? "Name withheld by the county" : "Owner not listed"))}</div>
    ${d.land_use ? `<p class="note">${esc(d.land_use)}</p>` : ""}
    ${occ ? `<div class="facts">${occ}</div>` : ""}
    ${d.owner_occupied === false && d.mailing_address ? `<p class="note">Owner mail goes to ${esc(d.mailing_address)}</p>` : ""}
    ${stats ? `<div class="stats">${stats}</div>` : ""}
    <p class="note">${esc(/County,/.test(d.prop_source) ? `${d.prop_source} records` : `County records via ${d.prop_source || "import"}`)}${d.prop_checked_at ? `, checked ${esc(new Date(d.prop_checked_at).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" }))}` : ""}. Whoever answers may not be the owner.</p>
  </div>`;
}
const fmtSale = (s) => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString("en-US", { month: "numeric", year: "numeric" }); };
async function lookupDoor(d, quiet) {
  if (!propertyEnabled(propSettings) || lookingUp.has(d.id) || !navigator.onLine) return false;
  lookingUp.add(d.id);
  if (sel?.id === d.id && sheet === "peek") renderSheet();
  try {
    const info = await lookupProperty(d.lat, d.lng, propSettings);
    if (!info) { if (!quiet) toast("No free county records here. Add a Regrid key in Settings to cover other counties."); return false; }
    const cur = doors.get(d.id) || d;
    Object.assign(cur, info);
    await saveDoor(cur);
    return true;
  } catch (err) {
    if (!quiet) toast(err.message);
    throw err;
  } finally {
    lookingUp.delete(d.id);
    if (sel?.id === d.id && sheet === "peek") { sel = doors.get(d.id); renderSheet(); }
  }
}
async function lookupOnScreen() {
  const b = map.getBounds();
  const todo = [...doors.values()].filter((d) => !d.prop_checked_at && b.contains([d.lat, d.lng])).slice(0, 250);
  if (!todo.length) return toast("Every door on screen already has owner info.");
  let ok = 0;
  for (const d of todo) {
    toast(`Looking up owners… ${ok + 1} of ${todo.length}`);
    try { await lookupDoor(d, true); ok++; } catch (err) { toast(err.message); break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  renderAll();
  toast(`Owner info added to ${ok} door${ok === 1 ? "" : "s"}`);
}

const carsLabel = (dw) => `${dw.count >= 3 ? "3+" : dw.count} car${dw.count === 1 ? "" : "s"} outside${dw.types?.length ? ` (${dw.types.join(", ")})` : ""}`;
function driveway(d) {
  const dw = d.driveway || {};
  return `<div class="drive">
    <div class="label">Cars outside${dw.at ? ` <span class="note" style="text-transform:none;letter-spacing:0">· ${esc(dw.by || "")} ${esc(isToday(dw.at) ? timeShort(dw.at) : new Date(dw.at).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }))}</span>` : ""}</div>
    <div class="toggles" role="group" aria-label="Number of cars outside">${[0, 1, 2, 3].map((n) => `<button class="tog" data-dn="${n}" aria-pressed="${dw.at ? (dw.count || 0) === n : false}">${n === 3 ? "3+" : n}</button>`).join("")}
      ${dw.count ? CAR_TYPES.map((t) => `<button class="tog" data-dt="${t}" aria-pressed="${(dw.types || []).includes(t)}">${t}</button>`).join("") : ""}</div>
  </div>`;
}
function recallBox(v) {
  if (!v.recalls) return "";
  if (!v.recalls.length) return `<p class="note">No recalls on file for ${esc(v.ymm)} models.</p>`;
  return `<details class="recalls"><summary><strong>${v.recalls.length} recall${v.recalls.length === 1 ? "" : "s"}</strong> on file for ${esc(v.ymm.split(" ").slice(0, 3).join(" "))} models</summary>
    <ul>${v.recalls.slice(0, 8).map((r) => `<li>${esc(r.component)} <span class="note">· ${esc(r.id)}</span></li>`).join("")}</ul>
    <p class="note">These cover the model year, not this exact car. The owner can check their VIN at nhtsa.gov/recalls.</p></details>`;
}
async function lookupVin(vi) {
  const v = draft.vehicles[vi];
  const vin = cleanVin(v.vin);
  v.vin = vin;
  const st = vinStatus(vin);
  if (st === "length") { v.vin_note = `A VIN has 17 characters. This one has ${vin.length}.`; v.vin_warn = true; return renderSheet(); }
  if (st === "letters") { v.vin_note = "VINs never use the letters I, O or Q. Those are probably 1 or 0."; v.vin_warn = true; return renderSheet(); }
  if (!navigator.onLine) { v.vin_note = "No signal. The VIN is saved; look it up later from this visit."; v.vin_warn = true; return renderSheet(); }
  vinBusy.add(vi); renderSheet();
  try {
    const info = await decodeVin(vin);
    Object.assign(v, { ymm: info.ymm, body: info.body, vin_note: st === "check" ? `${info.body || "Vehicle"} · the VIN's check digit doesn't match, so double-check one character.` : info.body || "", vin_warn: st === "check" });
    try { v.recalls = await recallsFor(info.year, info.make, info.model); } catch { v.recalls = undefined; }
  } catch (err) { v.vin_note = err.message; v.vin_warn = true; }
  finally { vinBusy.delete(vi); renderSheet(); }
}

function history(d) {
  const vs = visits.filter((v) => v.door_id === d.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  return vs.length ? `<div><div class="label" style="margin-bottom:6px">History</div><div class="history">${vs.map((v) => `<div><time>${esc(isToday(v.at) ? timeShort(v.at) : new Date(v.at).toLocaleDateString("en-US", { month: "numeric", day: "numeric" }))}</time><span>${esc(S[v.outcome]?.l || v.outcome)}${v.details?.reason ? ` · ${esc(v.details.reason)}` : ""}${v.details?.slot ? ` · ${esc(slotLabel(v.details.slot))}` : ""} · ${esc(v.rep_name || "")}</span></div>`).join("")}</div></div>` : "";
}
function contactActions(d) {
  const ph = digits(d.phone); if (!ph) return "";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const body = d.status === "booked"
    ? `Hi ${firstName(d.name)}, this is ${firstName(rep.name)} with ${CONFIG.company}. You're set for a free hail inspection ${slotLabel(d.slot)}${CONFIG.shopAddress ? ` at ${CONFIG.shopAddress}` : ""}. It takes about 15 minutes. Reply here if you need to change the time.`
    : `Hi ${firstName(d.name)}, this is ${firstName(rep.name)} with ${CONFIG.company}. Thanks for talking with me about the hail damage on your ${d.vehicles?.[0]?.ymm || "vehicle"}. Text me back with a good time for a free 15-minute inspection.`;
  const sms = `sms:${ph}${ios ? "&" : "?"}body=${encodeURIComponent(body)}`;
  let cal = "";
  if (d.status === "booked" && d.slot) {
    const s = d.slot.replace(/[-:]/g, "") + "00";
    const e = new Date(new Date(d.slot + ":00").getTime() + CONFIG.inspection.minutes * 60e3);
    const ee = `${e.getFullYear()}${String(e.getMonth() + 1).padStart(2, "0")}${String(e.getDate()).padStart(2, "0")}T${String(e.getHours()).padStart(2, "0")}${String(e.getMinutes()).padStart(2, "0")}00`;
    const det = [`Customer: ${d.name}`, `Phone: ${d.phone}`, `Home: ${d.address}`, ...(d.vehicles || []).filter((v) => v.ymm).map((v) => `${v.ymm}: ${v.panels.join(", ")}${v.sev ? ` (${v.sev})` : ""}${v.insurer ? ` · ${v.insurer}` : ""}`), d.notes ? `Notes: ${d.notes}` : "", `Booked by ${rep.name}`].filter(Boolean).join("\n");
    cal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`Hail inspection · ${d.name}`)}&dates=${s}/${ee}&ctz=${encodeURIComponent(CONFIG.timeZone)}&details=${encodeURIComponent(det)}&location=${encodeURIComponent(CONFIG.shopAddress || d.address)}`;
  }
  return `<div class="row">
    <a class="btn" href="${esc(sms)}">Text ${d.status === "booked" ? "confirmation" : "follow-up"}</a>
    <a class="btn" href="tel:${ph}">Call</a>
    ${cal ? `<a class="btn" href="${esc(cal)}" target="_blank" rel="noopener">Add to calendar</a>` : ""}
  </div>`;
}

function renderSheet() {
  const host = $("#sheet-host");
  if (sheet === "import") return renderImport();
  if (!sheet || !sel) { host.innerHTML = ""; return; }
  const d = sel;

  if (sheet === "peek" || sheet === "edit-addr") {
    let body;
    if (["none", "nothome", "back"].includes(d.status)) {
      body = `
      ${d.status === "back" && d.back_when ? `<div class="notice warn">Asked to come back <strong>${esc(d.back_when)}</strong>${d.notes ? `. ${esc(d.notes)}` : ""}</div>` : ""}
      ${d.status === "nothome" && d.attempts >= 3 ? `<div class="notice warn">Third try with no answer. Leave a hanger and move on.</div>` : ""}
      <div class="quick">
        <button class="qa primary wide" data-a="answered"><strong>Someone answered</strong><span>Pitch, check vehicles, book the inspection</span></button>
        <button class="qa" data-a="nothome"><strong><i style="background:${colorOf("nothome")}"></i>Not home</strong><span>Logs a visit · next door</span></button>
        <button class="qa" data-a="dnk"><strong><i style="background:${colorOf("dnk")}"></i>No soliciting</strong><span>Skips it from now on</span></button>
      </div>
      <label class="inline-check"><input type="checkbox" id="hanger" checked> Left a door hanger</label>`;
    } else {
      const v = (d.vehicles || []).filter((x) => x.ymm || x.panels?.length);
      body = `
      ${d.name || d.phone ? `<div class="notice"><strong>${esc(d.name)}</strong>${d.phone ? ` · <span class="num">${esc(d.phone)}</span>` : ""}${d.contact_pref ? ` · prefers ${esc(d.contact_pref.toLowerCase())}` : ""}</div>` : ""}
      ${d.slot && d.status === "booked" ? `<div class="notice warn">Inspection <strong>${esc(slotLabel(d.slot))}</strong></div>` : ""}
      ${contactActions(d)}
      ${v.length ? `<div class="history">${v.map((x) => `<div><span><strong style="color:var(--ink)">${esc(x.ymm || "Vehicle")}</strong> · ${esc(x.panels.join(", ") || "no panels marked")}${x.sev ? ` · ${esc(x.sev.toLowerCase())}` : ""}${x.insurer ? ` · ${esc(x.insurer)}` : ""}${x.claim ? ` · claim ${esc(x.claim.toLowerCase())}` : ""}${x.vin ? ` · VIN ${esc(x.vin)}` : ""}${x.recalls?.length ? ` · ${x.recalls.length} model recall${x.recalls.length === 1 ? "" : "s"}` : ""}</span></div>`).join("")}</div>` : ""}
      ${d.photos?.length ? `<div class="photos">${d.photos.map((p) => `<img data-photo="${esc(p)}" alt="Damage photo">`).join("")}</div>` : ""}
      ${d.reason && d.status === "no" ? `<div class="notice">Reason: ${esc(d.reason)}</div>` : ""}
      ${d.notes ? `<div class="notice">${esc(d.notes)}</div>` : ""}
      <div class="quick"><button class="qa wide" data-a="answered"><strong>Update this visit</strong><span>Change the outcome, vehicles or contact details</span></button>
      ${d.status === "dnk" ? `<button class="qa wide" data-a="undnk"><strong>Put back on the route</strong><span>The sign is gone or it was a mistake</span></button>` : ""}</div>`;
    }
    host.innerHTML = `<div class="sheet peek" role="dialog" aria-label="${esc(d.address)}"><div class="sheet-scroll"><div class="grab"></div>${head(d, true)}
      ${sheet === "edit-addr" ? `<div class="row"><button class="btn go" data-a="save-addr">Save address</button><button class="btn" data-a="peek">Cancel</button></div>` : ""}
      ${facts(d)}${driveway(d)}${homeInfo(d)}${body}${history(d)}</div></div>`;
    loadPhotos();
    return;
  }

  if (sheet === "done") {
    const booked = d.status === "booked";
    host.innerHTML = `<div class="sheet peek" role="dialog" aria-label="Saved"><div class="sheet-scroll"><div class="grab"></div>${head(d)}
      <div class="notice warn">${booked ? `Inspection booked for <strong>${esc(slotLabel(d.slot))}</strong>. Send the confirmation before you leave the porch.` : `Lead saved for <strong>${esc(d.name || d.address)}</strong>. Send a follow-up text so they have your number.`}</div>
      ${contactActions(d)}
      ${d.consent ? "" : `<p class="note">They didn't OK texts. Call instead, or ask before texting.</p>`}
    </div><div class="sheet-foot"><button class="btn go" data-a="next-door">Next door</button></div></div>`;
    return;
  }

  /* flow */
  const steps = flowSteps(); step = Math.min(step, steps.length - 1);
  const cur = steps[step]; let body = "";
  if (cur === "Pitch") {
    const script = `Hi${draft.name ? ` <mark>${esc(firstName(draft.name))}</mark>` : ""}, I'm ${esc(firstName(rep.name) || "—")} with ${esc(CONFIG.company)}, a local paintless dent repair shop. The <mark>${esc(stormLabel(draft.storm))}</mark> storm hit this neighborhood with hail, so we're doing free 15-minute hail inspections for neighbors. Has anyone looked at your vehicles since then?`;
    body = `<div class="label">Say this</div><div class="script">${script}</div>
      <div class="label">If they say…</div>
      <div>${OBJ.map(([q, a], i) => `<div class="obj"><button data-obj="${i}" aria-expanded="${openObj === i}">${esc(q)}<span aria-hidden="true">${openObj === i ? "−" : "+"}</span></button>${openObj === i ? `<p>${esc(a)}</p>` : ""}</div>`).join("")}</div>
      <div class="field"><label for="storm">Storm</label><select id="storm" data-k="storm">${CONFIG.storms.map((s) => `<option value="${s}" ${draft.storm === s ? "selected" : ""}>${esc(stormLabel(s))}</option>`).join("")}</select></div>
      <p class="note">Say "may be covered". Never promise a deadline or a free repair.</p>`;
  }
  if (cur === "Vehicles") {
    body = draft.vehicles.map((v, vi) => `
      <div class="veh">
        <div class="veh-head"><strong>Vehicle ${vi + 1}${v.seen ? ` · <span class="note">${esc(v.seen)} seen from the street</span>` : ""}</strong>${draft.vehicles.length > 1 ? `<button class="btn link" data-delveh="${vi}">Remove</button>` : ""}</div>
        <div class="field"><label for="vin-${vi}">VIN <span class="note">(through the windshield, driver's side, or the door jamb sticker)</span></label>
          <div class="vinrow"><input type="text" id="vin-${vi}" data-v="${vi}" data-k="vin" value="${esc(v.vin || "")}" maxlength="17" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="17 characters" class="mono">
          <button class="btn" data-vin="${vi}" ${vinBusy.has(vi) ? "disabled" : ""}>${vinBusy.has(vi) ? "Looking up…" : "Look up"}</button></div>
          ${v.vin_note ? `<p class="note ${v.vin_warn ? "warn-text" : ""}">${esc(v.vin_note)}</p>` : ""}</div>
        ${recallBox(v)}
        <div class="field"><label for="ymm-${vi}">Year, make, model</label><input type="text" id="ymm-${vi}" data-v="${vi}" data-k="ymm" value="${esc(v.ymm)}" placeholder="2021 Ford F-150" autocomplete="off"></div>
        <div class="label">Tap the damaged panels</div>
        ${carSvg(vi, v.panels)}
        <div class="toggles" role="group" aria-label="Damage severity">${["Light", "Moderate", "Severe"].map((s) => `<button class="tog" data-sev="${vi}" data-val="${s}" aria-pressed="${v.sev === s}">${s}</button>`).join("")}</div>
        <div class="fields">
          <div class="field"><label for="ins-${vi}">Insurer</label><select id="ins-${vi}" data-v="${vi}" data-k="insurer">${INSURERS.map((x) => `<option value="${esc(x)}" ${v.insurer === x ? "selected" : ""}>${x || "Pick one"}</option>`).join("")}</select></div>
          <div class="field"><label for="clm-${vi}">Claim</label><select id="clm-${vi}" data-v="${vi}" data-k="claim">${["", "Not filed", "Filed", "Not sure"].map((x) => `<option value="${x}" ${v.claim === x ? "selected" : ""}>${x || "Pick one"}</option>`).join("")}</select></div>
        </div>
      </div>`).join("") + `
      <button class="btn" data-a="addveh">+ Add another vehicle</button>
      <div class="label">Damage photos</div>
      <div class="photos">${(draft.photos || []).map((p) => `<img data-photo="${esc(p)}" alt="Damage photo">`).join("")}<label class="addphoto" for="photo-in">+ Add<br>photo</label></div>`;
  }
  if (cur === "Outcome") {
    body = `<div class="label">How did it end?</div>
      <div class="outs">${OUTCOMES.map((k) => `<button class="oc" data-oc="${k}" aria-pressed="${draft.status === k}"><i style="background:${colorOf(k)}"></i>${S[k].l}</button>`).join("")}</div>`;
    if (draft.status === "booked") {
      const days = slotList(), taken = takenSlots(d.id), page = days.slice(slotPage * 3, slotPage * 3 + 3);
      body += `<div class="slotnav"><span class="label">Pick an inspection slot</span><span><button class="btn link" data-slotpage="-1" ${slotPage ? "" : "disabled"} aria-label="Earlier days">‹ Earlier</button><button class="btn link" data-slotpage="1" ${(slotPage + 1) * 3 < days.length ? "" : "disabled"} aria-label="Later days">Later ›</button></span></div>
        <div class="slots">${page.map((dd) => `<div class="slotday">${esc(dd.label)}</div>`).join("")}
        ${CONFIG.inspection.times.map((_, ti) => page.map((dd) => { const s = dd.times[ti], off = s.past || taken.has(s.key); return `<button class="slot" data-slot="${s.key}" ${off ? "disabled" : ""} aria-label="${esc(dd.label + " " + s.t)}${off ? " unavailable" : ""}" aria-pressed="${draft.slot === s.key}">${s.t}</button>`; }).join("")).join("")}</div>`;
    }
    if (draft.status === "back") body += `<div class="label">When should you come back?</div><div class="toggles">${BACK_WHEN.map((w) => `<button class="tog" data-back="${w}" aria-pressed="${draft.back_when === w}">${w}</button>`).join("")}</div>`;
    if (draft.status === "no") body += `<div class="label">Why? (optional)</div><div class="toggles">${NO_REASONS.map((r) => `<button class="tog" data-reason="${r}" aria-pressed="${draft.reason === r}">${r}</button>`).join("")}</div>`;
    if (draft.status) body += `<div class="field"><label for="notes">Notes</label><textarea id="notes" data-k="notes" placeholder="Who answered, best time, anything the inspector should know">${esc(draft.notes)}</textarea></div>`;
  }
  if (cur === "Contact") {
    body = `<div class="fields">
      <div class="field wide"><label for="c-name">Name</label><input type="text" id="c-name" data-k="name" value="${esc(draft.name)}" placeholder="First and last name" autocomplete="off">
        ${sel.owner && draft.name !== sel.owner ? `<button class="btn link" style="align-self:flex-start;padding:2px 0" data-a="use-owner">Use owner on record: ${esc(sel.owner)}</button>` : ""}</div>
      <div class="field"><label for="c-phone">Phone</label><input type="tel" id="c-phone" data-k="phone" value="${esc(draft.phone)}" placeholder="(913) 555-0100" autocomplete="off"></div>
      <div class="field"><label for="c-email">Email (optional)</label><input type="email" id="c-email" data-k="email" value="${esc(draft.email)}" autocomplete="off"></div>
    </div>
    <div class="label">Best way to reach them</div>
    <div class="toggles">${["Text", "Call", "Email"].map((c) => `<button class="tog" data-contact="${c}" aria-pressed="${draft.contact_pref === c}">${c}</button>`).join("")}</div>
    <label class="inline-check"><input type="checkbox" id="consent" ${draft.consent ? "checked" : ""}> They said it's OK to text them about the inspection</label>
    <div class="notice">Saved with source <strong>Door knock</strong>, storm ${esc(stormLabel(draft.storm))} and ZIP ${esc(draft.zip || "—")} for the master lead sheet.</div>`;
  }
  const last = step === steps.length - 1;
  host.innerHTML = `<div class="sheet" role="dialog" aria-label="Log visit at ${esc(d.address)}">
    <div class="sheet-scroll"><div class="grab"></div>${head(d)}
      <div class="steps" role="tablist" aria-label="Visit steps">${steps.map((s, i) => `<button role="tab" data-step="${i}" class="${i === step ? "on" : i < step ? "done" : ""}" aria-selected="${i === step}">${s}</button>`).join("")}</div>
      ${body}
    </div>
    <div class="sheet-foot">
      <button class="btn" data-a="${step ? "back" : "peek"}">${step ? "Back" : "Cancel"}</button>
      ${last ? `<button class="btn go" data-a="save" ${draft.status ? "" : "disabled"}>${draft.status ? "Save visit" : "Pick an outcome first"}</button>`
             : `<button class="btn go" data-a="next">Next: ${steps[step + 1]}</button>`}
    </div></div>`;
  loadPhotos();
}
const stormLabel = (s) => { if (!s) return "recent"; const d = new Date(s + "T12:00:00"); return isNaN(d) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
function carSvg(vi, on) {
  const P = { Hood: "M70 18 h60 v40 h-60z", Roof: "M72 100 h56 v60 h-56z", Trunk: "M72 200 h56 v34 h-56z", Glass: "M74 62 h52 v34 h-52z", "L doors": "M40 100 h28 v84 h-28z", "R doors": "M132 100 h28 v84 h-28z", "L fender": "M40 22 h26 v72 h-26z", "R fender": "M134 22 h26 v72 h-26z" };
  const Lb = { Hood: [100, 41], Roof: [100, 133], Trunk: [100, 220], Glass: [100, 82], "L doors": [54, 145], "R doors": [146, 145], "L fender": [53, 60], "R fender": [147, 60] };
  return `<svg class="car" viewBox="0 0 200 250" role="group" aria-label="Vehicle ${vi + 1} panels">
    <rect x="34" y="10" width="132" height="232" rx="34" fill="none" stroke="var(--line)" stroke-width="2"/>
    ${PANELS.map((p) => `<path class="panel${on.includes(p) ? " on" : ""}" d="${P[p]}" data-panel="${vi}" data-val="${p}" tabindex="0" role="button" aria-pressed="${on.includes(p)}" aria-label="${p}"/><text x="${Lb[p][0]}" y="${Lb[p][1] + 3}" text-anchor="middle">${p}</text>`).join("")}
  </svg>`;
}
async function loadPhotos() {
  for (const img of document.querySelectorAll("img[data-photo]")) {
    const p = img.dataset.photo;
    if (photoUrls.has(p)) { img.src = photoUrls.get(p); continue; }
    const u = await sync.photoUrl(p).catch(() => null);
    if (u) { photoUrls.set(p, u); img.src = u; } else img.alt = "Photo uploads when online";
  }
}

/* import sheet */
function renderImport() {
  const host = $("#sheet-host");
  const fresh = importList.filter((d) => !doors.has(d.id));
  host.innerHTML = `<div class="sheet peek" role="dialog" aria-label="Load doors"><div class="sheet-scroll"><div class="grab"></div>
    <div class="sheet-head"><div><div class="addr">Load ${fresh.length} doors</div><div class="addr-sub">${importList.length - fresh.length} already on the map</div></div>
      <button class="x" data-a="close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="2" fill="none"><path d="M2 2l10 10M12 2 2 12"/></svg></button></div>
    ${fresh.length ? `<div class="fields">
      <div class="field"><label for="imp-turf">Turf name</label><input type="text" id="imp-turf" value="${esc(importTurf)}" placeholder="e.g. 66212 north"></div>
      <div class="field"><label for="imp-rep">Assign to</label><select id="imp-rep">${[rep.name, ...reps.map((r) => r.name).filter((n) => n && n !== rep.name), ""].map((n) => `<option value="${esc(n)}" ${importRep === n ? "selected" : ""}>${n ? esc(n) : "Anyone"}</option>`).join("")}</select></div>
    </div>
    <div class="row"><button class="btn go" data-a="do-import">Add ${fresh.length} doors</button></div>` : `<div class="notice">Every address on screen is already loaded.</div>`}
    <p class="note">Addresses come from OpenStreetMap. Some streets are missing house numbers there; use + to drop a door by hand, or import a CSV list in Settings.</p>
  </div></div>`;
}

/* ================= sheet events ================= */
async function quickNotHome(d, hanger) {
  const before = clone(d);
  d.status = "nothome"; d.attempts = (d.attempts || 0) + 1; d.hanger = d.hanger || hanger;
  const v = makeVisit(d, "nothome", { hanger });
  await saveDoor(d, v);
  undo = { before, visitId: v.id };
  toast(`Not home · ${d.address}`, true);
}
async function goNext(fromId) {
  const nx = nextDoor(fromId);
  if (nx) openPeek(nx.id); else { closeSheet(); toast("No unknocked doors nearby. Load more from the map."); }
}

$("#sheet-host").addEventListener("change", (e) => {
  if (e.target.id === "consent") draft.consent = e.target.checked;
  if (e.target.id === "imp-rep") importRep = e.target.value;
});
$("#sheet-host").addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "imp-turf") { importTurf = t.value; return; }
  if (!draft) return;
  if (t.dataset.v != null) draft.vehicles[+t.dataset.v][t.dataset.k] = t.value;
  else if (t.dataset.k) draft[t.dataset.k] = t.value;
});
$("#sheet-host").addEventListener("keydown", (e) => { const p = e.target.closest("[data-panel]"); if (p && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); p.dispatchEvent(new MouseEvent("click", { bubbles: true })); } });
$("#sheet-host").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-a],[data-obj],[data-oc],[data-slot],[data-slotpage],[data-back],[data-reason],[data-contact],[data-sev],[data-panel],[data-step],[data-delveh],[data-dn],[data-dt],[data-vin]");
  if (!t) return;
  const a = t.dataset.a;
  if (a === "close") return closeSheet();
  if (a === "answered") return startFlow();
  if (a === "nothome") { const d = sel; await quickNotHome(d, !!$("#hanger")?.checked); return goNext(d.id); }
  if (a === "dnk") {
    const d = sel, before = clone(d); d.status = "dnk"; const v = makeVisit(d, "dnk");
    await saveDoor(d, v); undo = { before, visitId: v.id }; toast("Marked do not knock", true); return goNext(d.id);
  }
  if (a === "undnk") { sel.status = "none"; await saveDoor(sel); return renderAll(); }
  if (a === "edit-addr") { sheet = "edit-addr"; renderSheet(); $("#addr-in")?.focus(); return; }
  if (a === "save-addr") { const v = $("#addr-in").value.trim(); if (v) { sel.address = v; sel.street = v.replace(/^\d+[a-z]?\s+/i, ""); await saveDoor(sel); } sheet = "peek"; return renderAll(); }
  if (a === "peek") { sheet = "peek"; draft = null; return renderSheet(); }
  if (a === "back") { step--; return renderSheet(); }
  if (a === "next") { step++; return renderSheet(); }
  if (a === "next-door") return goNext(sel.id);
  if (a === "addveh") { draft.vehicles.push({ ymm: "", vin: "", panels: [], sev: "", insurer: "", claim: "" }); return renderSheet(); }
  if (a === "do-import") return doImport();
  if (a === "lookup") { lookupDoor(sel).catch(() => {}); return; }
  if (t.dataset.vin != null) return lookupVin(+t.dataset.vin);
  if (t.dataset.dn != null || t.dataset.dt) {
    const d = sel, dw = { ...(d.driveway || { types: [] }) };
    if (t.dataset.dn != null) { dw.count = +t.dataset.dn; if (!dw.count) dw.types = []; }
    else dw.types = (dw.types || []).includes(t.dataset.dt) ? dw.types.filter((x) => x !== t.dataset.dt) : [...(dw.types || []), t.dataset.dt];
    dw.at = nowIso(); dw.by = rep.name;
    d.driveway = dw;
    await saveDoor(d);
    return renderAll();
  }
  if (a === "use-owner") { draft.name = sel.owner; return renderSheet(); }
  if (t.dataset.delveh != null) { draft.vehicles.splice(+t.dataset.delveh, 1); return renderSheet(); }
  if (t.dataset.step != null) { step = +t.dataset.step; return renderSheet(); }
  if (t.dataset.obj != null) { openObj = openObj === +t.dataset.obj ? -1 : +t.dataset.obj; return renderSheet(); }
  if (t.dataset.oc) { draft.status = t.dataset.oc; return renderSheet(); }
  if (t.dataset.slot) { draft.slot = t.dataset.slot; return renderSheet(); }
  if (t.dataset.slotpage) { slotPage = Math.max(0, slotPage + +t.dataset.slotpage); return renderSheet(); }
  if (t.dataset.back) { draft.back_when = t.dataset.back; return renderSheet(); }
  if (t.dataset.reason) { draft.reason = draft.reason === t.dataset.reason ? "" : t.dataset.reason; return renderSheet(); }
  if (t.dataset.contact) { draft.contact_pref = t.dataset.contact; return renderSheet(); }
  if (t.dataset.sev) { const v = draft.vehicles[+t.dataset.sev]; v.sev = v.sev === t.dataset.val ? "" : t.dataset.val; return renderSheet(); }
  if (t.dataset.panel) { const v = draft.vehicles[+t.dataset.panel], p = t.dataset.val; v.panels = v.panels.includes(p) ? v.panels.filter((x) => x !== p) : [...v.panels, p]; return renderSheet(); }
  if (a === "save") return saveFlow();
});

async function saveFlow() {
  const steps = flowSteps();
  if (draft.status === "booked" && !draft.slot) { step = steps.indexOf("Outcome"); renderSheet(); return toast("Pick an inspection slot"); }
  if (draft.status === "booked" && takenSlots(sel.id).has(draft.slot)) { draft.slot = null; step = steps.indexOf("Outcome"); renderSheet(); return toast("Someone just booked that slot. Pick another."); }
  if (draft.status === "back" && !draft.back_when) { step = steps.indexOf("Outcome"); renderSheet(); return toast("Pick when to come back"); }
  if ((draft.status === "lead" || draft.status === "booked") && digits(draft.phone).length < 10) { step = steps.indexOf("Contact"); renderSheet(); $("#c-phone")?.focus(); return toast("Add a 10-digit phone number to save this lead"); }
  const d = sel, before = clone(d);
  const wasOpen = ["none", "nothome", "back"].includes(d.status);
  // keep owner info that arrived while the rep was filling in the flow
  const props = d.prop_checked_at ? Object.fromEntries(PROP_FIELDS.map((k) => [k, d[k]])) : {};
  Object.assign(d, draft, props);
  d.vehicles = (d.vehicles || []).filter((v) => v.ymm || v.panels.length || v.insurer);
  if (d.status !== "booked") d.slot = null;
  if (wasOpen) d.attempts = (d.attempts || 0) + 1;
  for (const p of d.photos || []) {
    if (!(before.photos || []).includes(p) && pendingBlobs.has(p)) { const b = pendingBlobs.get(p); await store.enqueue({ type: "photo", path: p, blob: b, contentType: b.type || "image/jpeg" }); pendingBlobs.delete(p); }
  }
  const v = makeVisit(d, d.status, { reason: d.reason || undefined, back_when: d.back_when || undefined, slot: d.slot || undefined, vehicles: d.vehicles.length });
  await saveDoor(d, v);
  undo = { before, visitId: v.id };
  draft = null;
  const msg = d.status === "booked" ? `Inspection booked · ${slotLabel(d.slot)}` : d.status === "back" ? `Come back · ${d.back_when}` : d.status === "no" ? `Not interested${d.reason ? ` · ${d.reason}` : ""}` : "Lead saved";
  toast(msg, true);
  if (d.status === "booked" || d.status === "lead") { sheet = "done"; renderAll(); }
  else goNext(d.id);
}

const pendingBlobs = new Map();
$("#photo-in").addEventListener("change", async (e) => {
  if (!draft) return;
  for (const f of [...e.target.files]) {
    const blob = await shrink(f).catch(() => f);
    const path = `${draft.id.replace(/[^a-z0-9]+/gi, "_")}/${uuid()}.jpg`;
    pendingBlobs.set(path, blob); photoUrls.set(path, URL.createObjectURL(blob));
    draft.photos = [...(draft.photos || []), path];
  }
  e.target.value = ""; renderSheet();
});
async function shrink(file, max = 1600) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
}

/* ================= map controls ================= */
document.querySelector(".overlay-top").addEventListener("click", (e) => {
  const m = e.target.closest("[data-mode]"); if (m) { mode = m.dataset.mode; renderAll(); return; }
  const f = e.target.closest("[data-f]"); if (f) { filter = f.dataset.f; paintAll(); renderAll(); }
});
$("#ctrls").addEventListener("click", (e) => {
  const c = e.target.closest("[data-c]")?.dataset.c; if (!c) return;
  if (c === "me") { follow = true; if (me) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17)); else toast("Waiting for GPS…"); renderCtrls(); }
  if (c === "load") loadInView();
  if (c === "add") { adding = !adding; if (adding) closeSheet(); renderCtrls(); renderNext(); }
});
$("#nextbar").addEventListener("click", async (e) => {
  if (e.target.closest("#go-next")) { const nx = nextDoor(sel?.id); if (nx) openPeek(nx.id); }
  if (e.target.closest("#go-load")) loadInView();
  if (e.target.closest("#cancel-pin")) { adding = false; renderCtrls(); renderNext(); }
  if (e.target.closest("#drop-pin")) dropPin();
});
$("#walk").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]"); if (o) { mode = "map"; openPeek(o.dataset.open); return; }
  const n = e.target.closest("[data-nh]"); if (n) { await quickNotHome(doors.get(n.dataset.nh), true); renderAll(); }
});

async function loadInView() {
  if (mode !== "map") { mode = "map"; renderAll(); }
  if (map.getZoom() < 16) { toast("Zoom in to a few blocks first, then tap the house button."); return; }
  if (!navigator.onLine) { toast("Loading addresses needs signal. You can still drop doors by hand with +."); return; }
  toast("Finding addresses on screen…");
  try {
    importList = await addressesInView(map.getBounds());
    if (!importList.length) { importList = null; toast("No house numbers on this map area. Drop doors by hand with +, or import a CSV in Settings."); return; }
    importTurf = importTurf || `${importList.find((d) => d.zip)?.zip || "Turf"} · ${new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}`;
    importRep = importRep || rep.name;
    sel = null; sheet = "import"; renderAll();
  } catch (err) { toast(err.message || "Couldn't load addresses. Try again."); }
}
async function doImport(list = importList) {
  const fresh = list.filter((d) => !doors.has(d.id)).map((d) => ({ ...newDoor(d), turf: importTurf, assigned_to: importRep }));
  fresh.forEach((d) => doors.set(d.id, d));
  await store.putDoors(fresh);
  for (let i = 0; i < fresh.length; i += 200) await store.enqueue({ type: "doors_import", doors: fresh.slice(i, i + 200) });
  fresh.forEach(paintDoor);
  importList = null; sheet = null;
  toast(`Added ${fresh.length} doors`);
  kick(); renderAll();
}
async function dropPin() {
  const c = map.getCenter();
  adding = false; renderCtrls();
  let info = { address: "", street: "", city: "", zip: "" };
  if (navigator.onLine) info = await reverseLookup(c.lat, c.lng).catch(() => info);
  const d = newDoor({ lat: c.lat, lng: c.lng, ...info, address: info.address || `Door near ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`, assigned_to: rep.name });
  doors.set(d.id, d);
  await store.putDoors([d]); await store.enqueue({ type: "door", door: d });
  paintDoor(d); kick();
  openPeek(d.id);
  if (!info.address) { sheet = "edit-addr"; renderSheet(); }
}

/* ================= leads ================= */
function renderLeads() {
  const all = [...doors.values()].filter((d) => ["lead", "booked", "back"].includes(d.status) && (leadScope === "all" || isMine(d) || d.updated_by_name === rep.name));
  const rank = { booked: 0, lead: 1, back: 2 };
  const list = all.filter((d) => leadFilter === "all" || d.status === leadFilter).sort((a, b) => rank[a.status] - rank[b.status] || String(a.slot || "").localeCompare(String(b.slot || "")) || b.updated_at.localeCompare(a.updated_at));
  const cnt = (k) => all.filter((d) => d.status === k).length;
  $("#v-leads").innerHTML = `<div class="pad">
    <div><h1>Leads</h1><p class="sub">Every lead carries source, storm date and ZIP for the master lead sheet.</p></div>
    <div class="row" style="align-items:center">
      <div class="seg" role="group" aria-label="Whose leads"><button data-ls="mine" aria-pressed="${leadScope === "mine"}">Mine</button><button data-ls="all" aria-pressed="${leadScope === "all"}">Whole team</button></div>
      <button class="btn" data-a="export" style="margin-left:auto;padding:8px 12px">Export CSV</button>
    </div>
    <div class="chips" role="group" aria-label="Filter leads">
      ${[["all", `All ${all.length}`], ["booked", `Booked ${cnt("booked")}`], ["lead", `Quote ${cnt("lead")}`], ["back", `Come back ${cnt("back")}`]].map(([k, l]) => `<button class="chip" data-lf="${k}" aria-pressed="${leadFilter === k}">${l}</button>`).join("")}
    </div>
    ${list.length ? list.map((d) => { const v = (d.vehicles || []).filter((x) => x.ymm); return `<button class="lead" data-open="${esc(d.id)}">
      <span class="stripe" style="background:${colorOf(d.status)}"></span>
      <span class="lead-main"><span class="lead-name">${esc(d.name || d.address)}</span>
        <span class="lead-meta">${esc(d.name ? d.address : S[d.status].l)}${v.length ? ` · ${esc(v.map((x) => x.ymm).join(", "))}` : ""}</span>
        <span class="lead-meta">${esc(d.updated_by_name || "")}${d.notes ? ` · ${esc(d.notes)}` : ""}</span></span>
      ${d.slot && d.status === "booked" ? `<span class="lead-when">${esc(slotLabel(d.slot))}</span>` : d.status === "back" && d.back_when ? `<span class="lead-when">${esc(d.back_when)}</span>` : d.phone ? `<span class="lead-when">${esc(d.phone)}</span>` : ""}
    </button>`; }).join("") : `<div class="empty">No leads here yet. They show up as soon as someone logs a lead or a booking.</div>`}
  </div>`;
  const n = [...doors.values()].filter((d) => (d.status === "lead" || d.status === "booked") && (isMine(d) || d.updated_by_name === rep.name)).length;
  const b = $("#lead-badge"); b.hidden = !n; b.textContent = n;
}
$("#v-leads").addEventListener("click", (e) => {
  const ls = e.target.closest("[data-ls]"); if (ls) { leadScope = ls.dataset.ls; renderLeads(); return; }
  const f = e.target.closest("[data-lf]"); if (f) { leadFilter = f.dataset.lf; renderLeads(); return; }
  if (e.target.closest("[data-a=export]")) return exportCsv();
  const o = e.target.closest("[data-open]"); if (o) openPeek(o.dataset.open);
});
function exportCsv() {
  const rows = [...doors.values()].filter((d) => ["lead", "booked", "back", "no"].includes(d.status)).map((d) => ({
    status: S[d.status].l, name: d.name, phone: d.phone, email: d.email, contact_pref: d.contact_pref, ok_to_text: d.consent ? "yes" : "no",
    address: d.address, city: d.city, zip: d.zip, storm_date: d.storm, inspection: slotLabel(d.slot), come_back: d.back_when, reason: d.reason,
    vehicles: (d.vehicles || []).map((v) => `${v.ymm}${v.vin ? ` VIN ${v.vin}` : ""} [${v.panels.join("/")}] ${v.sev || ""} ${v.insurer || ""} ${v.claim || ""}`.trim()).join("; "),
    cars_outside: d.driveway?.count ?? "",
    notes: d.notes, source: "Door knock", turf: d.turf, rep: d.updated_by_name, updated: d.updated_at,
    owner_on_record: d.owner, owner_lives_here: d.owner_occupied == null ? "" : d.owner_occupied ? "yes" : "no", owner_mailing: d.mailing_address,
    home_value: d.home_value || "", year_built: d.year_built || "", sqft: d.sqft || "", last_sale: [fmtSale(d.last_sale_date), d.last_sale_price || ""].filter(Boolean).join(" "), parcel: d.parcel_id,
  }));
  const csv = toCsv(rows, ["status", "name", "phone", "email", "contact_pref", "ok_to_text", "address", "city", "zip", "storm_date", "inspection", "come_back", "reason", "vehicles", "notes", "cars_outside", "source", "turf", "rep", "updated", "owner_on_record", "owner_lives_here", "owner_mailing", "home_value", "year_built", "sqft", "last_sale", "parcel"]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `danos-dents-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ================= today ================= */
function renderToday() {
  const t = myToday();
  const out = (o) => t.mine.filter((v) => o.includes(v.outcome)).length;
  const answered = out(["no", "back", "lead", "booked"]), leads = out(["lead", "booked"]);
  const hrs = t.first ? (Date.now() - new Date(t.first)) / 36e5 : 0;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
  const steps = [["Doors knocked", t.doorsK], ["Answered", answered], ["Leads", leads], ["Booked", t.booked]];
  const max = Math.max(1, t.doorsK);
  const byRep = {};
  visits.filter((v) => isToday(v.at)).forEach((v) => {
    const k = v.rep_name || "Unknown"; byRep[k] = byRep[k] || { doors: new Set(), leads: 0, booked: 0 };
    byRep[k].doors.add(v.door_id); if (v.outcome === "lead" || v.outcome === "booked") byRep[k].leads++; if (v.outcome === "booked") byRep[k].booked++;
  });
  const crew = Object.entries(byRep).map(([n, r]) => [n, r.doors.size, r.leads, r.booked]).sort((a, b) => b[3] - a[3] || b[2] - a[2] || b[1] - a[1]);
  $("#v-today").innerHTML = `<div class="pad">
    <div><h1>Today</h1><p class="sub">Goal: ${CONFIG.goals.doors} doors and ${CONFIG.goals.booked} inspections booked</p></div>
    <div class="kpis">
      <div class="kpi"><div class="v num">${t.doorsK}</div><div class="k">doors knocked</div></div>
      <div class="kpi"><div class="v num">${t.booked}</div><div class="k">inspections booked</div></div>
      <div class="kpi"><div class="v num">${hrs > 0.25 ? Math.round(t.doorsK / hrs) : "—"}</div><div class="k">doors per hour</div></div>
      <div class="kpi"><div class="v num">${pct(t.booked, answered)}</div><div class="k">booked per answered door</div></div>
    </div>
    <div class="label">Your door funnel</div>
    <div class="funnel">${steps.map(([l, v]) => `<div class="frow"><span>${l}</span><div class="ftrack"><span style="width:${(v / max) * 100}%"></span></div><span class="num" style="text-align:right">${v}</span></div>`).join("")}</div>
    <div class="label">Crew today</div>
    ${crew.length ? `<div class="board"><table><thead><tr><th>Rep</th><th class="r">Doors</th><th class="r">Leads</th><th class="r">Booked</th></tr></thead>
      <tbody>${crew.map((r) => `<tr><td>${esc(r[0])}${r[0] === rep.name ? " (you)" : ""}</td><td class="r num">${r[1]}</td><td class="r num">${r[2]}</td><td class="r num"><strong>${r[3]}</strong></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty">No doors logged today yet.</div>`}
    ${sync.enabled ? "" : `<p class="note">Crew numbers need the team database. Connect it in Settings.</p>`}
  </div>`;
}

/* ================= settings / sign-in gate ================= */
function showGate(kind, msg) {
  const g = $("#gate"); g.hidden = false;
  const c = connection();
  if (kind === "signin") {
    g.innerHTML = `<div class="gate-card"><div class="brand">Dano's Dents <span>Knock</span></div>
      <h1>Sign in</h1><p class="sub">Use the email Dano added you with. We'll email you a 6-digit code.</p>
      ${msg ? `<div class="notice err">${esc(msg)}</div>` : ""}
      <form id="f-email" class="field"><label for="g-email">Email</label><input type="email" id="g-email" required autocomplete="email" value="${esc(localStorage.getItem("knock.email") || "")}"><button class="btn go" style="margin-top:8px">Email me a code</button></form>
      <form id="f-code" class="field" hidden><label for="g-code">6-digit code</label><input type="text" id="g-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"><button class="btn go" style="margin-top:8px">Sign in</button></form>
      <section><button class="btn link" data-g="local">Use without a team account on this phone</button></section></div>`;
    return;
  }
  if (kind === "name") {
    g.innerHTML = `<div class="gate-card"><div class="brand">Dano's Dents <span>Knock</span></div>
      <h1>What's your name?</h1><p class="sub">It shows on every door you log and on the crew board.</p>
      <form id="f-name" class="field"><label for="g-name">First and last name</label><input type="text" id="g-name" required value="${esc(rep.name)}"><button class="btn go" style="margin-top:8px">Start knocking</button></form>
      ${!sync.enabled ? `<section><div class="label">Team database</div><p class="note">Without it, doors and leads stay on this phone only.</p>${connForm(c)}</section>` : ""}</div>`;
    return;
  }
  // settings
  g.innerHTML = `<div class="gate-card">
    <div class="sheet-head"><h1>Settings</h1><button class="x" data-g="close" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="2" fill="none"><path d="M2 2l10 10M12 2 2 12"/></svg></button></div>
    <form id="f-name" class="field"><label for="g-name">Your name</label><input type="text" id="g-name" required value="${esc(rep.name)}"><button class="btn" style="margin-top:8px">Save name</button></form>
    <section><div class="label">Sync</div>
      <div class="notice">${sync.enabled ? (sync.user ? `Signed in as <strong>${esc(sync.user.email)}</strong>` : "Team database connected, not signed in") : "Single-phone mode: nothing leaves this phone"} · ${outboxN} change${outboxN === 1 ? "" : "s"} waiting</div>
      <div class="row">${sync.enabled && sync.user ? `<button class="btn" data-g="sync">Sync now</button><button class="btn danger" data-g="signout">Sign out</button>` : ""}</div>
      ${connForm(c)}</section>
    ${propertyEnabled(propSettings) ? `<section><div class="label">Homeowner and home value lookups</div>
      <p class="note">Free from the county parcel maps for <strong>Johnson County KS, Wyandotte County KS and Jackson County MO</strong>. Opening a door looks it up once and shares the result with the team.</p>
      <div class="row"><button class="btn" data-g="test-counties">Test county records</button>${propertyEnabled(propSettings) ? `<button class="btn" data-g="lookup-screen">Look up doors on screen</button>` : ""}</div>
      <div id="county-test"></div>
      <details><summary class="note" style="cursor:pointer">Other counties (Clay, Platte, Cass…): Regrid paid API</summary>
      <form id="f-prop" class="field" style="margin-top:8px"><label for="g-regrid">Regrid API token (optional)</label><input type="text" id="g-regrid" value="${esc(propSettings.regridToken)}" autocomplete="off" placeholder="Paste token"><button class="btn" style="margin-top:8px">Save${sync.enabled && sync.user ? " for the whole team" : " on this phone"}</button></form></details></section>` : ""}
    <section><div class="label">Add doors from a list</div>
      <p class="note">CSV with columns address, lat, lng. Optional: owner, mailing address, home value, year built, sqft, sale date, sale price, parcel, plus city, zip, name, phone, notes. Works with county parcel exports and Hail Recon lists.</p>
      <label class="btn" for="csv-in">Choose CSV file</label></section>
    <section><div class="label">This phone</div>
      <p class="note">${doors.size} doors and ${visits.length} visits stored. Add the app to your home screen from the browser's Share menu so it opens full screen and works offline.</p></section>
  </div>`;
}
function connForm(c) {
  return `<details ${c.configured ? "" : "open"}><summary class="note" style="cursor:pointer">Team database connection</summary>
    <form id="f-conn" class="fields" style="margin-top:8px">
      <div class="field wide"><label for="g-url">Supabase project URL</label><input type="url" id="g-url" value="${esc(c.url)}" placeholder="https://xxxx.supabase.co"></div>
      <div class="field wide"><label for="g-key">Anon public key</label><input type="text" id="g-key" value="${esc(c.key)}" autocomplete="off"></div>
      <button class="btn field wide">Save and reload</button></form></details>`;
}
let pendingEmail = "";
$("#gate").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.id;
  try {
    if (f === "f-email") {
      pendingEmail = $("#g-email").value.trim();
      try { localStorage.setItem("knock.email", pendingEmail); } catch {}
      await sync.sendCode(pendingEmail);
      $("#f-email").hidden = true; $("#f-code").hidden = false; $("#g-code").focus();
    }
    if (f === "f-code") {
      await sync.verifyCode(pendingEmail, $("#g-code").value.trim());
      await afterSignIn();
    }
    if (f === "f-name") {
      const n = $("#g-name").value.trim(); if (!n) return;
      if (sync.enabled && sync.user) await sync.saveProfile(n);
      rep.name = n; try { localStorage.setItem("knock.repName", n); } catch {}
      $("#gate").hidden = true; await boot();
    }
    if (f === "f-conn") { saveConnection($("#g-url").value, $("#g-key").value); location.reload(); }
    if (f === "f-prop") {
      propSettings.regridToken = $("#g-regrid").value.trim();
      try { localStorage.setItem("knock.regrid", propSettings.regridToken); } catch {}
      if (sync.enabled && sync.user) await sync.setTeamSetting("regrid_token", propSettings.regridToken);
      toast(propSettings.regridToken ? "Property lookups are on" : "Property lookups are off"); showGate("settings");
    }
  } catch (err) {
    const msg = /not.*found|signups/i.test(err.message) ? "That email isn't on the team yet. Ask Dano to add you." : /expired|invalid/i.test(err.message) ? "That code didn't work. Check it, or request a new one." : err.message;
    if (f === "f-email" || f === "f-code") showGate("signin", msg); else toast(msg);
  }
});
$("#gate").addEventListener("click", async (e) => {
  const g = e.target.closest("[data-g]")?.dataset.g; if (!g) return;
  if (g === "close") { $("#gate").hidden = true; return; }
  if (g === "local") { saveConnection("", ""); location.reload(); return; }
  if (g === "sync") { await sync.push(); await sync.pull(); toast("Synced"); showGate("settings"); }
  if (g === "signout") { await sync.signOut(); location.reload(); }
  if (g === "lookup-screen") { $("#gate").hidden = true; setTab("map"); lookupOnScreen(); }
  if (g === "test-counties") { propSettings.countyLayers = {}; testCounties(); }
  if (g === "copy-report") copyReport();
});
$("#rep-btn").addEventListener("click", () => showGate("settings"));
$("#csv-in").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const list = parseCsv(await f.text());
    $("#gate").hidden = true;
    if (!list.length) return toast("No rows with an address, lat and lng.");
    importList = list; importTurf = f.name.replace(/\.csv$/i, ""); importRep = rep.name; sel = null; sheet = "import";
    setTab("map");
    map.fitBounds(L.latLngBounds(list.map((d) => [d.lat, d.lng])), { padding: [30, 30] });
    renderAll();
  } catch (err) { toast(err.message); }
});

// Runs the county lookups end to end on one known house per county and shows what came back,
// so the setup can be checked from a phone.
async function testCounties() {
  const box = $("#county-test"); if (!box) return;
  if (!navigator.onLine) { box.innerHTML = `<div class="notice err">Needs signal.</div>`; return; }
  box.innerHTML = `<div class="notice">Checking the county parcel maps… this can take 30 seconds the first time.</div>`;
  const rows = [], report = {};
  const here = me || (map && { lat: map.getCenter().lat, lng: map.getCenter().lng });
  const tests = COUNTIES.map((c) => ({ c, pt: c.test, label: c.name }));
  if (here) { const c = COUNTIES.find((x) => { const [s0, w, n, e] = x.bbox; return here.lat >= s0 && here.lat <= n && here.lng >= w && here.lng <= e; }); if (c) tests.unshift({ c, pt: here, label: `Where you are (${c.name})` }); }
  for (const { c, pt, label } of tests) {
    try {
      const found = (propSettings.countyLayers?.[c.key]?.layers && propSettings.countyLayers[c.key]) || await discover(c);
      if (!found) { rows.push(`<div class="notice err"><strong>${esc(label)}</strong>: couldn't reach the county map or find parcel layers.</div>`); box.innerHTML = rows.join(""); continue; }
      propSettings.countyLayers = { ...(propSettings.countyLayers || {}), [c.key]: found };
      const info = await lookupCounty(c, found, pt.lat, pt.lng, titleCase, norm);
      const rk = label === c.name ? c.key : "here";
      report[rk] = { test: pt, result: info, picked: [], inventory: (found.inventory || []).slice(0, 80) };
      for (const l of found.layers.slice(0, 4)) {
        let sample = null; try { sample = await queryPoint(l, pt.lat, pt.lng); } catch (e) { sample = { error: e.message }; }
        report[rk].picked.push({ name: l.name, url: l.url, score: l.score, map: l.map, sample: sample && Object.fromEntries(Object.entries(sample).filter(([, v]) => v != null && v !== "" && String(v).trim() !== "")) });
      }
      const ok = info?.owner && (info?.home_value || c.key === "wyandotte");
      rows.push(`<div class="notice ${ok ? "" : "err"}"><strong>${esc(label)}</strong>: ${info ? `${esc(info.owner || "no owner")} · ${info.home_value ? money(info.home_value) : "no value"} · ${info.year_built || "no year"}` : "no parcel at the test point"}
        <br><span class="note">From: ${esc((info?.prop_layers || []).join(" + ") || "—")} · ${found.layers.length} layers checked</span></div>`);
    } catch (e) {
      rows.push(`<div class="notice err"><strong>${esc(label)}</strong>: ${esc(e.message)}</div>`);
    }
    box.innerHTML = rows.join("");
  }
  window.__countyReport = report;
  box.innerHTML = rows.join("") + `<button class="btn" data-g="copy-report">Copy report for Marcus</button>`;
  saveCountyLayers();
}
async function copyReport() {
  const txt = JSON.stringify(window.__countyReport || {}, null, 1);
  try { await navigator.clipboard.writeText(txt); toast("Report copied. Paste it to Marcus."); }
  catch {
    const ta = document.createElement("textarea"); ta.value = txt; ta.style.cssText = "width:100%;height:160px;font:11px var(--mono)";
    $("#county-test").appendChild(ta); ta.select(); toast("Select all and copy the text box.");
  }
}

/* ================= shell ================= */
function setTab(t) {
  tab = t;
  ["map", "leads", "today"].forEach((k) => { $("#v-" + k).hidden = k !== t; $("#t-" + k).setAttribute("aria-selected", k === t); });
  if (t !== "map") { sheet = null; draft = null; sel = null; }
  renderAll();
  if (t === "map") setTimeout(() => map?.invalidateSize(), 0);
}
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

function toast(m, canUndo) {
  $("#toast-msg").textContent = m; $("#toast-undo").hidden = !canUndo || !undo; $("#toast").hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { $("#toast").hidden = true; }, canUndo ? 6000 : 3000);
}
$("#toast-undo").addEventListener("click", async () => {
  if (!undo) return;
  const { before, visitId } = undo; undo = null;
  $("#toast").hidden = true;
  visits = visits.filter((v) => v.id !== visitId);
  await store.deleteVisit(visitId);
  await store.enqueue({ type: "visit_delete", id: visitId });
  await saveDoor(before);
  openPeek(before.id);
});

function renderAll() {
  renderShift(); renderFilters(); renderCtrls(); renderNext(); renderNet();
  if (mode === "list") renderWalk();
  renderSheet(); renderLeads(); renderToday();
}

sync.on("doors", (rows) => { rows.forEach((r) => { doors.set(r.id, r); if (sel && sel.id === r.id && sheet === "peek") sel = r; paintDoor(r); }); if (!draft) renderAll(); else { renderFilters(); renderLeads(); } });
sync.on("visits", async () => { visits = await store.allVisits(); renderShift(); renderToday(); });
sync.on("status", async () => { outboxN = await store.outboxCount(); renderNet(); });
window.addEventListener("online", renderNet);
window.addEventListener("offline", renderNet);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { sync.push().then(() => sync.pull()); renderShift(); } });

/* ================= boot ================= */
let booted = false;
async function afterSignIn() {
  const p = await sync.loadProfile().catch(() => null);
  let cached = ""; try { cached = localStorage.getItem("knock.repName") || ""; } catch {}
  const name = p?.name || (!navigator.onLine || !p ? cached : "");
  if (name) {
    rep = { id: sync.user.id, name };
    try { localStorage.setItem("knock.repName", name); } catch {}
    $("#gate").hidden = true; return boot();
  }
  rep.id = sync.user.id;
  showGate("name");
}
async function boot() {
  if (booted) { renderAll(); return; }
  booted = true;
  (await store.allDoors()).forEach((d) => doors.set(d.id, d));
  visits = await store.allVisits();
  outboxN = await store.outboxCount();
  try { propSettings.regridToken = localStorage.getItem("knock.regrid") || ""; propSettings.countyLayers = JSON.parse(localStorage.getItem("knock.countyLayers4") || "{}"); } catch {}
  initMap(); paintAll();
  const ds = [...doors.values()];
  if (ds.length && !me) map.fitBounds(L.latLngBounds(ds.map((d) => [d.lat, d.lng])).pad(0.1), { maxZoom: 17 });
  renderAll();
  startGps();
  if (sync.enabled && sync.user) {
    reps = await sync.reps().catch(() => []);
    const tok = await sync.getTeamSetting("regrid_token").catch(() => null);
    if (tok != null) { propSettings.regridToken = tok; try { localStorage.setItem("knock.regrid", tok); } catch {} }
    const layers = await sync.getTeamSetting("county_layers_v4").catch(() => null);
    if (layers) { try { propSettings.countyLayers = { ...JSON.parse(layers), ...propSettings.countyLayers }; localStorage.setItem("knock.countyLayers4", JSON.stringify(propSettings.countyLayers)); } catch {} }
    await sync.push(); await sync.pull(); sync.live();
    setInterval(() => sync.push().then(() => sync.pull()), 60000);
  }
  setInterval(renderShift, 30000);
}
(async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try { navigator.storage?.persist?.(); } catch {}
  const live = await sync.init();
  if (live) {
    if (!sync.user) return showGate("signin");
    return afterSignIn();
  }
  rep.name = (() => { try { return localStorage.getItem("knock.repName") || ""; } catch { return ""; } })();
  if (!rep.name) return showGate("name");
  boot();
})();
