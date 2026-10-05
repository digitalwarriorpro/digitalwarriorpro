// Team settings. Edit these, commit, and the app picks them up on next load.
// The Supabase anon key is safe to publish: row-level security in supabase/schema.sql
// limits every table to signed-in reps.
export const CONFIG = {
  // Shown on the sign-in, name and settings screens; keep in step with VERSION in sw.js
  appVersion: "18",
  // Supabase project (Project Settings → API). Leave blank to run in single-phone mode.
  supabaseUrl: "https://dwkayufjpthvovchvsta.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3a2F5dWZqcHRodm92Y2h2c3RhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3MTIwOTksImV4cCI6MjEwNjI4ODA5OX0.Vd596wo3PnPc14kqQCAK_h0EKh1jqUOVaR757xFeoA0",

  company: "Dano's Dents",
  // Shown in confirmation texts and calendar invites. Leave blank until the shop address is final.
  shopAddress: "",
  shopPhone: "",

  // Storm a door was worked under. Saved on every door for the master lead sheet.
  storms: ["2026-08-19", "2026-08-18", "2026-06-01", "2026-04-15", "2026-03-11", "2026-03-10"],

  // Inspection slots offered at the door: the next N days the shop is open, at these times.
  inspection: {
    daysAhead: 6,
    openDays: [1, 2, 3, 4, 5, 6], // 0 = Sunday
    times: ["09:00", "10:30", "12:00", "13:30", "15:00", "16:30"],
    minutes: 30,
  },
  timeZone: "America/Chicago",

  // Map tiles. OpenStreetMap's tiles are free for light use; for a bigger crew switch to a
  // provider with a key (MapTiler, Stadia, Mapbox) and paste its URL template here.
  tiles: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  // Kansas City metro
  startView: { lat: 38.99, lng: -94.63, zoom: 11 },

  // Address lookups (free OpenStreetMap services, fair-use limits apply)
  // Address servers, tried in order: the main one is often busy, so the app falls back to the mirrors
  overpassUrls: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ],
  nominatimUrl: "https://nominatim.openstreetmap.org/reverse",

  goals: { doors: 60, booked: 4 },

  // Free homeowner and home value lookups from Johnson, Wyandotte and Jackson county parcel maps.
  // Off for the first launch; set to true to turn the Homeowner card, filters and Settings section back on.
  countyRecords: false,

  // "$300K+ homes" filter on the map
  valueFilter: 300000,
};
