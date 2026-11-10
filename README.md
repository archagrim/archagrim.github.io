# archagrim.github.io

Mes sites et applications, publiés avec GitHub Pages.

| Dossier | Adresse | Contenu |
|---|---|---|
| `codex/` | https://archagrim.github.io/codex/ | Lanceur installable du Codex (bible League of Legends) : logo, icônes, ouverture directe du Codex sur claude.ai. |
| `adc/` | https://archagrim.github.io/adc/ | ADC Lab : analyse automatique de mes parties classées (morts, lane, objectifs, sessions). |

## Installer le Codex sur le téléphone

- **iPhone** : ouvre https://archagrim.github.io/codex/ dans Safari → Partager → **Sur l'écran d'accueil** → **Ajouter**.
- **Android** : ouvre https://archagrim.github.io/codex/ dans Chrome → **Installer l'app** (ou menu ⋮ → **Installer l'application**).

Chaque nouveau site peut avoir son propre dossier ici et sera publié à `https://archagrim.github.io/nom-du-dossier/`.

## ADC Lab

- `tools/adc_lab/fetch.py` récupère les nouvelles parties classées via l'API Riot (match-v5 et timeline) et écrit `adc/data/`.
- `tools/adc_lab/analyse.py` calcule les indicateurs : morts sans contrepartie, morts avant 14 min, présence aux objectifs, CS et or à 10 min, sessions au-delà de 2 défaites.
- `adc/accounts.json` liste les comptes suivis (Riot ID et nom affiché) ; chaque compte a ses données dans `adc/data/<compte>/`.
- `.github/workflows/adc-lab.yml` vérifie toutes les 5 minutes s'il y a de nouvelles parties (et à la demande depuis l'onglet **Actions**).
- La clé Riot est le secret `RIOT_API_KEY` du dépôt : elle n'est jamais écrite dans les fichiers.
