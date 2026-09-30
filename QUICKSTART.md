# Quick start

## 1. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) and create a free project (takes 2–5 min to initialize).
2. **Project Settings → API**: copy the **Project URL** and the **service_role** key.
   The backend is the only thing that talks to the database, so it uses the service role key.
   Never put that key in frontend code.

## 2. Import the schema
1. In the Supabase dashboard open **SQL Editor → New query**.
2. Paste the full contents of `schema.sql` and click **Run**. It is safe to run again.
3. Check **Database → Tables**: you should see `prospects`, `knocks` and `rep_locations`.

## 3. Configure
```bash
cp .env.example .env.local
# edit .env.local: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

## 4. Install and run
```bash
npm install --prefix backend
npm install --prefix frontend

# Terminal 1
cd backend && npm run dev      # 🚀 Server running on port 3000

# Terminal 2
cd frontend && npm run dev     # ➜ Local: http://localhost:5173
```

Open http://localhost:5173 and allow location access when the browser asks.

Or run both with Docker: `docker compose up --build`.

## What to try
1. Click the map (or **Use my GPS**) to place a prospect, fill in name + address, **Add prospect**.
2. Click a prospect to open it and **Log a knock**. Outcomes move the pipeline forward
   automatically: any knock → *contacted*, *interested* → *qualified*, *sold* → *completed*.
3. Open the app in a second tab or device: new prospects, stage changes and rep positions show up live.
