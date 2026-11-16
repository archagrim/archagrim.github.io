-- ============================================================
--  L'Œil du Patron : comptes joueurs, scores et classement
--  À coller UNE FOIS dans Supabase → SQL Editor → New query → Run.
--  Le script peut être relancé sans risque (il ne supprime rien).
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.patron_players (
  id         uuid primary key default gen_random_uuid(),
  pseudo     text not null,
  pseudo_lc  text not null unique,
  pass_hash  text not null,               -- mot de passe haché (bcrypt), jamais en clair
  created_at timestamptz not null default now()
);

create table if not exists public.patron_sessions (
  token      uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.patron_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create table if not exists public.patron_scores (
  id         bigint generated always as identity primary key,
  player_id  uuid not null references public.patron_players(id) on delete cascade,
  mode       text not null check (mode in ('normal','hard','night','duo_normal','duo_hard','duo_night')),
  score      integer not null check (score between 0 and 5000000),
  days       smallint not null check (days between 0 and 5),
  won        boolean not null default false,
  partner    text,
  created_at timestamptz not null default now()
);
create index if not exists patron_scores_mode_score on public.patron_scores (mode, score desc);
create index if not exists patron_scores_player on public.patron_scores (player_id, created_at desc);

-- Personne ne lit ni n'écrit ces tables directement : tout passe par les fonctions ci-dessous.
alter table public.patron_players  enable row level security;
alter table public.patron_sessions enable row level security;
alter table public.patron_scores   enable row level security;
revoke all on public.patron_players, public.patron_sessions, public.patron_scores from anon, authenticated;

-- ---------- Créer un compte ----------
create or replace function public.patron_register(p_pseudo text, p_password text)
returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_pseudo text := btrim(coalesce(p_pseudo, ''));
  v_id     uuid;
  v_token  uuid;
begin
  if char_length(v_pseudo) < 3 or char_length(v_pseudo) > 16 or v_pseudo ~ '[<>&"\\]' then
    raise exception 'PSEUDO_INVALIDE';
  end if;
  if char_length(coalesce(p_password, '')) < 4 or char_length(p_password) > 72 then
    raise exception 'MDP_INVALIDE';
  end if;
  if exists (select 1 from patron_players where pseudo_lc = lower(v_pseudo)) then
    raise exception 'PSEUDO_PRIS';
  end if;
  begin
    insert into patron_players (pseudo, pseudo_lc, pass_hash)
    values (v_pseudo, lower(v_pseudo), crypt(p_password, gen_salt('bf', 8)))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'PSEUDO_PRIS';
  end;
  insert into patron_sessions (player_id) values (v_id) returning token into v_token;
  return json_build_object('token', v_token, 'pseudo', v_pseudo);
end $$;

-- ---------- Se connecter ----------
create or replace function public.patron_login(p_pseudo text, p_password text)
returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v       patron_players;
  v_token uuid;
begin
  select * into v from patron_players where pseudo_lc = lower(btrim(coalesce(p_pseudo, '')));
  if not found or v.pass_hash <> crypt(coalesce(p_password, ''), v.pass_hash) then
    perform pg_sleep(0.4);
    raise exception 'IDENTIFIANTS_INCORRECTS';
  end if;
  delete from patron_sessions where player_id = v.id and last_seen < now() - interval '60 days';
  insert into patron_sessions (player_id) values (v.id) returning token into v_token;
  return json_build_object('token', v_token, 'pseudo', v.pseudo);
end $$;

-- ---------- Vérifier une session (reconnexion automatique) ----------
create or replace function public.patron_me(p_token uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_pseudo text;
begin
  update patron_sessions s set last_seen = now()
    from patron_players p
   where s.token = p_token and p.id = s.player_id
  returning p.pseudo into v_pseudo;
  if v_pseudo is null then raise exception 'SESSION_EXPIREE'; end if;
  return json_build_object('pseudo', v_pseudo);
end $$;

-- ---------- Se déconnecter ----------
create or replace function public.patron_logout(p_token uuid)
returns void
language sql security definer set search_path = public
as $$ delete from patron_sessions where token = p_token $$;

-- ---------- Enregistrer un score ----------
create or replace function public.patron_submit_score(
  p_token uuid, p_mode text, p_score integer, p_days integer, p_won boolean, p_partner text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_pid  uuid;
  v_best integer;
  v_rank bigint;
begin
  select player_id into v_pid from patron_sessions where token = p_token;
  if v_pid is null then raise exception 'SESSION_EXPIREE'; end if;
  if exists (select 1 from patron_scores where player_id = v_pid and created_at > now() - interval '20 seconds') then
    raise exception 'TROP_RAPIDE';
  end if;
  insert into patron_scores (player_id, mode, score, days, won, partner)
  values (v_pid, p_mode, p_score, p_days, p_won, left(nullif(btrim(coalesce(p_partner, '')), ''), 16));
  select max(score) into v_best from patron_scores where player_id = v_pid and mode = p_mode;
  select count(*) + 1 into v_rank
    from (select player_id, max(score) as best from patron_scores where mode = p_mode group by player_id) t
   where t.best > v_best;
  return json_build_object('best', v_best, 'rank', v_rank);
end $$;

-- ---------- Classement (meilleur score de chaque joueur) ----------
create or replace function public.patron_leaderboard(p_mode text, p_limit integer default 50)
returns table (rank bigint, pseudo text, score integer, days smallint, won boolean, partner text, played_at timestamptz, games bigint)
language sql stable security definer set search_path = public
as $$
  with best as (
    select distinct on (s.player_id) s.player_id, s.score, s.days, s.won, s.partner, s.created_at
      from patron_scores s
     where s.mode = p_mode
     order by s.player_id, s.score desc, s.created_at asc
  ), cnt as (
    select player_id, count(*) as n from patron_scores where mode = p_mode group by player_id
  )
  select rank() over (order by b.score desc), p.pseudo, b.score, b.days, b.won, b.partner, b.created_at, c.n
    from best b
    join patron_players p on p.id = b.player_id
    join cnt c on c.player_id = b.player_id
   order by b.score desc, b.created_at asc
   limit least(greatest(coalesce(p_limit, 50), 1), 100)
$$;

-- ---------- Droits : le site n'appelle que ces fonctions ----------
revoke execute on function public.patron_register(text, text) from public;
revoke execute on function public.patron_login(text, text) from public;
revoke execute on function public.patron_me(uuid) from public;
revoke execute on function public.patron_logout(uuid) from public;
revoke execute on function public.patron_submit_score(uuid, text, integer, integer, boolean, text) from public;
revoke execute on function public.patron_leaderboard(text, integer) from public;
grant execute on function public.patron_register(text, text) to anon, authenticated;
grant execute on function public.patron_login(text, text) to anon, authenticated;
grant execute on function public.patron_me(uuid) to anon, authenticated;
grant execute on function public.patron_logout(uuid) to anon, authenticated;
grant execute on function public.patron_submit_score(uuid, text, integer, integer, boolean, text) to anon, authenticated;
grant execute on function public.patron_leaderboard(text, integer) to anon, authenticated;
