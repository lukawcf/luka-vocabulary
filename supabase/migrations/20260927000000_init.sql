-- Luka Vocabulary: per-user progress, word order and AI usage.
-- Users need no sign-up: the page signs in anonymously (Supabase anonymous sign-ins), which still
-- gives every visitor their own user id; binding an email later keeps the same id.
-- Every table is keyed by user_id and protected by row level security, so each user
-- can only read and write their own rows. AI usage is written only by the judge function
-- (service role); users may read their own usage.

-- One row per user: word order (their shuffled word list), extra words, today's plan, bonus batch.
create table public.user_state (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  word_order  text[]      not null default '{}',
  extra_words jsonb       not null default '[]'::jsonb,   -- [{w, m}] words outside the built-in list
  plan        jsonb,
  bonus       jsonb,
  updated_at  timestamptz not null default now()
);

-- One row per user per learned word: the spaced-repetition card (interval, ease, due day,
-- sentences that earned a flower, ...). updated_at mirrors card.u and decides merges.
create table public.user_cards (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  word       text        not null check (char_length(word) between 1 and 60),
  card       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, word)
);

-- One row per AI judgement, for the daily per-user limit and the monthly budget.
create table public.ai_usage (
  id                bigint generated always as identity primary key,
  user_id           uuid        not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null default now(),
  prompt_tokens     int         not null default 0,
  completion_tokens int         not null default 0,
  cost_usd          numeric(12, 8) not null default 0,
  ip_hash           text        -- salted SHA-256 of the caller's IP, for the per-IP daily limit
);
create index ai_usage_user_day on public.ai_usage (user_id, created_at);
create index ai_usage_created on public.ai_usage (created_at);
create index ai_usage_ip_day on public.ai_usage (ip_hash, created_at);

alter table public.user_state enable row level security;
alter table public.user_cards enable row level security;
alter table public.ai_usage   enable row level security;

create policy "own state"  on public.user_state for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own cards"  on public.user_cards for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "read own usage" on public.ai_usage for select to authenticated
  using ((select auth.uid()) = user_id);
-- no insert/update/delete policy on ai_usage: only the service role (judge function) writes it

-- Today's count for one user and for one IP (UTC day), and this month's total spend across everyone.
-- The IP count stops people from clearing the browser to get a fresh anonymous account and quota.
-- Called by the judge function with the service role; not exposed to users.
create or replace function public.usage_status(uid uuid, iph text)
returns table (today_count int, ip_today int, month_cost numeric)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from ai_usage
      where user_id = uid and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'),
    (select count(*)::int from ai_usage
      where ip_hash = iph and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'),
    (select coalesce(sum(cost_usd), 0) from ai_usage
      where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc');
$$;
revoke all on function public.usage_status(uuid, text) from public, anon, authenticated;
