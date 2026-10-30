-- IMCO Sklad – schéma databáze pro Supabase.
-- Spusť celé v Supabase: SQL Editor → New query → vložit → Run.

create table if not exists public.products  (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.movements (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.orders    (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.settings  (id text primary key, data jsonb,          updated_at timestamptz not null default now());

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ declare t text;
begin
  foreach t in array array['products','movements','orders','settings'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- Přístup mají jen přihlášení uživatelé (kancl + skladníci). Účty založíš v Authentication → Users → Add user.
alter table public.products  enable row level security;
alter table public.movements enable row level security;
alter table public.orders    enable row level security;
alter table public.settings  enable row level security;

do $$ declare t text;
begin
  foreach t in array array['products','movements','orders','settings'] loop
    execute format('drop policy if exists "auth all" on public.%I', t);
    execute format('create policy "auth all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Živé aktualizace (mobil uvidí novou objednávku z kanclu okamžitě).
do $$ begin
  alter publication supabase_realtime add table public.products;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.movements;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null; end $$;
