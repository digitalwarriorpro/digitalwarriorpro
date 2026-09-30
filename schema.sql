-- dtdcrm database schema (run in the Supabase SQL Editor)

create extension if not exists "pgcrypto";

do $$ begin
  create type prospect_stage as enum ('new', 'contacted', 'qualified', 'completed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type knock_outcome as enum ('no_answer', 'not_interested', 'callback', 'interested', 'sold');
exception when duplicate_object then null; end $$;

create table if not exists prospects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  email       text,
  address     text not null,
  lat         double precision,
  lng         double precision,
  stage       prospect_stage not null default 'new',
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists knocks (
  id           uuid primary key default gen_random_uuid(),
  prospect_id  uuid not null references prospects(id) on delete cascade,
  rep_id       text not null,
  outcome      knock_outcome not null,
  notes        text,
  lat          double precision,
  lng          double precision,
  created_at   timestamptz not null default now()
);

create table if not exists rep_locations (
  rep_id      text primary key,
  lat         double precision not null,
  lng         double precision not null,
  accuracy    double precision,
  updated_at  timestamptz not null default now()
);

create index if not exists knocks_prospect_id_idx on knocks(prospect_id);
create index if not exists prospects_stage_idx on prospects(stage);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists prospects_set_updated_at on prospects;
create trigger prospects_set_updated_at
  before update on prospects
  for each row execute function set_updated_at();

-- Only the backend (service role key, which bypasses RLS) touches these tables.
-- RLS with no policies blocks direct access with the public anon key.
alter table prospects enable row level security;
alter table knocks enable row level security;
alter table rep_locations enable row level security;
