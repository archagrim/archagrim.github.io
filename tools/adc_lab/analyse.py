"""ADC Lab : calcule les indicateurs d'un ADC à partir d'un match et de sa timeline (API Riot match-v5).

Les phases suivent la grille de review du coaching : 0-3, 3-8, 8-14, 14-20, 20+.
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Zurich")
VERSION = 4              # à augmenter quand le calcul change : les parties récentes sont alors réanalysées
RIVER = 14800            # sur la carte, x + y ≈ 14800 sépare les deux moitiés
TRADE_BEFORE = 10_000    # une contrepartie peut arriver 10 s avant la mort…
TRADE_AFTER = 30_000     # …ou jusqu'à 30 s après
FIGHT_GAP = 15_000       # deux kills à moins de 15 s font partie du même combat
SESSION_GAP = 45 * 60    # plus de 45 min entre deux parties = nouvelle session
REMAKE_MAX = 600        # une classée qui finit avant 10 min est un remake (aucun abandon normal avant 15 min)
OBJ_NEAR = 3000          # distance (unités de jeu) pour compter comme « sur place »

PHASES = [(0, 3, "0-3"), (3, 8, "3-8"), (8, 14, "8-14"), (14, 20, "14-20"), (20, 999, "20+")]
OBJ_LABEL = {"DRAGON": "Dragon", "BARON_NASHOR": "Baron", "RIFTHERALD": "Héraut", "HORDE": "Larves", "ATAKHAN": "Atakhan"}
DRAKE = {"FIRE_DRAGON": "infernal", "WATER_DRAGON": "océan", "EARTH_DRAGON": "montagne", "AIR_DRAGON": "nuage",
         "HEXTECH_DRAGON": "hextech", "CHEMTECH_DRAGON": "chemtech", "ELDER_DRAGON": "ancestral"}
ROLE = {"TOP": "top", "JUNGLE": "jungle", "MIDDLE": "mid", "BOTTOM": "adc", "UTILITY": "support"}


def phase(ms):
    m = ms / 60000
    for a, b, label in PHASES:
        if a <= m < b:
            return label
    return "20+"


def zone(pos, team):
    """Zone de la carte, vue par le joueur de l'équipe `team` (100 = bleu, 200 = rouge)."""
    x, y = pos["x"], pos["y"]
    mine = (x + y < RIVER) if team == 100 else (x + y > RIVER)
    side = "" if mine else ", côté adverse"
    if x < 4300 and y < 4300:
        return "Base alliée" if team == 100 else "Base adverse"
    if x > 10500 and y > 10500:
        return "Base adverse" if team == 100 else "Base alliée"
    if y < 2400 or x > 12500:
        return "Lane bot" + side
    if x < 2400 or y > 12500:
        return "Lane top" + side
    if abs(x - y) < 1600:
        return "Lane mid" + side
    if abs(x + y - RIVER) < 1500:
        return "Rivière " + ("bot" if x > y else "top")
    return "Jungle alliée" if mine else "Jungle adverse"


def dist(a, b):
    return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5


def events(tl):
    for fr in tl["info"]["frames"]:
        for e in fr.get("events", []):
            yield e


