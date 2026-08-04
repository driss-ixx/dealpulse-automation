# dealpulse-automation

GitHub Actions remplaçant n8n localhost pour appeler les Edge Functions Supabase de DealPulse FR.

## Workflows

| Workflow | Schedule | Edge Function |
|----------|----------|---------------|
| `deal-pulse-cron.yml` | Toutes les 30 min | `deal-pulse-cron` |
| `deal-pulse-weekly.yml` | Lundi 7h UTC | `deal-pulse-weekly` |
| `deal-pulse-reddit.yml` | 9h, 14h, 19h UTC | `deal-pulse-reddit` |

Tous les workflows ont un trigger `workflow_dispatch` pour lancement manuel.

## Pourquoi GitHub Actions ?

- Gratuit illimité sur repo public
- Fonctionne 24h/24 sans Mac allumé
- Remplace n8n localhost:5678
