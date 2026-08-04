# Journal de bord — dealpulse

> Écrit automatiquement par `journal-projet.py`. **Que des faits relevés sur le disque**,
> jamais une supposition. Sert à retrouver le fil d'un projet sans avoir à tout réexpliquer —
> notamment depuis Telegram. Dernière mise à jour : **04/08/2026 à 07:06**.

## Où ça en est

- Branche **main** · dépôt https://github.com/driss-ixx/dealpulse-automation.git
- Rien en attente : tout est enregistré

## Ce qui a été fait récemment

- 04/08 04:06 — backup auto 2026-08-04 04:05:43
- 29/05 10:31 — perf: oracle-arm-retry -> toutes les 6h (VM déjà active)
- 29/05 10:28 — fix: setup-python@v5 -> @v6 (Node.js 24 requis juin 2026)
- 29/05 10:28 — fix: ajouter exit 1 si Reddit EF échoue
- 03/04 19:04 — feat: notification email via GitHub Issue quand VM Oracle créée
- 02/04 16:39 — feat: add Facebook Groups Playwright workflow
- 02/04 15:36 — feat: add Oracle ARM A1 retry workflow via GitHub Actions
- 01/04 20:19 — init: GitHub Actions — remplace n8n localhost

## Fichiers principaux

- `supabase/functions/deal-pulse-cron/index.ts` — 16 Ko
- `README.md` — 6 Ko
- `supabase/functions/deal-pulse-weekly/index.ts` — 5 Ko
- `supabase/functions/deal-pulse-reddit/index.ts` — 4 Ko
- `supabase/functions/deal-pulse-fbgroups/index.ts` — 3 Ko
- `JOURNAL.md` — 2 Ko
- `README.github-original.md`
- `CLAUDE.md`

## À savoir avant de toucher à ce projet

- Vérifier l'état réel avant d'affirmer quoi que ce soit : ce journal date de sa dernière
  génération, pas de maintenant.
- Ne jamais supprimer avec `rm` — corbeille. Copier un fichier avant de le modifier.
- Rien d'irréversible (envoi, déploiement, push) sans accord explicite de Driss.
