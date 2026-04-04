create table if not exists public.workspaces (
  id text primary key,
  name text not null,
  primary_contact text not null,
  billing_email text not null,
  plan text not null,
  monthly_budget_usd double precision not null default 0,
  seats_used integer not null default 0,
  seats_total integer not null default 0,
  region text not null default 'Unspecified',
  renewal_date text not null default '',
  operating_cadence text not null default '',
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.policies (
  id text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null,
  scope text not null,
  owner text not null,
  status text not null,
  monthly_budget_usd double precision not null default 0,
  max_iterations integer not null default 0,
  fallback_model text not null,
  alert_threshold_pct double precision not null default 0,
  auto_stop_after_minutes integer not null default 0,
  description text not null,
  provenance text not null default 'workspace_policy',
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create table if not exists public.runs (
  run_id text primary key,
  workspace_id text not null,
  project_id text not null,
  title text not null,
  objective text not null,
  repo_root text,
  status text not null,
  lifecycle_state text not null,
  stop_reason text,
  active_model text,
  adapter_id text,
  provider_id text,
  transport text,
  actual_usd double precision not null default 0,
  estimated_usd double precision not null default 0,
  cost_provenance text not null default 'unavailable',
  modeled_avoided_usd double precision not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  attempts_count integer not null default 0,
  kept_attempts integer not null default 0,
  discarded_attempts integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists public.attempts (
  run_id text not null references public.runs(run_id) on delete cascade,
  attempt_index integer not null,
  adapter_id text,
  provider_id text,
  model text,
  transport text,
  status text,
  summary text,
  failure_class text,
  intervention text,
  verifier_passed boolean,
  verification_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  primary key (run_id, attempt_index)
);

create table if not exists public.events (
  event_id text primary key,
  run_id text not null references public.runs(run_id) on delete cascade,
  attempt_index integer,
  kind text not null,
  lifecycle_state text,
  timestamp timestamptz not null,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists public.violations (
  violation_id text primary key,
  run_id text not null references public.runs(run_id) on delete cascade,
  attempt_index integer,
  surface text not null,
  blocked boolean not null default true,
  violation_kind text not null,
  detail text not null,
  created_at timestamptz not null
);

create table if not exists public.budget_metrics (
  metric_id text primary key,
  run_id text not null references public.runs(run_id) on delete cascade,
  attempt_index integer not null,
  actual_usd double precision not null default 0,
  estimated_usd double precision not null default 0,
  provenance text not null default 'unavailable',
  patch_cost_usd double precision not null default 0,
  verification_cost_usd double precision not null default 0,
  variance_usd double precision not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  created_at timestamptz not null
);

create index if not exists idx_runs_workspace_updated
  on public.runs (workspace_id, updated_at desc);

create index if not exists idx_events_run_timestamp
  on public.events (run_id, timestamp desc);

create index if not exists idx_violations_run_surface
  on public.violations (run_id, surface);

create index if not exists idx_budget_metrics_run_attempt
  on public.budget_metrics (run_id, attempt_index);
