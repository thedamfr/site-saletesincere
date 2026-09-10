---
title: Documentation Technique
description: Navigation vers toute la documentation technique du projet Saleté Sincère
owner: @thedamfr
status: active
review_after: 2026-10-10
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/README.md
tags: [documentation, navigation, adr, security, tdd]
---

# Architecture Decision Records (ADRs)

Documentation technique et décisions architecturales du projet Saleté Sincère.

## 📋 ADRs Essentiels

| Décision | Statut | Impact |
|----------|--------|---------|
| [Voice Posting MVP](./adr/adr_0001_voice_posting_mvp.md) | Historique, désactivé sur OVH | Sale-wall |
| [Production CleverCloud](./adr/adr_0003_deployment_production_clevercloud.md) | Historique, installation distincte | Ancien hébergement public |
| [Migration OVH et retrait du Sale-wall](./adr/adr_0018_migration_ovh_et_retrait_sale_wall.md) | 🚀 Implémenté | Infrastructure |
| [Rate Limiting & Security](./adr/adr_0004_rate_limiting_security.md) | ✅ Actif | Sécurité |

**� Tous les ADRs** : [`./adr/index.md`](./adr/index.md)

## 📚 Documentation Technique

### Hébergement et livraison

- **Procédure actuelle OVH** : [Hébergement et déploiement](hebergement-deploiement.md) — publication GHCR puis activation explicite sur MicroK8s.
- **Direction décidée** : [Livraison continue](livraison-continue.md) — builds sélectifs, staging complet et isolé, activation automatique de `main` en production et preuve de version ; non implémentée.
- **Staging exigé** : [Contrat du staging complet](hebergement-deploiement.md#staging-complet-exigé) — base et worker actifs, stockage/configuration propres, recette métier et coexistence avec la production ; état encore partiel observé séparément.

### 📌 Product Requirements
- **Homepage** : [`./prd_homepage.md`](./prd_homepage.md)
- **Mode dégradé sans base de données** : [`./prd_mode_degrade_sans_bdd.md`](./prd_mode_degrade_sans_bdd.md) - Résilience HTTP, fallback podcast et reconnexion singleton de `pg-boss`
- **Traction podcast et OP3** : [`./prd_traction_podcast_op3.md`](./prd_traction_podcast_op3.md) - Preuve sociale, cache quotidien et activation progressive
- **Épisodes vidéo YouTube** : [`./prd_youtube_podcast.md`](./prd_youtube_podcast.md) - Chaîne publique, résolution des vidéos et cache `pg-boss`

### � Sécurité & Audits
- **Guide d'audit** : [`./audit_guide.md`](./audit_guide.md) - Comment lancer les audits OWASP
- **Plan d'audit OWASP** : [`./owasp_top10_audit_plan.md`](./owasp_top10_audit_plan.md) - Méthodologie complète
- **Rapports d'audit** : [`../security/reports/`](../security/reports/) - Historique des audits
- **Rapport final** : [`./audit_final_report.md`](./audit_final_report.md) - Synthèse sécurité

### �️ Scripts & Outils
- **Scripts migration** : [`../scripts/migrate.js`](../scripts/migrate.js) - Base de données
- **Scripts sécurité** : [`../scripts/audit_*.sh`](../scripts/) - Audits automatisés
- **Setup S3/CORS** : [`../scripts/setup-cellar-cors.sh`](../scripts/setup-cellar-cors.sh) - Configuration stockage

### 🧪 Méthodologie TDD
- **Instructions canoniques** : [`../AGENTS.md`](../AGENTS.md) - Architecture, TDD, sécurité et livraison
- **Instructions Copilot** : [`../.github/copilot-instructions.md`](../.github/copilot-instructions.md) - Renvoi vers la source canonique
- **Exemples ADR** : [`./adr/`](./adr/) - Structure et décisions existantes

### 🏗️ Architecture & Code  
- **Structure projet** : [`../readme.md`](../readme.md) - Vue d'ensemble technique
- **Configuration Docker** : [`../docker-compose.yml`](../docker-compose.yml) - Environnement local
- **Migration SQL** : [`../sql/`](../sql/) - Évolution base de données

## 🎯 Quick Start Documentation

**Pour les nouveaux contributeurs** :
1. Lire [`../readme.md`](../readme.md) - Overview du projet
2. Consulter [`../AGENTS.md`](../AGENTS.md) - Instructions de travail du projet
3. Parcourir [`./adr/index.md`](./adr/index.md) - Décisions architecturales
4. Vérifier [`../todolist.md`](../todolist.md) - Tâches en cours

**Pour le développement** :
1. **Setup local** : [`../readme.md#développement-local`](../readme.md#%EF%B8%8F-développement-local)
2. **Sécurité** : [`./audit_guide.md`](./audit_guide.md) - Lancer les audits
3. **Déploiement actuel OVH** : [Hébergement et déploiement](hebergement-deploiement.md)
4. **Automatisation à construire** : [Livraison continue](livraison-continue.md)