def frame_at(tl, ms):
    frames = tl["info"]["frames"]
    i = min(len(frames) - 1, max(0, int(ms // 60000)))
    return frames[i]


def analyse(match, tl, puuid, item_cost=None):
    info = match["info"]
    parts = info["participants"]
    me = next((p for p in parts if p["puuid"] == puuid), None)
    if me is None:
        return None
    pid, team = me["participantId"], me["teamId"]
    by_id = {p["participantId"]: p for p in parts}
    ally = {p["participantId"] for p in parts if p["teamId"] == team}
    enemy = {p["participantId"] for p in parts if p["teamId"] != team}
    enemy_team = 200 if team == 100 else 100

    def opp(position, side_ids):
        return next((p for p in parts if p["participantId"] in side_ids and p.get("teamPosition") == position), None)

    e_adc, e_sup = opp("BOTTOM", enemy), opp("UTILITY", enemy)
    my_sup = opp("UTILITY", ally - {pid})
    evs = sorted(events(tl), key=lambda e: e.get("timestamp", 0))
    kills = [e for e in evs if e["type"] == "CHAMPION_KILL"]
    duration = info.get("gameDuration", 0)
    if duration > 100000:  # anciennes parties : durée en millisecondes
        duration //= 1000

    # ---------- Combats : kills à moins de 15 s d'écart ----------
    fights, cur = [], []
    for e in kills:
        if cur and e["timestamp"] - cur[-1]["timestamp"] > FIGHT_GAP:
            fights.append(cur)
            cur = []
        cur.append(e)
    if cur:
        fights.append(cur)
    fight_of = {}
    for f in fights:
        for e in f:
            fight_of[id(e)] = f

    # ---------- Contreparties ----------
    def gains(t0, t1):
        out = []
        for e in evs:
            ts = e.get("timestamp", 0)
            if ts < t0 or ts > t1:
                continue
            ty = e["type"]
            if ty == "CHAMPION_KILL" and e.get("victimId") in enemy:
                out.append("kill")
            elif ty == "ELITE_MONSTER_KILL" and e.get("killerTeamId") == team:
                out.append(OBJ_LABEL.get(e.get("monsterType"), "objectif").lower())
            elif ty == "BUILDING_KILL" and e.get("teamId") == enemy_team:
                out.append("tour" if e.get("buildingType") == "TOWER_BUILDING" else "inhibiteur")
            elif ty == "TURRET_PLATE_DESTROYED" and e.get("teamId") == enemy_team:
                out.append("plaque")
        return out

    def gold(pid_, ms):
        f = frame_at(tl, ms)["participantFrames"].get(str(pid_))
        return f["totalGold"] if f else None

    # ---------- Morts ----------
    deaths = []
    for e in kills:
        if e.get("victimId") != pid:
            continue
        t = e["timestamp"]
        involved = [i for i in [e.get("killerId")] + list(e.get("assistingParticipantIds") or []) if i in enemy]
        roles = [ROLE.get(by_id[i].get("teamPosition"), "") for i in involved]
        dmg = defaultdict(int)
        for d in e.get("victimDamageReceived") or []:
            key = d.get("participantId") if d.get("participantId") in enemy else "autre"
            dmg[key] += d.get("physicalDamage", 0) + d.get("magicDamage", 0) + d.get("trueDamage", 0)
        total = sum(dmg.values())
        champ_dmg = sorted(((by_id[k]["championName"], v) for k, v in dmg.items() if k != "autre"), key=lambda x: -x[1])
        top_share = round(champ_dmg[0][1] * 100 / total) if total and champ_dmg else 0
        dealt = sum(d.get("physicalDamage", 0) + d.get("magicDamage", 0) + d.get("trueDamage", 0)
                    for d in (e.get("victimDamageDealt") or []))
        g = gains(t - TRADE_BEFORE, t + TRADE_AFTER)
        f = fight_of.get(id(e), [e])
        f_for = sum(1 for k in f if k.get("victimId") in enemy)
        f_against = sum(1 for k in f if k.get("victimId") in ally)
        mg, eg = gold(pid, t), gold(e_adc["participantId"], t) if e_adc else None
        deaths.append({
            "t": t // 1000, "ph": phase(t), "pos": e.get("position"), "zone": zone(e["position"], team) if e.get("position") else "",
            "by": [by_id[i]["championName"] for i in involved], "roles": roles,
            "gank": t < 14 * 60000 and any(r in ("jungle", "mid", "top") for r in roles),
            "dmg": [[c, v] for c, v in champ_dmg[:4]], "dmgTot": total, "top": top_share,
            "burst": len(champ_dmg) > 0 and top_share >= 60, "dealt": dealt,
            "trade": g, "free": not g,
            "fight": len(f), "first": len(f) >= 3 and f[0] is e, "fFor": f_for, "fAg": f_against,
            "gd": (mg - eg) if (mg is not None and eg is not None) else None,
            "lvl": frame_at(tl, t)["participantFrames"][str(pid)].get("level"),
        })

    # ---------- Objectifs ----------
    purchases = [e["timestamp"] for e in evs if e["type"] == "ITEM_PURCHASED" and e.get("participantId") == pid]
    my_deaths_ms = [d["t"] * 1000 for d in deaths]
    objs, last_horde = [], None
    for e in evs:
        if e["type"] != "ELITE_MONSTER_KILL" or e.get("monsterType") not in OBJ_LABEL:
            continue
        t, mt = e["timestamp"], e["monsterType"]
        if mt == "HORDE" and last_horde and t - last_horde["_t"] < 90_000:
            last_horde["_t"] = t
            continue
        part = pid == e.get("killerId") or pid in (e.get("assistingParticipantIds") or [])
        fr = frame_at(tl, t)["participantFrames"][str(pid)]
        near = bool(e.get("position")) and dist(fr["position"], e["position"]) < OBJ_NEAR
        dead = any(t - 60_000 <= d <= t for d in my_deaths_ms)
        reset = any(t - 150_000 <= b <= t - 30_000 for b in purchases)
        label = OBJ_LABEL[mt] + (" " + DRAKE.get(e.get("monsterSubType"), "") if mt == "DRAGON" else "")
        o = {"t": t // 1000, "type": mt, "label": label.strip(), "us": e.get("killerTeamId") == team,
             "part": part, "near": near, "dead": dead, "reset": reset, "present": (part or near) and not dead, "_t": t}
        objs.append(o)
        if mt == "HORDE":
            last_horde = o
    for o in objs:
        o.pop("_t", None)

    # ---------- Phase de lane ----------
    def stat(p, minute):
        frames = tl["info"]["frames"]
        if minute >= len(frames) or p is None:
            return None
        f = frames[minute]["participantFrames"][str(p["participantId"])]
        return {"cs": f["minionsKilled"] + f["jungleMinionsKilled"], "g": f["totalGold"], "xp": f["xp"], "lvl": f["level"]}

    lane = {}
    for m in (10, 14):
        a, b = stat(me, m), stat(e_adc, m)
        if a:
            lane[f"cs{m}"] = a["cs"]
            if b:
                lane[f"gd{m}"] = a["g"] - b["g"]
                lane[f"xpd{m}"] = a["xp"] - b["xp"]
                lane[f"csd{m}"] = a["cs"] - b["cs"]

    def lvl2(p):
        if not p:
            return None
        return next((e["timestamp"] // 1000 for e in evs if e["type"] == "LEVEL_UP"
                     and e.get("participantId") == p["participantId"] and e.get("level") == 2), None)

    lane["lvl2"], lane["lvl2E"] = lvl2(me), lvl2(e_adc)
    # Plaques de la phase de lane : seulement celles des deux tours extérieures du bot.
    # (Depuis la saison 2026, Riot enregistre aussi des plaques sur les tours intérieures et d'inhibiteur.)
    plates = [e for e in evs if e["type"] == "TURRET_PLATE_DESTROYED" and _bot_outer(e.get("position"))]
    lane["platesWon"] = sum(1 for e in plates if e.get("teamId") == enemy_team)
    lane["platesLost"] = sum(1 for e in plates if e.get("teamId") == team)
    lane["platesMine"] = sum(1 for e in plates if e.get("killerId") == pid)
    lane["deaths14"] = sum(1 for d in deaths if d["t"] < 14 * 60)
    first = next((b for b in purchases if b > 60_000), None)
    if first:
        items = [e["itemId"] for e in evs if e["type"] == "ITEM_PURCHASED" and e.get("participantId") == pid
                 and first <= e["timestamp"] <= first + 20_000]
        lane["back1"] = {"t": first // 1000, "items": items,
                         "gold": sum(item_cost.get(str(i), 0) for i in items) if item_cost else None}

    # ---------- Résumé de la partie ----------
    team_kills = sum(p["kills"] for p in parts if p["teamId"] == team) or 1
    team_dmg = sum(p["totalDamageDealtToChampions"] for p in parts if p["teamId"] == team) or 1
    cs = me["totalMinionsKilled"] + me["neutralMinionsKilled"]
    start = info.get("gameStartTimestamp") or info["gameCreation"]
    local = datetime.fromtimestamp(start / 1000, TZ)
    return {
        "id": match["metadata"]["matchId"], "start": start // 1000, "local": local.strftime("%Y-%m-%d %H:%M"),
        "dur": duration, "queue": info["queueId"], "patch": ".".join(info.get("gameVersion", "").split(".")[:2]),
        "win": bool(me["win"]), "remake": bool(me.get("gameEndedInEarlySurrender")) or duration < REMAKE_MAX,
        "champ": me["championName"], "pos": me.get("teamPosition", ""),
        "sup": my_sup["championName"] if my_sup else "", "eAdc": e_adc["championName"] if e_adc else "",
        "eSup": e_sup["championName"] if e_sup else "",
        "k": me["kills"], "d": me["deaths"], "a": me["assists"], "cs": cs,
        "csm": round(cs / (duration / 60), 2) if duration else 0,
        "kp": round((me["kills"] + me["assists"]) * 100 / team_kills),
        "dmgShare": round(me["totalDamageDealtToChampions"] * 100 / team_dmg),
        "vis": round(me.get("visionScore", 0) / (duration / 60), 2) if duration else 0,
        "pinks": me.get("visionWardsBoughtInGame", 0),
        "deaths": deaths, "free": sum(1 for d in deaths if d["free"]), "objs": objs, "lane": lane,
    }


# ---------------------------------------------------------------- Agrégats

BOT_OUTER = ((10504, 1029), (13866, 4505))   # tours extérieures bot : bleue, rouge


def _bot_outer(pos):
    return bool(pos) and any(abs(pos.get("x", 0) - x) < 800 and abs(pos.get("y", 0) - y) < 800 for x, y in BOT_OUTER)


def _avg(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


def sessions(games):
    """Regroupe les parties (plus ancienne d'abord) en sessions et repère les entorses à la règle des 2 défaites."""
    out, cur = [], []
    for g in sorted(games, key=lambda g: g["start"]):
        if cur and g["start"] - (cur[-1]["start"] + cur[-1]["dur"]) > SESSION_GAP:
            out.append(cur)
            cur = []
        cur.append(g)
    if cur:
        out.append(cur)
    res = []
    for s in out:
        streak, broke_at = 0, None
        for i, g in enumerate(s):
            if streak >= 2 and broke_at is None:
                broke_at = i
            streak = streak + 1 if not g["win"] else 0
        res.append({"day": s[0]["local"][:10], "from": s[0]["local"][11:], "to": s[-1]["local"][11:],
                    "games": [{"id": g["id"], "w": g["win"], "c": g["champ"]} for g in s],
                    "broke": broke_at, "extra": (len(s) - broke_at) if broke_at is not None else 0})
    return res


def week_bounds(now):
    local = now.astimezone(TZ)
    monday = (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return monday, monday + timedelta(days=7)


def block(games, sess):
    n = len(games)
    if not n:
        return {"games": 0}
    objs = [o for g in games for o in g["objs"] if o["type"] in ("DRAGON", "BARON_NASHOR", "ATAKHAN")]
    bot = [g for g in games if g.get("pos") == "BOTTOM"]   # stats de lane : parties jouées ADC uniquement
    return {
        "games": n, "wins": sum(g["win"] for g in games), "wr": round(sum(g["win"] for g in games) * 100 / n),
        "free": _avg([g["free"] for g in games]), "deaths": _avg([g["d"] for g in games]),
        "deaths14": _avg([g["lane"].get("deaths14") for g in games]),
        "objPresent": round(sum(o["present"] for o in objs) * 100 / len(objs)) if objs else None,
        "cs10": _avg([g["lane"].get("cs10") for g in bot]), "gd10": _avg([g["lane"].get("gd10") for g in bot]),
        "gd14": _avg([g["lane"].get("gd14") for g in bot]),
        "first": _avg([sum(1 for d in g["deaths"] if d["first"]) for g in games]),
        "breaks": sum(1 for s in sess if s["broke"] is not None), "sessions": len(sess),
    }


def summarise(games, now=None):
    now = now or datetime.now(timezone.utc)
    games = sorted([g for g in games if not g.get("remake") and g.get("dur", 0) >= REMAKE_MAX], key=lambda g: -g["start"])
    all_sess = sessions(games)
    mon, nxt = week_bounds(now)
    prev = mon - timedelta(days=7)

    def between(a, b):
        return [g for g in games if a.timestamp() <= g["start"] < b.timestamp()]

    def sess_between(a, b):
        return [s for s in all_sess if a.strftime("%Y-%m-%d") <= s["day"] < b.strftime("%Y-%m-%d")]

    by_index, by_hour, champs = defaultdict(list), defaultdict(list), defaultdict(list)
    for s in all_sess:
        for i, gg in enumerate(s["games"]):
            by_index[min(i + 1, 6)].append(gg["w"])
    for g in games:
        by_hour[int(g["local"][11:13])].append(g["win"])
        champs[g["champ"]].append(g)
    zones = defaultdict(lambda: [0, 0])
    for g in games[:20]:
        for d in g["deaths"]:
            z = d["zone"].split(",")[0]
            zones[z][0] += 1
            zones[z][1] += d["free"]
    return {
        "week": {"from": mon.strftime("%Y-%m-%d"), "cur": block(between(mon, nxt), sess_between(mon, nxt)),
                 "prev": block(between(prev, mon), sess_between(prev, mon))},
        "last20": block(games[:20], all_sess[-8:]),
        "trend": [{"id": g["id"], "local": g["local"], "c": g["champ"], "w": g["win"], "free": g["free"], "d": g["d"],
                   "cs10": g["lane"].get("cs10"), "gd10": g["lane"].get("gd10")} for g in reversed(games[:40])],
        "sessions": list(reversed(all_sess[-12:])),
        "byIndex": {str(k): {"n": len(v), "wr": round(sum(v) * 100 / len(v))} for k, v in sorted(by_index.items())},
        "byHour": {str(k): {"n": len(v), "wr": round(sum(v) * 100 / len(v))} for k, v in sorted(by_hour.items())},
        "zones": sorted(([z, n, f] for z, (n, f) in zones.items()), key=lambda x: -x[1]),
        "champs": sorted(({"c": c, "n": len(v), "wr": round(sum(x["win"] for x in v) * 100 / len(v)),
                           "free": _avg([x["free"] for x in v]),
                           "cs10": _avg([x["lane"].get("cs10") for x in v if x.get("pos") == "BOTTOM"]),
                           "gd10": _avg([x["lane"].get("gd10") for x in v if x.get("pos") == "BOTTOM"])} for c, v in champs.items()),
                         key=lambda x: -x["n"]),
    }
