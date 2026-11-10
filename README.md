# archagrim.github.io

Mes sites et applications, publiés avec GitHub Pages.

| Dossier | Adresse | Contenu |
|---|---|---|
| `codex/` | https://archagrim.github.io/codex/ | Lanceur installable du Codex (bible League of Legends) : logo, icônes, ouverture directe du Codex sur claude.ai. |
| `adc/` | https://archagrim.github.io/adc/ | ADC Lab : analyse automatique de mes parties classées (morts, lane, objectifs, sessions). |
| `3d/` | https://archagrim.github.io/3d/ | Atelier 3D : visionneuse de fichiers 3MF et STL en taille réelle (dimensions, échelle par socle, volume de résine). Les fichiers sont lus sur l'ordinateur, rien n'est envoyé en ligne. |

## Installer le Codex sur le téléphone

- **iPhone** : ouvre https://archagrim.github.io/codex/ dans Safari → Partager → **Sur l'écran d'accueil** → **Ajouter**.
- **Android** : ouvre https://archagrim.github.io/codex/ dans Chrome → **Installer l'app** (ou menu ⋮ → **Installer l'application**).

Chaque nouveau site peut avoir son propre dossier ici et sera publié à `https://archagrim.github.io/nom-du-dossier/`.

**Important pour les apps installables** : chaque manifeste doit avoir son propre `"id"` en chemin absolu (`"/adc/"`, `"/3d/"`, `"/codex/"`). Avec `"id": "./"`, Chrome résout l'identifiant à partir de la racine du site : toutes les apps reçoivent le même et Chrome les prend pour une seule app (installer l'une bloque les autres).

## ADC Lab

- `tools/adc_lab/fetch.py` récupère les nouvelles parties classées via l'API Riot (match-v5 et timeline) et écrit `adc/data/`.
- `tools/adc_lab/analyse.py` calcule les indicateurs : morts sans contrepartie, morts avant 14 min, présence aux objectifs, CS et or à 10 min, sessions au-delà de 2 défaites.
- `adc/accounts.json` liste les comptes suivis (Riot ID et nom affiché) ; chaque compte a ses données dans `adc/data/<compte>/`.
- `.github/workflows/adc-lab.yml` vérifie toutes les 5 minutes s'il y a de nouvelles parties (et à la demande depuis l'onglet **Actions**).
- La clé Riot est le secret `RIOT_API_KEY` du dépôt : elle n'est jamais écrite dans les fichiers.

## Atelier 3D

- **Installer sur le PC** : ouvre https://archagrim.github.io/3d/ dans Chrome ou Edge → bouton **Installer** en haut à droite (ou icône d'installation dans la barre d'adresse).
- Une fois installée, sélectionne un ou plusieurs `.3mf`/`.stl` dans l'Explorateur → clic droit → **Ouvrir avec** → **Atelier 3D**. Glisser-déposer et **Ctrl + O** marchent aussi.
- Jusqu'à **20 fichiers** ouverts à la fois, lus en parallèle, avec une barre de vignettes ; **← →** pour passer de l'un à l'autre. Chaque fichier garde sa propre échelle.
- `3d/parser.js` lit les fichiers en arrière-plan (3MF en flux, avec composants, transformations et unités ; STL binaire et texte).
- `3d/lib/` contient three.js 0.160.0 et fflate, pour que l'app marche hors ligne.
- Mode **Taille réelle 1:1** : calibrage avec une carte bancaire, mémorisé dans le navigateur.
