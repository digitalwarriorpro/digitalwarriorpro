# Dano's Dents Knock

A phone app for door-to-door hail canvassing. Reps see every door on a real map with their GPS position,
log each knock in a few taps, book inspections, and text the customer from their own phone.
Everything saves on the phone first, so it keeps working with no signal and syncs when signal returns.

It is a static web app (no server) backed by a free Supabase project. Reps install it from the browser
to their home screen.

## Go-live checklist

### 1. Team database: Supabase (about 15 minutes)

1. Create a free project at [supabase.com](https://supabase.com). Region: US Central or US East.
2. **SQL Editor → New query**: paste all of [`../supabase/schema.sql`](../supabase/schema.sql) and click **Run**.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up". Only people you add can sign in.
4. **Authentication → Emails → Magic Link** template: replace the body with:
   ```html
   <h2>Your Knock sign-in code</h2>
   <p style="font-size:28px;letter-spacing:4px"><strong>{{ .Token }}</strong></p>
   ```
   The app signs in with this 6-digit code instead of a link, because a link opens in the browser
   instead of the installed home-screen app.
5. **Authentication → Users → Add user → Create new user** for each rep (Dano, Michael, Kevin, Katie).
   Enter their email, any password, and tick **Auto Confirm User**.
6. **Project Settings → API**: copy the **Project URL** and the **anon public** key into
   [`js/config.js`](js/config.js) (`supabaseUrl`, `supabaseAnonKey`). The anon key is meant to be public;
   the database only lets signed-in reps read or write.

Supabase's built-in email sender only sends a few emails per hour. That's enough for a 4-person crew
signing in once each (they stay signed in), but before the crew grows, add your Google Workspace
mailbox under **Authentication → Emails → SMTP Settings**.

### 2. Hosting: GitHub Pages (about 5 minutes)

1. In this repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Environments → github-pages → Deployment branches**: add `claude/friendly-hypatia-774nob`
   (or merge this branch into `main`).
3. Push any change under `app/`, or run the **Deploy Knock app** workflow by hand. The app is served at
   `https://digitalwarriorpro.github.io/digitalwarriorpro/`.

Optional: point `knock.danosdents.com` at it under **Settings → Pages → Custom domain**.

### 3. Homeowner and home value lookups (free for Johnson, Wyandotte and Jackson counties)

**Off for the first launch.** Set `countyRecords: true` in [`js/config.js`](js/config.js) to turn the Homeowner
card, the owner/value filters and the Settings section back on.

Owner names, owner-lives-here vs. likely rental, home value, year built, square feet and last sale come
straight from the counties' own public parcel maps:

| County | What's free | Source layer |
| --- | --- | --- |
| Jackson County, MO | Owner, mailing address (owner lives here or not), current market value, land use, year built, living sq ft, bedrooms | `Parcel_Information` (current tax roll) + `Parcels_Market_Value` on the county's ArcGIS Online |
| Wyandotte County, KS | Owner, address, land use, vacant flag. No values or year built are published. | `GISPUB/UGMAPS_4_V02` Parcels |
| Johnson County, KS | Owner, mailing address (owner lives here or not), value, year built, land use, **only in Prairie Village, Mission and Spring Hill**. The countywide property map isn't public. | City parcel maps on `maps.jocogov.org` |

For the rest of Johnson County, import the county's parcel CSV (AIMS sells/offers parcel data) or add a Regrid key.
Owners who asked the county to hide their name show as "Name withheld by the county".

Each county names its layers and fields differently, so the first lookup in each county finds the parcel
layer and its owner/value fields on its own and remembers them for the whole team.

**Check it once from a phone:** tap your name → **Test county records**. Each county should show a real
owner name, a value and a year built. A red line means the county server refused the app or didn't expose
owners; send a screenshot to Marcus. A county's layer and field names can be pinned in `js/county.js`
if they ever change.

After that, opening a door looks it up automatically, once, and shares the result with the team.
**Look up doors on screen** does a whole block at once (up to 250 doors per tap).

**Other counties** (Clay, Platte, Cass, Leavenworth…): either paste a [Regrid](https://regrid.com) API
token under Settings (paid; used only outside the three free counties), or import that county's parcel
CSV under **Add doors from a list**. Columns it reads: `owner`, `mailing address`, `home value`
(or `appraised value` / `market value`), `year built`, `sqft`, `sale date`, `sale price`, `parcel`.

### 4. Shop details (2 minutes)

In [`js/config.js`](js/config.js), fill in `shopAddress` and `shopPhone` (they go into confirmation
texts and calendar invites), check the `storms` list and the inspection `times`, and commit.

### 5. On each phone (2 minutes per rep)

1. Open the app link in **Safari** (iPhone) or **Chrome** (Android).
2. **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android), then open it from the home screen.
3. Allow location, enter the email Dano added, and type in the 6-digit code from the email.

### 6. Before heading out (on Wi-Fi)

1. Zoom the map to the turf (a few blocks at a time) and tap the **house** button to load every address on
   screen. Name the turf and assign it to a rep.
2. Pan over the whole turf once. The map saves the streets you've looked at, so they still show with no signal.

## How reps use it

- **Next door**: the yellow bar always points at the nearest unknocked door on your turf.
- **Tap a door**: *Not home* (one tap, logs a door hanger, jumps to the next door), *No soliciting*
  (skips it from now on), or *Someone answered*.
- **Someone answered** walks through the pitch and objection answers, vehicles and damaged panels,
  photos, the outcome, and contact details. Booking shows open inspection slots; taken ones are crossed out.
- After a booking or lead: **Text confirmation**, **Call** or **Add to calendar**, each one tap from the porch.
  Texts go from the rep's own phone with the message already written.
- **+** drops a door by hand at the circle in the middle of the map, for houses the address data misses.
- **Homeowner** card on each door: owner on record, whether the owner lives there or it's likely a rental
  (mail goes to another address), home value, year built, square feet and last sale. The Contact step offers
  **Use owner on record** to fill the name. Filters: **Owner lives here** and **$300K+ homes**
  (threshold in `config.js → valueFilter`). Lead exports include all of it.
- **Cars outside**: before knocking, tap how many cars are in the driveway (0, 1, 2, 3+) and what kind
  (Truck, SUV, Car, Van). It saves right away, shows on the Nearby list, and the **Cars outside** filter
  finds houses with vehicles to inspect. When someone answers, the Vehicles step starts with one card per car seen.
- **VIN lookup**: type the 17-character VIN (bottom of the windshield, driver's side, or the door-jamb sticker)
  and tap **Look up**. NHTSA's free database fills in year, make, model and trim, and lists recalls on file for
  that model year. The app catches typos (wrong length, I/O/Q, bad check digit). Needs signal; the VIN is
  saved either way.
- **Undo** appears for 6 seconds after every save.
- **Leads** lists bookings, quotes and come-backs (yours or the whole team's) and exports a CSV for the
  master lead sheet. **Today** shows your doors, bookings, rate per hour and the crew board.
- **Settings** (tap your name): sync status, sign out, and **Add doors from a list** for CSV files with
  `address,lat,lng` columns (county parcel exports, Hail Recon lists).

## Limits to know

- **Addresses** come from OpenStreetMap. Most of Johnson County and KC proper have house numbers there;
  some newer subdivisions don't. Use **+** or a CSV for those.
- **Map tiles** come from OpenStreetMap's free servers, which allow light use like a small crew. If the crew
  grows past a handful of reps, get a free MapTiler or Stadia key and paste its URL into `config.js → tiles`.
- **Automatic texts** (reminders the business sends, not the rep) need a texting service such as Twilio plus
  carrier registration (A2P 10DLC), which takes 1–3 weeks to approve. Until then, texts go from the rep's phone.
- **Calendar**: *Add to calendar* opens Google Calendar with the inspection filled in. Sign the phone into the
  shop's Google account if bookings should land on the shared calendar.
- **Owner info is county data**: it can be months out of date, and whoever answers may not be the owner.
  Use it to know who you're likely talking to, not to greet people by a name you haven't confirmed.
- **Double-booking**: the app hides taken slots, but two reps booking the same slot while both offline will
  both save. Both show on the Leads tab.

## Files

```
index.html, styles.css     App shell and styles
js/main.js                 Map, knock flow, leads, today, settings
js/store.js                On-phone database (IndexedDB) and outbox
js/sync.js                 Supabase sign-in, push/pull, live updates
js/addresses.js            OpenStreetMap address lookups and CSV import/export
js/vehicles.js             VIN check digit, NHTSA VIN decode and recall lookups
js/county.js               Free county parcel lookups (Johnson, Wyandotte, Jackson): layer discovery and field mapping
js/property.js             Lookup routing (county first, Regrid fallback) and county CSV columns
js/config.js               Team settings (Supabase keys, shop, storms, slots, tiles)
sw.js, manifest.webmanifest  Offline support and home-screen install
vendor/                    Leaflet 1.9.4 and supabase-js 2.45.4, bundled so the app never depends on a CDN
../supabase/schema.sql     Database tables, security rules, photo storage
```

To run it locally: `npx http-server app -p 8080`, then open `http://localhost:8080`. Without Supabase keys it
runs in single-phone mode, with everything kept on that device.
