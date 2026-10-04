# mcp-az-recon — Phase 0

Projet séparé de `mcp-marketdata`. Engo Arena sert ici uniquement de **tuyau de données PIT**
(S&P 500 historique + prix ajustés) — tout le calcul (momentum, percentile, backtest) reste
dans ce serveur, jamais chez Engo.

```
Claude / ChatGPT
   │
   ▼
mcp-az-recon (ce serveur)
   │  ENGO_API_KEY en variable d'environnement — jamais dans le chat
   ▼
engo.capital/api/v1/lake/*
```

## ⚠️ Sécurité — clé API

**Ne collez jamais votre clé Engo dans une conversation Claude ou ChatGPT.** Elle n'est
affichée qu'une seule fois par Engo. Mettez-la uniquement dans :
- `.env` en local (jamais commité — ajoutez `.env` à `.gitignore`)
- Railway → Variables, une fois déployé

## ⚠️ Schéma de réponse non vérifié

Je n'ai pas pu tester les endpoints `lake/members` et `lake/eod` en conditions réelles
(pas de clé, pas d'accès réseau sortant dans mon environnement). Le code devine les noms
de champs (`members`/`tickers`, `date`/`t`, `close`/`c`) avec des valeurs de repli. **Au
premier vrai test (Phase 0A), si la réponse est vide ou mal formée, c'est probablement un
nom de champ à ajuster** — partagez-moi le JSON brut d'une réponse et je corrige.

## Installation locale

```bash
cd mcp-az-recon
npm install
cp .env.example .env   # puis éditez .env avec votre clé
npm start
```

## Outils disponibles (Phase 0 uniquement)

- **engo_whoami**() — `GET /api/v1/me`, vérifie que la clé fonctionne.
- **engo_sp500_members**({ asof, strict }) — composition PIT du S&P 500 à une date, avec
  vérification automatique de présence de 5 valeurs canaris (AAPL, MSFT, AMZN, GOOGL, JNJ).
- **engo_price_sample**({ symbols (≤10), from, to, dataset? }) — diagnostic de qualité des
  prix (nombre de lignes, trous suspects, premier/dernier close) — **jamais** la série
  complète.
- **engo_momentum_snapshot**({ symbols (≤10), asof, dataset? }) — calcule M1/M3/M6/M12
  **nous-mêmes** à partir des closes bruts, pour valider le moteur indépendamment d'Engo.

## Déploiement (identique à mcp-marketdata)

Railway (ou Render/Fly.io), variable d'environnement `ENGO_API_KEY`, URL MCP finale :
```
https://votre-service.up.railway.app/mcp
```

## Plan de validation Phase 0 (dans l'ordre)

| Étape | Outil | Vérifier |
|---|---|---|
| 0A | `engo_whoami` | la clé répond, tier/limites affichés |
| 0B | `engo_sp500_members(asof="2018-06-30")` | ~500 membres, canari tous présents |
| 0C | `engo_price_sample(symbols=[...5-10 tickers...])` | dates cohérentes, pas de trous |
| 0D | `engo_momentum_snapshot(symbols=[...], asof="2018-06-30")` | M1/M3/M6/M12 plausibles, comparables à une source externe sur 1-2 tickers connus |

**Phase 1** (chargement de l'univers complet via `lake/panel`, paginé par lots de 100
symboles) ne démarre qu'une fois 0A-0D validés sans anomalie.

## Phase 1 — bulk loader (ajouté)

- **engo_lake_panel_load**({ symbols, start, end, fields?, dataset?, cache_key? }) —
  charge l'historique de prix pour une liste de tickers (n'importe quelle taille,
  découpée automatiquement en lots de 100 — la limite de l'API). La matrice complète est
  **mise en cache côté serveur** (variable en mémoire du process Node, `Map` au niveau
  module — donc partagée entre appels tant que le process Railway tourne, perdue à chaque
  redéploiement/redémarrage). La réponse renvoyée au chat ne contient **jamais** les prix
  bruts — seulement : clé de cache, nombre de symboles chargés/manquants, couverture de
  dates, et les "receipts" de chaque lot (provenance/hash côté Engo).
- **engo_cache_inspect**({ cache_key? }) — liste les caches en mémoire, ou inspecte un
  cache précis (nombre de lignes par symbole, première/dernière date) sans refaire
  d'appel à Engo.

⚠️ **Schéma de réponse `lake/panel` non vérifié indépendamment** — la doc Engo ne précise
pas la forme exacte du JSON retourné. Le code essaie plusieurs noms de champs probables
(`data`/`panel`/`series`). **Premier test recommandé : un petit lot (5-10 symboles, quelques
mois)**, puis `engo_cache_inspect` pour vérifier que `symbols_cached` n'est pas resté à 0.
Si c'est le cas malgré un receipt `status: "ok"`, partagez un chunk de réponse brute et
j'ajuste le mapping de champs.

### Pas encore fait (volontairement, hors scope de ce test)
- `lake/panel.parquet` (le format binaire) — priorité donnée à la version JSON exploitable
  directement par le serveur.
- Tout calcul de percentile/MOM/portefeuille — c'est la prochaine étape, une fois le bulk
  loader validé sur un échantillon réel.
  
