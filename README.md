# DealPulse FR — code + état réel

> **2026-08-04, après-midi — RÉPARÉ, mais pas encore remis en service.**
> Le diagnostic ci-dessous reste valable comme historique ; l'état actuel est décrit ici.

## Où ça en est (2026-08-04)

| Élément | État |
|---|---|
| Extraction Amazon | ✅ **Réparée** — `deal-pulse-cron` v4 déployée sur Biz 5. Prouvé en production : **30 produits extraits** (l'ancien code en trouvait 0) |
| Détection de panne | ✅ `success:false` + **HTTP 500** si 0 produit ; le workflow lit désormais le corps JSON |
| Repli en liens bidons | ✅ Supprimé |
| `deal-pulse-selftest` | ✅ **Nouvelle fonction de contrôle** — rejoue l'extraction **sans rien publier** |
| Workflows GitHub | ⏸️ Toujours en `disabled_inactivity` — **en attente du go de Driss** |
| Première publication réelle | ⏸️ **Jamais déclenchée** — publierait sur Telegram, Bluesky, Facebook et Instagram |

### Vérifier l'état du bot sans rien publier

```bash
curl -s https://wnphyxusalptwqiimazk.supabase.co/functions/v1/deal-pulse-selftest | jq
```
Rend le nombre de produits extraits, un échantillon, et compare l'ancien et le nouveau motif.
**Le réflexe à avoir** dès qu'on soupçonne une panne, ou après tout changement chez Amazon.

### Facebook / Instagram : jetons révoqués — action manuelle requise

Diagnostic par `deal-pulse-diag-meta` (ne révèle jamais la valeur d'un jeton) :

```bash
curl -s https://wnphyxusalptwqiimazk.supabase.co/functions/v1/deal-pulse-diag-meta | jq
```

| Réseau | Erreur | Signification |
|---|---|---|
| Facebook | `190` / sous-code **460** | session invalidée — mot de passe changé, ou révocation de sécurité Meta |
| Instagram | `190` / sous-code **467** | session invalide — déconnexion de l'utilisateur |

Les **permissions sont bonnes** (`pages_manage_posts`, `pages_show_list`…) et le jeton n'a pas
de date d'expiration : ce n'est donc pas un problème de configuration, mais une révocation.
**Rien à corriger dans le code.** Il faut régénérer les jetons depuis
[developers.facebook.com](https://developers.facebook.com/tools/explorer/) et remplacer
`FACEBOOK_PAGE_ACCESS_TOKEN` et `INSTAGRAM_ACCESS_TOKEN` dans la table `bot_config`.

### Ce qui reste cassé, indépendamment

- `deal-pulse-reddit` — `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_PASSWORD` **vides** dans `bot_config`
- `deal-pulse-fbgroups` — `FACEBOOK_USER_TOKEN` et `FACEBOOK_GROUP_IDS` **vides**
- **4 workflows sur 5 sont `disabled_inactivity`** — dont `deal-pulse-weekly` (récap du lundi).
  Seul `DealPulse Cron` tourne. Réactivation : `gh workflow enable <id> --repo driss-ixx/dealpulse-automation`
- Le site **dealpulse-fr.vercel.app n'existe plus** (404 sur le domaine entier)
- `bot_config` stocke les secrets **en clair** en base — à migrer vers les secrets Supabase

---

## Diagnostic d'origine (conservé)

> ⚠️ Diagnostic du 2026-08-04 matin. **Le bot ne publiait plus rien depuis le 2026-05-29.**

## Origine des fichiers

| Chemin | Provenance |
|---|---|
| `.github/workflows/*` | dépôt GitHub `driss-ixx/dealpulse-automation` (`gh repo clone`) |
| `supabase/functions/*/index.ts` | **récupérés depuis Supabase** (projet Biz 5 `wnphyxusalptwqiimazk`) via l'API Edge Functions — ils n'ont jamais été versionnés sur GitHub |
| `README.github-original.md` | copie de sauvegarde du README d'origine du dépôt |

Le Supabase de référence est **`wnphyxusalptwqiimazk`** (Biz 5). Des copies obsolètes
des mêmes fonctions traînent sur le projet Zik Klash `jxkaxggmfsbgogjwfefi` : **hors-jeu, ne pas y toucher.**

## Panne n°1 — le scraper Amazon ne trouve plus aucun produit

`supabase/functions/deal-pulse-cron/index.ts`, fonction `scrapeAmazonDeals` :

```ts
const dealMatches = html.matchAll(/"title":"([^"]{10,100})","asin":"([A-Z0-9]{10})"/g);
```

Amazon a inversé l'ordre des clés dans son JSON. Vérifié le 2026-08-04 sur la vraie page
`https://www.amazon.fr/deals?ref=nav_cs_gb` (HTTP 200, pas de captcha, 57 ASIN présents) :

- motif attendu par le code `"title":…,"asin":…` → **0 occurrence**
- motif réellement servi `"asin":…,"title":…` → **26 occurrences**

Le `catch` est muet, puis le bloc de repli injecte deux liens de **listing** (pas des produits) :

```ts
if (deals.length === 0) {
  deals.push(
    { title: "Top Deals Amazon — Offres du jour", link: `https://www.amazon.fr/deals?tag=${affiliateTag}` },
    { title: "Bons plans High-Tech Amazon", link: `https://www.amazon.fr/s?k=deal&tag=${affiliateTag}` }
  );
}
```

Ces deux liens sont déjà en base → la déduplication (`deal_hash`) les rejette → 0 publication.

## Panne n°2 — la fonction ment : `errors: []`

Le tableau `errors` n'est alimenté **que** par une erreur d'insert SQL. Ni le scrape à vide,
ni le repli, ni la dédup ne remontent quoi que ce soit. La réponse est donc toujours
`{"success":true, ... "errors":[]}` alors que rien n'est publié.
Les workflows GitHub aggravent : ils ne testent que le code HTTP 200, jamais le corps JSON
(`deal-pulse-reddit` renvoie `success:false` et le job reste vert).

## Panne n°3 — tous les workflows GitHub sont désactivés

Dernier commit du dépôt : **2026-05-29**. GitHub désactive les workflows planifiés après
60 jours d'inactivité du dépôt. État actuel des 5 workflows : `disabled_inactivity`.
Dernier passage automatique du cron : **2026-07-28 14:59 UTC**. Depuis, plus rien ne tourne.

À noter aussi : même avant, le cron ne tournait pas toutes les 30 min mais toutes les 2-3 h
(bridage des crons gratuits GitHub Actions).

## État par fonction (Biz 5)

| Fonction | État réel |
|---|---|
| `deal-pulse-cron` | ACTIVE, répond 200, mais 0 vrai deal — cause ci-dessus |
| `deal-pulse-weekly` | ACTIVE, mais `posted_deals` est vide sur 7 jours → sort sur `no deals this week` |
| `deal-pulse-reddit` | ACTIVE mais inutilisable : `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_PASSWORD` sont vides dans `bot_config` |
| `deal-pulse-fbgroups` | ACTIVE mais inutilisable : `FACEBOOK_USER_TOKEN` et `FACEBOOK_GROUP_IDS` vides (l'API groupes a de toute façon été supprimée par Meta) |

Secrets : ils sont stockés **en clair** dans la table `public.bot_config` de Biz 5.
Aucune valeur n'est reproduite ici. À déplacer un jour vers les secrets Supabase.

## Ce qu'il resterait à faire (non fait, pas d'accord donné)

1. Réactiver les workflows GitHub (un commit suffit à relancer le compteur).
2. Corriger le parsing Amazon (ordre des clés) — et le rendre tolérant à l'ordre.
3. Supprimer le repli en liens de listing, ou au minimum ne jamais le publier.
4. Renvoyer `success:false` + `errors` quand le scrape rend 0 produit, et faire échouer le job GitHub sur le corps JSON, pas sur le code HTTP.
5. Ajouter une alerte Telegram si aucune publication depuis 24 h.
