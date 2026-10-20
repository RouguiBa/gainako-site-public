create table if not exists public.fields (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  center_lat double precision not null check (center_lat between -90 and 90),
  center_lng double precision not null check (center_lng between -180 and 180),
  boundary jsonb not null check (jsonb_typeof(boundary) = 'array'),
  created_at timestamptz not null default now()
);

create table if not exists public.field_members (
  field_id uuid not null references public.fields(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (field_id, user_id)
);

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references public.fields(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  category text not null check (category in ('culture', 'batiment', 'eau', 'travaux', 'observation')),
  date date not null,
  description text not null default '' check (char_length(description) <= 500),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists observations_field_date_idx
  on public.observations (field_id, date desc);

create or replace function public.has_field_access(target_field_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.field_members
    where field_id = target_field_id
      and user_id = (select auth.uid())
  );
$$;

revoke all on function public.has_field_access(uuid) from public, anon;
grant execute on function public.has_field_access(uuid) to authenticated;

alter table public.fields enable row level security;
alter table public.field_members enable row level security;
alter table public.observations enable row level security;

revoke all on public.fields, public.field_members, public.observations from anon, authenticated;
grant select on public.fields to authenticated;
grant update (boundary) on public.fields to authenticated;
grant select on public.field_members to authenticated;
grant select, insert, update, delete on public.observations to authenticated;

drop policy if exists "Members can view their fields" on public.fields;
create policy "Members can view their fields"
  on public.fields for select to authenticated
  using (public.has_field_access(id));

drop policy if exists "Members can update their fields" on public.fields;
create policy "Members can update their fields"
  on public.fields for update to authenticated
  using (public.has_field_access(id))
  with check (public.has_field_access(id));

drop policy if exists "Users can view their memberships" on public.field_members;
create policy "Users can view their memberships"
  on public.field_members for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Members can view field observations" on public.observations;
create policy "Members can view field observations"
  on public.observations for select to authenticated
  using (public.has_field_access(field_id));

drop policy if exists "Members can add field observations" on public.observations;
create policy "Members can add field observations"
  on public.observations for insert to authenticated
  with check (
    public.has_field_access(field_id)
    and created_by = (select auth.uid())
  );

drop policy if exists "Members can update field observations" on public.observations;
create policy "Members can update field observations"
  on public.observations for update to authenticated
  using (public.has_field_access(field_id))
  with check (public.has_field_access(field_id));

drop policy if exists "Members can delete field observations" on public.observations;
create policy "Members can delete field observations"
  on public.observations for delete to authenticated
  using (public.has_field_access(field_id));
