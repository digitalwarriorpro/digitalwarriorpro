# DTD CRM

A door-to-door sales CRM: track prospects on a map, log door knocks, move leads through a
pipeline, and see field reps' live GPS positions.

**Start here:** [QUICKSTART.md](QUICKSTART.md)

## Stack
- **Backend:** Node 22, Express, Socket.io, Supabase (Postgres) via `@supabase/supabase-js`
- **Frontend:** React 18, Vite, Tailwind, Zustand, Leaflet (OpenStreetMap tiles, no API key)

## Layout
```
backend/src/app.js              Express + Socket.io server, loads ../.env.local
backend/src/middleware/auth.js  Optional Supabase JWT auth (REQUIRE_AUTH=true)
backend/src/api/routes.js       REST API
backend/src/socket/events.js    Live rep location events
backend/src/lib/supabase.js     Supabase client (service role key)
frontend/src/App.jsx            Sidebar: pipeline counts, prospect form/list, knock logging
frontend/src/components/MapComponent.jsx  Map of prospects, reps, and your position
frontend/src/store/store.js     Zustand store
frontend/src/socket/client.js   Socket.io client + GPS tracking
frontend/src/lib/api.js         REST client
schema.sql                      Database schema (run in Supabase SQL Editor)
```

In development Vite proxies `/api` and `/socket.io` to the backend on port 3000.

## Pipeline
`new → contacted → qualified → completed`

Logging a knock advances the stage (it never moves a prospect backward):

| Knock outcome | Stage becomes at least |
|---|---|
| no_answer, not_interested, callback | contacted |
| interested | qualified |
| sold | completed |

Stages can also be set by hand from the prospect view.

## REST API (`/api`)
| Method | Path | Description |
|---|---|---|
| GET | `/prospects?stage=` | List prospects, newest first |
| POST | `/prospects` | Create (`name`, `address` required; `phone`, `email`, `lat`, `lng`, `stage`, `notes`) |
| PATCH | `/prospects/:id` | Update any of the fields above |
| GET | `/prospects/:id/knocks` | Knock history for a prospect |
| POST | `/knocks` | Log a knock (`prospect_id`, `outcome`, optional `notes`, `lat`, `lng`) |
| GET | `/pipeline` | Prospect count per stage |
| GET | `/reps/locations` | Last known position of each rep |

`GET /health` returns `{ "ok": true }`.

## Socket.io events
| Event | Direction | Payload |
|---|---|---|
| `rep:location` | client → server → other clients | `{ lat, lng, accuracy }` (broadcast with `rep_id`) |
| `rep:offline` | server → clients | `{ rep_id }` |
| `prospect:created` / `prospect:updated` | server → clients | prospect row |
| `knock:created` | server → clients | knock row |

## Auth
With `REQUIRE_AUTH=false` (default) every request runs as a `dev-rep` user. Set it to `true`
to require a Supabase Auth access token (`Authorization: Bearer <jwt>`); the frontend has no
login screen yet, so that is the next step before real field use.

## Roadmap
- Supabase Auth login screen; use the signed-in user as the rep ID
- Address geocoding (currently you place prospects by clicking the map or using GPS)
- Territory assignment and turf-cutting
- Follow-up reminders for `callback` knocks
- Offline queue for knocks logged without signal
