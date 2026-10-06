-- Dano's Dents Knock: database health check. Changes nothing.
-- Supabase → SQL Editor → New query → paste all of this → Run. Every row should say PASS.
with
t(name) as (values ('reps'), ('doors'), ('visits'), ('app_settings'), ('jobs'), ('tasks'), ('notes')),
need_cols(col) as (values ('id'), ('lat'), ('lng'), ('address'), ('status'), ('attempts'), ('vehicles'), ('name'), ('phone'),
  ('email'), ('consent'), ('slot'), ('notes'), ('storm'), ('photos'), ('updated_by'), ('updated_by_name'), ('driveway'),
  ('owner'), ('home_value'), ('beds'), ('owner_hidden'), ('roof_squares'))
select "check", result, case when result = 'FAIL' or n >= 20 then fix else '' end as "fix / detail" from (
  select 1 as n, 'Table ' || t.name || ' exists' as "check",
    case when to_regclass('public.' || t.name) is not null then 'PASS' else 'FAIL' end as result,
    case when to_regclass('public.' || t.name) is null then 'Run reset_and_setup.sql' else '' end as fix
  from t
  union all
  select 2, 'Table ' || t.name || ' is locked to signed-in reps (row-level security)',
    case when coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t.name)), false) then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  from t
  union all
  select 3, 'Reps can read and write ' || t.name,
    case when to_regclass('public.' || t.name) is not null
      and has_table_privilege('authenticated', 'public.' || t.name, 'SELECT')
      and has_table_privilege('authenticated', 'public.' || t.name, 'INSERT')
      and has_table_privilege('authenticated', 'public.' || t.name, 'UPDATE') then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  from t
  union all
  select 4, 'Logged-out visitors cannot read ' || t.name,
    case when to_regclass('public.' || t.name) is null then 'FAIL'
      when not has_table_privilege('anon', 'public.' || t.name, 'SELECT')
        or not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.name and 'anon' = any (p.roles))
      then 'PASS' else 'FAIL' end,
    ''
  from t
  union all
  select 5, 'Security rules on ' || t.name,
    case when (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.name) > 0 then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  from t
  union all
  select 6, 'Doors table has all app fields',
    case when not exists (select 1 from need_cols c where not exists (
      select 1 from information_schema.columns i where i.table_schema = 'public' and i.table_name = 'doors' and i.column_name = c.col)) then 'PASS' else 'FAIL' end,
    coalesce('Missing: ' || (select string_agg(c.col, ', ') from need_cols c where not exists (
      select 1 from information_schema.columns i where i.table_schema = 'public' and i.table_name = 'doors' and i.column_name = c.col)) || '. Run reset_and_setup.sql', '')
  union all
  select 7, 'Rep check function (is_rep) works for signed-in users',
    case when to_regprocedure('public.is_rep()') is not null and has_function_privilege('authenticated', 'public.is_rep()', 'EXECUTE') then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  union all
  select 8, 'Server clock stamps every door change',
    case when exists (select 1 from pg_trigger where tgname = 'doors_touch' and not tgisinternal) then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  union all
  select 9, 'Live updates between phones: ' || x.name,
    case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = x.name) then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  from (values ('doors'), ('visits'), ('jobs'), ('tasks')) x(name)
  union all
  select 10, 'Damage photo storage (bucket "damage", private)',
    case when exists (select 1 from storage.buckets where id = 'damage' and not public) then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  union all
  select 11, 'Photo upload rules for reps',
    case when (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('damage_read', 'damage_write', 'damage_update')) = 3 then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  union all
  select 12, 'CRM views: leads and rep_activity',
    case when to_regclass('public.leads') is not null and to_regclass('public.rep_activity') is not null then 'PASS' else 'FAIL' end,
    'Run reset_and_setup.sql'
  union all
  select 20, 'Login: ' || u.email,
    case when u.email_confirmed_at is null then 'FAIL'
      when coalesce(u.encrypted_password, '') = '' then 'FAIL'
      else 'PASS' end,
    case when u.email_confirmed_at is null then 'Not confirmed: delete and re-add with Create new user + Auto Confirm User'
      when coalesce(u.encrypted_password, '') = '' then 'No password (was invited): delete and re-add with Create new user'
      else concat_ws(' · ',
        case when u.last_sign_in_at is null then 'never signed in' else 'last sign-in ' || to_char(u.last_sign_in_at at time zone 'America/Chicago', 'Mon DD HH12:MI am') end,
        case when to_regclass('public.reps') is not null then (select 'app name: ' || r.name from public.reps r where r.id = u.id) end) end
  from auth.users u
  union all
  select 30, 'Data so far',
    'INFO',
    format('%s reps · %s doors · %s knocks · %s leads/bookings',
      (select count(*) from public.reps), (select count(*) from public.doors), (select count(*) from public.visits),
      (select count(*) from public.doors where status in ('lead', 'booked')))
) r
order by n, "check";
