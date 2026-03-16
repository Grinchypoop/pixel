-- Users table
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  api_key text unique not null default replace(gen_random_uuid()::text, '-', ''),
  plan text not null default 'free', -- free | starter | pro | database
  builds_this_month int not null default 0,
  total_builds int not null default 0,
  billing_cycle_start timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Builds table
create table if not exists builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  session_id text not null,
  status text not null default 'running', -- running | done | error
  deploy_url text,
  expires_at timestamptz, -- null = permanent, set for free tier (5 days)
  created_at timestamptz not null default now()
);

-- RPC to safely increment build counts
create or replace function increment_build_counts(user_id_input uuid)
returns void as $$
  update users
  set builds_this_month = builds_this_month + 1,
      total_builds = total_builds + 1
  where id = user_id_input;
$$ language sql;

-- Index for fast API key lookups
create index if not exists users_api_key_idx on users(api_key);
create index if not exists builds_session_id_idx on builds(session_id);
create index if not exists builds_expires_at_idx on builds(expires_at);
