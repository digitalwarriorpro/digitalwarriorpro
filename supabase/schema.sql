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

-- Table access for the app. Newer Supabase projects don't grant this automatically for tables
-- made in the SQL Editor; row-level security above still decides which rows a rep can touch.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.reps, public.doors, public.visits, public.app_settings to authenticated;
grant execute on function public.is_rep() to authenticated;

-- CRM views for Dano: each rep's activity by day here; the leads list is defined with the office CRM tables below.
-- security_invoker keeps the same row-level security as the tables.
create or replace view public.rep_activity with (security_invoker = true) as
select
  (v.at at time zone 'America/Chicago')::date as day,
  v.rep_name as rep,
  count(*) as knocks,
  count(*) filter (where v.outcome = 'nothome') as not_home,
  count(*) filter (where v.outcome = 'no') as no,
  count(*) filter (where v.outcome = 'back') as come_back,
  count(*) filter (where v.outcome = 'lead') as leads,
  count(*) filter (where v.outcome = 'booked') as booked,
  min(v.at at time zone 'America/Chicago')::time(0) as first_knock,
  max(v.at at time zone 'America/Chicago')::time(0) as last_knock
from public.visits v
group by 1, 2
order by 1 desc, booked desc, knocks desc;

grant select on public.rep_activity to authenticated;

-- Roof size estimate (roofing version): from the map's building outline
alter table public.doors add column if not exists roof_base_sqft numeric;
alter table public.doors add column if not exists roof_footprint_sqft int;
alter table public.doors add column if not exists roof_sqft int;
alter table public.doors add column if not exists roof_squares numeric;
alter table public.doors add column if not exists roof_pitch int;
alter table public.doors add column if not exists roof_source text default '';
alter table public.doors add column if not exists roof_building_id text default '';
alter table public.doors add column if not exists roof_checked_at timestamptz;

-- Office CRM: jobs (pipeline stage, value, insurance claim), tasks and notes.
-- Kept apart from doors so a rep's phone syncing an older copy of a door never overwrites office edits.
create table if not exists public.jobs (
  door_id text primary key references public.doors(id) on delete cascade,
  stage text not null default 'new',
  value numeric,
  deductible numeric,
  insurer text default '',
  claim_number text default '',
  adjuster text default '',
  adjuster_phone text default '',
  assigned_to text default '',
  next_step text default '',
  next_step_due date,
  lost_reason text default '',
  stage_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_name text default ''
);
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  door_id text references public.doors(id) on delete cascade,
  title text not null,
  due date,
  done boolean not null default false,
  assigned_to text default '',
  created_by_name text default '',
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists tasks_open on public.tasks (done, due);
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  door_id text not null references public.doors(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note','call','text','email')),
  body text not null,
  by_name text default '',
  at timestamptz not null default now()
);
create index if not exists notes_door on public.notes (door_id, at);

drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before insert or update on public.jobs for each row execute function public.touch_updated_at();

alter table public.jobs enable row level security;
alter table public.tasks enable row level security;
alter table public.notes enable row level security;
drop policy if exists jobs_all on public.jobs;
create policy jobs_all on public.jobs for all to authenticated using (public.is_rep()) with check (public.is_rep());
drop policy if exists tasks_all on public.tasks;
create policy tasks_all on public.tasks for all to authenticated using (public.is_rep()) with check (public.is_rep());
drop policy if exists notes_all on public.notes;
create policy notes_all on public.notes for all to authenticated using (public.is_rep()) with check (public.is_rep());
grant select, insert, update, delete on public.jobs, public.tasks, public.notes to authenticated;

do $$ begin alter publication supabase_realtime add table public.jobs; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.tasks; exception when duplicate_object then null; end $$;

-- The leads view now carries the office pipeline stage and job value
drop view if exists public.leads;
create view public.leads with (security_invoker = true) as
select
  coalesce(j.stage, case d.status when 'booked' then 'booked' else 'new' end) as stage,
  case d.status when 'booked' then 'Booked' when 'lead' then 'Lead' when 'back' then 'Come back' else d.status end as field_outcome,
  d.slot as inspection,
  d.name as customer, d.phone, d.email, d.contact_pref, d.consent as ok_to_text,
  d.address, d.city, d.zip,
  jsonb_array_length(d.vehicles) as vehicles,
  (select string_agg(concat_ws(' · ', nullif(v->>'ymm', ''), nullif((select string_agg(p, ', ') from jsonb_array_elements_text(coalesce(v->'panels', '[]')) p), ''), nullif(v->>'sev', '')), '; ')
     from jsonb_array_elements(d.vehicles) v) as damage,
  coalesce(nullif(j.insurer, ''), (select string_agg(distinct v->>'insurer', ', ') from jsonb_array_elements(d.vehicles) v where coalesce(v->>'insurer', '') <> '')) as insurer,
  j.claim_number, j.value as job_value, j.next_step, j.next_step_due,
  d.back_when, d.notes, d.storm, d.turf,
  d.updated_by_name as rep, greatest(d.updated_at, j.updated_at) as last_update, d.id as door_id
from public.doors d
left join public.jobs j on j.door_id = d.id
where d.status in ('booked', 'lead', 'back') or j.door_id is not null
order by (d.status = 'booked') desc, d.updated_at desc;
grant select on public.leads to authenticated;

-- Estimates and invoices (office). One row per document; line items and payments as JSON.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  door_id text not null references public.doors(id) on delete cascade,
  kind text not null check (kind in ('estimate','invoice')),
  number text not null,
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined','partial','paid','void')),
  issued date not null default current_date,
  due date,
  lines jsonb not null default '[]',      -- [{desc, qty, price}]
  discount numeric not null default 0,
  tax_rate numeric not null default 0,    -- percent
  deductible numeric,                     -- customer's share when insurance pays the rest
  payments jsonb not null default '[]',   -- [{date, amount, method, note}]
  notes text default '',
  terms text default '',
  from_estimate uuid,
  created_by_name text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_door on public.documents (door_id);
create unique index if not exists documents_number on public.documents (kind, number);
drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before insert or update on public.documents for each row execute function public.touch_updated_at();
alter table public.documents enable row level security;
drop policy if exists documents_all on public.documents;
create policy documents_all on public.documents for all to authenticated using (public.is_rep()) with check (public.is_rep());
grant select, insert, update, delete on public.documents to authenticated;
do $$ begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end $$;
