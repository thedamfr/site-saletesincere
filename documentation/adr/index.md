---
title: Index des ADRs
description: Index complet de toutes les Architecture Decision Records du projet
owner: @thedamfr
status: active
review_after: 2026-10-11
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/adr/index.md
tags: [adr, index, architecture, decisions]
---

# Index des ADRs - Saleté Sincère

**Index complet des Architecture Decision Records du projet.**

## 📋 Tous les ADRs

| #    | Titre | Statut | Date | Domaine | Impact |
|------|-------|--------|------|---------|--------|
| [ADR-0001](./adr_0001_voice_posting_mvp.md) | Voice Posting MVP | ✅ **Implémenté** | 2025-07 | Audio, UI | Cœur |
| [ADR-0002](./adr_0002_voice_posting_mvp_implemented.md) | MVP Implementation Details | ✅ **Implémenté** | 2025-07 | Backend, Storage | Cœur |
| [ADR-0003](./adr_0003_deployment_production_clevercloud.md) | Ancienne production Clever Cloud | 📚 **Historique** | 2025-07 | Infrastructure | Critique |
| [ADR-0004](./adr_0004_rate_limiting_security.md) | Rate Limiting & Security | ✅ **Actif** | 2025-07 | Sécurité | Critique |
| [ADR-0005](./adr_0005_newsletter_brevo_integration.md) | Newsletter Brevo Integration | 🔄 **En cours** | 2025-09 | Newsletter, API | Feature |
| [ADR-0006](./adr_0005_newsletter_doi_automation_approach.md) | Newsletter DOI Automation | ✅ **Accepté** | 2025-09 | Newsletter, DOI | Feature |
| [ADR-0007](./adr_0007_castopod_subdomain_routing.md) | Castopod Subdomain Routing | ⏳ **Attente DNS** | 2025-10 | Podcasting, Routing | Feature |
| [ADR-0008](./adr_0008_migration_pug_vers_html.md) | Migration Pug → HTML | ✅ **Accepté** | 2025-10 | Frontend, Templates | Architecture |
| [ADR-0009](./adr_0009_migration_handlebars.md) | Migration Handlebars | ✅ **Implémenté** | 2025-10 | Frontend, Templates | Architecture |
| [ADR-0010](./adr_0010_podcast_episode_highlight.md) | Podcast Episode Highlight | ✅ **Implémenté** | 2025-10 | Podcasting, UI | Feature |
| [ADR-0011](./adr_0011_podcast_smartlink_multiplateforme.md) | Podcast Smartlink Multiplateforme | ✅ **Implémenté** | 2025-10 | Podcasting, SEO | Feature |
| [ADR-0012](./adr_0012_og_images_smartlinks.md) | OG Images for Smartlinks | ✅ **Implémenté** | 2025-11 | Podcasting, SEO | Feature |
| [ADR-0013](./adr_0013_audio_player_smartlink.md) | Audio Player on Smartlink | ✅ **Implémenté** | 2025-11 | Audio, UX | Feature |
| [ADR-0014](./adr_0014_audio_proxy_waveform.md) | Audio Proxy for Waveform | ✅ **Implémenté** | 2025-11 | Audio, CORS | Feature |
| [ADR-0015](./adr_0015_op3_stats_integration.md) | Preuve sociale podcast via cache OP3 | ✅ **Implémenté** | 2026-08 | Podcast, OP3, pg-boss | Feature |
| [ADR-0016](./adr_0016_homepage_landing_restructuration.md) | Restructuration routing homepage/landing | ✅ **Accepté** | 2025-12 | Frontend, Routing | Architecture |
| [ADR-0017](./adr_0017_identite_claire_et_territoire_charbon_wafer.md) | Identité claire et territoire Charbon & Wafer | ✅ **Accepté** | 2026-09 | Frontend, Identité | Architecture |
| [ADR-0018](./adr_0018_migration_ovh_et_retrait_sale_wall.md) | Production OVH et retrait du Sale-wall | 🚀 **Implémenté** | 2026-09 | Infrastructure, Podcast | Critique |
| [ADR-0019](./adr_0019_preview_podcast_isolee.md) | Preview podcast temporaire | 📚 **Historique** | 2026-09 | Staging, Podcast | Infrastructure |
| [ADR-0020](./adr_0020_livraison_continue_et_staging.md) | Livraison continue et staging complet | 🚀 **Implémenté** | 2026-09 | CI/CD, Kubernetes | Critique |

