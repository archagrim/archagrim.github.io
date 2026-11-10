#!/usr/bin/env python3
"""ADC Lab : récupère les nouvelles parties classées via l'API Riot et met à jour adc/data/.

Les comptes suivis sont listés dans adc/accounts.json :
  [{"riotId": "ArchaGrim#game1", "label": "Main"}, {"riotId": "MonSmurf#EUW"}]
Chaque compte a son dossier adc/data/<compte>/ (games.json, summary.json, state.json),
et adc/data/index.json liste les comptes pour le sélecteur de la page.

Variables d'environnement :
  RIOT_API_KEY  clé Riot (secret GitHub, jamais écrite dans le dépôt)
  RIOT_ID       compte suivi si adc/accounts.json n'existe pas, défaut « ArchaGrim#game1 »
  QUEUES        files suivies (420 = classé solo/duo, 440 = flexible), défaut « 420 »
  MAX_NEW       parties analysées au maximum par exécution, tous comptes confondus, défaut 120
"""
import json
import os
import re
import shutil
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
ACCOUNTS = os.path.join(ROOT, "adc", "accounts.json")
REGION = "https://europe.api.riotgames.com"   # match-v5 : EUW, EUNE, TR, RU, ME
PAUSE = 1.25          # 100 requêtes / 2 min maximum avec une clé personnelle
KEEP = 300            # parties conservées par compte
UA = "adc-lab (github.com/archagrim)"


class KeyError_(Exception):
    pass


def slug(riot_id):
    return re.sub(r"[^a-z0-9]+", "-", riot_id.lower()).strip("-") or "compte"


