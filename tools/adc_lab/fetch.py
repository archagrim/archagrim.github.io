#!/usr/bin/env python3
"""ADC Lab : récupère les nouvelles parties classées via l'API Riot et met à jour adc/data/.

Variables d'environnement :
  RIOT_API_KEY  clé Riot (secret GitHub, jamais écrite dans le dépôt)
  RIOT_ID       compte suivi, ex. « ArchaGrim#game1 »
  QUEUES        files suivies (420 = classé solo/duo, 440 = flexible), défaut « 420 »
  MAX_NEW       parties analysées au maximum par exécution, défaut 100
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyse  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "adc", "data")
REGION = "https://europe.api.riotgames.com"
PAUSE = 1.25          # 100 requêtes / 2 min maximum avec une clé personnelle
KEEP = 300            # parties conservées dans games.json
UA = "adc-lab (github.com/archagrim)"


class KeyError_(Exception):
    pass


def load(name, default):
    try:
        with open(os.path.join(DATA, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, obj):
    os.makedirs(DATA, exist_ok=True)
    tmp = os.path.join(DATA, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, os.path.join(DATA, name))


def http_json(url, key=None):
    headers = {"User-Agent": UA}
    if key:
        headers["X-Riot-Token"] = key
    for attempt in range(4):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                try:
                    msg = json.loads(e.read().decode("utf-8", "replace"))["status"]["message"]
                except Exception:
                    msg = ""
                raise KeyError_(e.code, msg[:120])
            if e.code == 404:
                return None
            if e.code == 429 or e.code >= 500:
                time.sleep(int(e.headers.get("Retry-After", "10")) + 1)
                continue
            raise
        except urllib.error.URLError:
            time.sleep(5)
    raise RuntimeError("Riot ne répond pas : " + url)


def riot(path, key):
    time.sleep(PAUSE)
    return http_json(REGION + path, key)


def status(state, **kw):
    s = load("summary.json", {})
    s["status"] = dict(kw, checked=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    s.setdefault("riotId", state.get("riotId"))
    save("summary.json", s)


def main():
    key = os.environ.get("RIOT_API_KEY", "").strip()
    riot_id = os.environ.get("RIOT_ID", "ArchaGrim#game1")
    queues = [int(q) for q in os.environ.get("QUEUES", "420").split(",") if q.strip()]
    max_new = int(os.environ.get("MAX_NEW", "100"))
    state = load("state.json", {"processed": []})
    state["riotId"] = riot_id
    if not key:
        status(state, ok=False, code="cle_absente")
        print("Aucune clé Riot : ajoute le secret RIOT_API_KEY.")
        return 0
    try:
        versions = http_json("https://ddragon.leagueoflegends.com/api/versions.json") or []
        ver = versions[0] if versions else state.get("ddragon")
        costs = {}
        if ver:
            items = http_json(f"https://ddragon.leagueoflegends.com/cdn/{ver}/data/en_US/item.json") or {"data": {}}
            costs = {k: v["gold"]["total"] for k, v in items["data"].items()}
            state["ddragon"] = ver

        name, tag = riot_id.split("#", 1)
        if not state.get("puuid") or state.get("puuidFor") != riot_id:
            acc = riot(f"/riot/account/v1/accounts/by-riot-id/{urllib.parse.quote(name)}/{urllib.parse.quote(tag)}", key)
            if not acc:
                status(state, ok=False, code="compte_introuvable")
                return 0
            state["puuid"], state["puuidFor"] = acc["puuid"], riot_id
        puuid = state["puuid"]

        ids = []
        for q in queues:
            ids += riot(f"/lol/match/v5/matches/by-puuid/{puuid}/ids?queue={q}&start=0&count=100", key) or []
        if state.get("version") != analyse.VERSION:
            # Le calcul a changé : on réanalyse les parties récentes (les anciennes analyses restent en place d'ici là).
            state["processed"], state["version"] = [], analyse.VERSION
        done = set(state["processed"])
        todo = sorted((i for i in set(ids) if i not in done), key=lambda i: int(i.split("_")[1]), reverse=True)[:max_new]

        games = {g["id"]: g for g in load("games.json", [])}
        for mid in todo:
            match = riot(f"/lol/match/v5/matches/{mid}", key)
            tl = riot(f"/lol/match/v5/matches/{mid}/timeline", key) if match else None
            if match and tl:
                g = analyse.analyse(match, tl, puuid, costs)
                if g:
                    games[mid] = g
            state["processed"].append(mid)
            print("analysée :", mid)

        ordered = sorted(games.values(), key=lambda g: -g["start"])[:KEEP]
        state["processed"] = state["processed"][-2000:]
        summary = analyse.summarise(ordered)
        summary["riotId"] = riot_id
        summary["ddragon"] = state.get("ddragon")
        pending = max(0, len(set(ids) - set(state["processed"])))
        old = load("summary.json", {})
        same = (not todo and old.get("status", {}).get("ok")
                and {k: v for k, v in old.items() if k not in ("updated", "status")} == json.loads(json.dumps(summary)))
        if same:
            # Rien de neuf : on n'écrit rien, donc pas de commit ni de republication du site.
            print("Aucune nouvelle partie.")
            return 0
        summary["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        summary["status"] = {"ok": True, "code": "ok", "new": len(todo), "pending": pending, "checked": summary["updated"]}
        save("games.json", ordered)
        save("summary.json", summary)
        save("state.json", state)
        print(f"{len(todo)} nouvelle(s) partie(s), {len(ordered)} au total.")
    except KeyError_ as e:
        save("state.json", state)
        # Diagnostic sans jamais écrire la clé : seulement si son format ressemble à une clé Riot.
        fmt = bool(re.fullmatch(r"RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", key))
        status(state, ok=False, code="cle_refusee", http=int(e.args[0]), riot=e.args[1] if len(e.args) > 1 else "", format=fmt)
        print("Clé Riot refusée ou expirée.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