## 📊 Statistiques

- **Total ADRs** : 20
- **Actifs** : 1 (sécurité)
- **Historiques** : 2 (ancienne production Clever Cloud et preview podcast)
- **Implémentés** : 11 (audio + podcasting + templates + OVH + livraison continue)
- **Acceptés** : 4 (newsletter DOI + frontend)
- **En cours** : 1 (newsletter intégration)
- **Attente** : 1 (podcasting DNS)
- **Draft** : 0
- **Obsolètes** : 0

## 🔍 Recherche par domaine

### 🎙️ Audio & Frontend
- [ADR-0001](./adr_0001_voice_posting_mvp.md) - Voice Posting MVP
- [ADR-0002](./adr_0002_voice_posting_mvp_implemented.md) - Implementation Details
- [ADR-0013](./adr_0013_audio_player_smartlink.md) - Audio Player on Smartlink (MVP)
- [ADR-0014](./adr_0014_audio_proxy_waveform.md) - Audio Proxy for Waveform (Phase 2.1)

### 🏗️ Infrastructure & Déploiement  

- [Guide opérationnel](../hebergement-deploiement.md) - Hébergement, publication GHCR, activation OVH et retour arrière
- [ADR-0003](./adr_0003_deployment_production_clevercloud.md) - Installation Clever Cloud historique
- [ADR-0018](./adr_0018_migration_ovh_et_retrait_sale_wall.md) - Production OVH et retrait du Sale-wall

### 🔒 Sécurité
- [ADR-0004](./adr_0004_rate_limiting_security.md) - Rate Limiting & Security

### 🎨 Frontend & Templates
- [ADR-0008](./adr_0008_migration_pug_vers_html.md) - Migration Pug vers HTML (accepté)
- [ADR-0009](./adr_0009_migration_handlebars.md) - Migration Handlebars (implémenté)
- [ADR-0016](./adr_0016_homepage_landing_restructuration.md) - Restructuration routing homepage/landing (accepté)
- [ADR-0017](./adr_0017_identite_claire_et_territoire_charbon_wafer.md) - Identité claire et territoire Charbon & Wafer (accepté)

### 📧 Newsletter & API Integration  
- [ADR-0005](./adr_0005_newsletter_brevo_integration.md) - Newsletter Brevo Integration (en cours)
- [ADR-0006](./adr_0005_newsletter_doi_automation_approach.md) - Newsletter DOI Automation (accepté)

### 🎙️ Podcasting
- [ADR-0007](./adr_0007_castopod_subdomain_routing.md) - Castopod Subdomain Routing (attente DNS)
- [ADR-0010](./adr_0010_podcast_episode_highlight.md) - Episode Highlight UI
- [ADR-0011](./adr_0011_podcast_smartlink_multiplateforme.md) - Smartlink Multiplateforme
- [ADR-0012](./adr_0012_og_images_smartlinks.md) - OG Images Generation

### 📊 Analytics & Stats
- [ADR-0015](./adr_0015_op3_stats_integration.md) - Preuve sociale podcast via cache OP3

## ✍️ Créer un nouvel ADR

1. **Numéroter** : Prendre le prochain numéro (0005, 0006...)
2. **Template** : S'appuyer sur un ADR existant et sur [`../../AGENTS.md`](../../AGENTS.md)
3. **Front matter** : Ajouter métadonnées (statut, date, domaine)
4. **Mettre à jour** : Cet index après création

**📚 Retour à la doc** : [`../README.md`](../README.md)