def load(name, default, sub=""):
    try:
        with open(os.path.join(DATA, sub, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(name, obj, sub=""):
    d = os.path.join(DATA, sub)
    os.makedirs(d, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    try:
        with open(os.path.join(d, name), encoding="utf-8") as f:
            if f.read() == text:
                return   # contenu identique : pas d'écriture, donc pas de commit
    except OSError:
        pass
    tmp = os.path.join(d, name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, os.path.join(d, name))


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


def accounts():
    try:
        with open(ACCOUNTS, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = [os.environ.get("RIOT_ID", "ArchaGrim#game1")]
    out, seen = [], set()
    for a in raw if isinstance(raw, list) else []:
        a = {"riotId": a} if isinstance(a, str) else dict(a)
        rid = str(a.get("riotId", "")).strip()
        if "#" not in rid or slug(rid) in seen:
            continue
        seen.add(slug(rid))
        out.append({"riotId": rid, "label": str(a.get("label") or rid.split("#")[0]).strip(), "slug": slug(rid)})
    return out


def migrate(accs):
    """Anciennes données à la racine de adc/data/ → dossier du compte correspondant."""
    old = load("state.json", None)
    if not old:
        return
    target = next((a for a in accs if a["riotId"].lower() == str(old.get("riotId", "")).lower()), None)
    if target and not os.path.exists(os.path.join(DATA, target["slug"], "state.json")):
        os.makedirs(os.path.join(DATA, target["slug"]), exist_ok=True)
        for f in ("games.json", "summary.json", "state.json"):
            if os.path.exists(os.path.join(DATA, f)):
                shutil.move(os.path.join(DATA, f), os.path.join(DATA, target["slug"], f))
    else:
        for f in ("games.json", "summary.json", "state.json"):
            if os.path.exists(os.path.join(DATA, f)):
                os.remove(os.path.join(DATA, f))


def status(acc, state, **kw):
    s = load("summary.json", {}, acc["slug"])
    old = dict(s.get("status") or {})
    old.pop("checked", None)
    if old != json.loads(json.dumps(kw)) or s.get("riotId") != acc["riotId"]:
        # On n'écrit que si l'état change, pour ne pas créer un commit toutes les 5 minutes.
        s["status"] = dict(kw, checked=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        s["riotId"] = acc["riotId"]
        save("summary.json", s, acc["slug"])
    save("state.json", state, acc["slug"])


def update_account(acc, key, costs, ver, queues, budget):
    """Met à jour un compte ; renvoie le nombre de parties analysées."""
    sub = acc["slug"]
    state = load("state.json", {"processed": []}, sub)
    state["riotId"] = acc["riotId"]
    if ver:
        state["ddragon"] = ver
    name, tag = acc["riotId"].split("#", 1)
    if not state.get("puuid") or state.get("puuidFor") != acc["riotId"]:
        found = riot(f"/riot/account/v1/accounts/by-riot-id/{urllib.parse.quote(name)}/{urllib.parse.quote(tag)}", key)
        if not found:
            status(acc, state, ok=False, code="compte_introuvable")
            print("Compte introuvable :", acc["riotId"])
            return 0
        state["puuid"], state["puuidFor"], state["processed"] = found["puuid"], acc["riotId"], []
    puuid = state["puuid"]

    ids = []
    for q in queues:
        ids += riot(f"/lol/match/v5/matches/by-puuid/{puuid}/ids?queue={q}&start=0&count=100", key) or []
    if state.get("version") != analyse.VERSION:
        # Le calcul a changé : on réanalyse les parties récentes (les anciennes analyses restent en place d'ici là).
        state["processed"], state["version"] = [], analyse.VERSION
    done = set(state["processed"])
    todo = sorted((i for i in set(ids) if i not in done), key=lambda i: int(i.split("_")[1]), reverse=True)[:max(0, budget)]

    games = {g["id"]: g for g in load("games.json", [], sub)}
    for mid in todo:
        match = riot(f"/lol/match/v5/matches/{mid}", key)
        tl = riot(f"/lol/match/v5/matches/{mid}/timeline", key) if match else None
        if match and tl:
            g = analyse.analyse(match, tl, puuid, costs)
            if g:
                games[mid] = g
        state["processed"].append(mid)
        print(acc["riotId"], "· analysée :", mid)

    ordered = sorted(games.values(), key=lambda g: -g["start"])[:KEEP]
    state["processed"] = state["processed"][-2000:]
    summary = analyse.summarise(ordered)
    summary["riotId"] = acc["riotId"]
    summary["ddragon"] = state.get("ddragon")
    pending = max(0, len(set(ids) - set(state["processed"])))
    old = load("summary.json", {}, sub)
    same = (not todo and old.get("status", {}).get("ok") and not old.get("status", {}).get("pending")
            and {k: v for k, v in old.items() if k not in ("updated", "status")} == json.loads(json.dumps(summary)))
    if same:
        # Rien de neuf : on n'écrit rien, donc pas de commit ni de republication du site.
        return 0
    summary["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    summary["status"] = {"ok": True, "code": "ok", "new": len(todo), "pending": pending, "checked": summary["updated"]}
    save("games.json", ordered, sub)
    save("summary.json", summary, sub)
    save("state.json", state, sub)
    print(f"{acc['riotId']} : {len(todo)} nouvelle(s) partie(s), {len(ordered)} au total.")
    return len(todo)


def write_index(accs, ver):
    rows = []
    for a in accs:
        s = load("summary.json", {}, a["slug"])
        g = load("games.json", [], a["slug"])
        rows.append({"riotId": a["riotId"], "label": a["label"], "slug": a["slug"], "games": len(g),
                     "updated": s.get("updated"), "code": (s.get("status") or {}).get("code")})
    idx = {"accounts": rows, "ddragon": ver}
    if load("index.json", None) != json.loads(json.dumps(idx)):
        save("index.json", idx)


def main():
    key = os.environ.get("RIOT_API_KEY", "").strip()
    queues = [int(q) for q in os.environ.get("QUEUES", "420").split(",") if q.strip()]
    budget = int(os.environ.get("MAX_NEW", "120"))
    accs = accounts()
    migrate(accs)
    ver = load("index.json", {}).get("ddragon")
    if not key:
        for a in accs:
            status(a, load("state.json", {"processed": []}, a["slug"]), ok=False, code="cle_absente")
        write_index(accs, ver)
        print("Aucune clé Riot : ajoute le secret RIOT_API_KEY.")
        return 0
    try:
        versions = http_json("https://ddragon.leagueoflegends.com/api/versions.json") or []
        ver = versions[0] if versions else ver
        costs = {}
        if ver:
            items = http_json(f"https://ddragon.leagueoflegends.com/cdn/{ver}/data/en_US/item.json") or {"data": {}}
            costs = {k: v["gold"]["total"] for k, v in items["data"].items()}
        for a in accs:
            budget -= update_account(a, key, costs, ver, queues, budget)
    except KeyError_ as e:
        # Diagnostic sans jamais écrire la clé : seulement si son format ressemble à une clé Riot.
        fmt = bool(re.fullmatch(r"RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", key))
        for a in accs:
            status(a, load("state.json", {"processed": []}, a["slug"]), ok=False, code="cle_refusee",
                   http=int(e.args[0]), riot=e.args[1] if len(e.args) > 1 else "", format=fmt)
        print("Clé Riot refusée ou expirée.")
    write_index(accs, ver)
    return 0


if __name__ == "__main__":
    sys.exit(main())
