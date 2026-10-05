-- Dano's Dents Knock: team database.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to re-run.

-- Reps: one row per person, keyed by their Supabase Auth user id
create table if not exists public.reps (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Doors: one row per house, holding its latest state
create table if not exists public.doors (
  id text primary key,                 -- osm:node/123, csv:..., or pin:<uuid>
  lat double precision not null,
  lng double precision not null,
  address text not null default '',
  street text default '',
  city text default '',
  zip text default '',
  turf text default '',
  assigned_to text default '',
  status text not null default 'none' check (status in ('none','nothome','no','back','lead','booked','dnk')),
  attempts int not null default 0,
  hanger boolean not null default false,
  back_when text default '',
  reason text default '',
  vehicles jsonb not null default '[]',
  name text default '',
  phone text default '',
  email text default '',
  contact_pref text default 'Text',
  consent boolean not null default false,
  slot text,                           -- inspection slot, local time "2026-10-05T09:00"
  notes text default '',
  storm text default '',
  photos jsonb not null default '[]',  -- storage paths in the "damage" bucket
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text default ''
);
create index if not exists doors_updated_at on public.doors (updated_at);
create index if not exists doors_status on public.doors (status);
-- Slot double-booking is checked on the phone; two reps booking the same slot offline both save,
-- and both bookings show on the Leads tab so Dano can move one.
drop index if exists doors_one_booking_per_slot;

-- Visits: every knock, for history and the crew board
create table if not exists public.visits (
  id uuid primary key,
  door_id text not null references public.doors(id) on delete cascade,
  rep_id uuid,
  rep_name text default '',
  outcome text not null,
  at timestamptz not null default now(),
  details jsonb not null default '{}'
);
create index if not exists visits_at on public.visits (at);
create index if not exists visits_door on public.visits (door_id);

-- Server clock decides updated_at so phones with a wrong clock still sync correctly
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists doors_touch on public.doors;
create trigger doors_touch before insert or update on public.doors for each row execute function public.touch_updated_at();

-- Only signed-in, active reps can read or write anything
create or replace function public.is_rep() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reps where id = auth.uid() and active)
$$;

alter table public.reps enable row level security;
alter table public.doors enable row level security;
alter table public.visits enable row level security;

drop policy if exists reps_read on public.reps;
create policy reps_read on public.reps for select to authenticated using (true);
drop policy if exists reps_self on public.reps;
create policy reps_self on public.reps for insert to authenticated with check (id = auth.uid());
drop policy if exists reps_self_update on public.reps;
create policy reps_self_update on public.reps for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists doors_all on public.doors;
create policy doors_all on public.doors for all to authenticated using (public.is_rep()) with check (public.is_rep());

drop policy if exists visits_all on public.visits;
create policy visits_all on public.visits for all to authenticated using (public.is_rep()) with check (public.is_rep());

-- Live updates between phones
do $$ begin
  alter publication supabase_realtime add table public.doors;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.visits;
exception when duplicate_object then null; end $$;

-- Damage photos (private bucket, reps only)
insert into storage.buckets (id, name, public) values ('damage', 'damage', false) on conflict (id) do nothing;
drop policy if exists damage_read on storage.objects;
create policy damage_read on storage.objects for select to authenticated using (bucket_id = 'damage' and public.is_rep());
drop policy if exists damage_write on storage.objects;
create policy damage_write on storage.objects for insert to authenticated with check (bucket_id = 'damage' and public.is_rep());
drop policy if exists damage_update on storage.objects;
create policy damage_update on storage.objects for update to authenticated using (bucket_id = 'damage' and public.is_rep());

-- Homeowner and home value (county records via Regrid or a CSV import)
alter table public.doors add column if not exists owner text default '';
alter table public.doors add column if not exists owner_occupied boolean;
alter table public.doors add column if not exists mailing_address text default '';
alter table public.doors add column if not exists home_value numeric;
alter table public.doors add column if not exists value_type text default '';
alter table public.doors add column if not exists year_built int;
alter table public.doors add column if not exists sqft int;
alter table public.doors add column if not exists last_sale_date text default '';
alter table public.doors add column if not exists last_sale_price numeric;
alter table public.doors add column if not exists parcel_id text default '';
alter table public.doors add column if not exists land_use text default '';
alter table public.doors add column if not exists prop_source text default '';
alter table public.doors add column if not exists prop_checked_at timestamptz;

-- Team-wide settings, such as the property data key (readable by reps only, never in the published code)
create table if not exists public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_all on public.app_settings;
create policy app_settings_all on public.app_settings for all to authenticated using (public.is_rep()) with check (public.is_rep());

-- Cars seen from the street before knocking: {count, types[], at, by}
alter table public.doors add column if not exists driveway jsonb;

-- County record extras
alter table public.doors add column if not exists beds int;
alter table public.doors add column if not exists owner_hidden boolean;
