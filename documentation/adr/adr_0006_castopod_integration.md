---
title: Intégration Castopod via /podcast
description: Héberger Castopod aux côtés de l'application Fastify et l'exposer sous saletesincere.fr/podcast tout en réutilisant l'infrastructure existante
owner: @thedamfr
status: implemented
review_after: 2026-01-01
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/adr/adr_0006_castopod_integration.md
tags: [adr, podcast, castopod, clevercloud, minio, reverse-proxy]
adr_number: 0006
date_created: 2025-10-15
date_implemented: 2025-10-15
impact: high
---

# ADR 0006 — Intégration Castopod via `/podcast`

## Contexte

Le projet « Saleté Sincère » dispose déjà d'un mur audio Fastify déployé sur CleverCloud (cf. [ADR 0003](adr_0003_deployment_production_clevercloud.md)). Nous souhaitons publier un podcast avec le CMS Castopod et l'exposer sous la route `saletesincere.fr/podcast` tout en gardant l'application Fastify à la racine. Les contraintes supplémentaires sont :

- **Déploiement CleverCloud** : conserver l'infrastructure existante (app Node.js + addons PostgreSQL et Cellar S3) et ajouter le CMS sans multiplier les points d'entrée publics.
- **Stockage média** : réutiliser MinIO (docker-compose) en local et Cellar S3 en production pour les assets Castopod, afin de centraliser le stockage et profiter des règles de conformité OWASP A05 (Security Misconfiguration).
- **Base de données** : partager l'écosystème si possible. Castopod requiert cependant une base MySQL/MariaDB alors que l'app principale s'appuie sur PostgreSQL.
- **Sécurité** : maintenir les protections en place (headers, rate limiting, validation) et éviter l'exposition de nouveaux vecteurs OWASP A01/A03 via reverse proxy ou configuration TLS.
- **Expérience utilisateur** : offrir une URL unique (`/podcast`) au lieu d'un sous-domaine séparé tout en gardant la performance et l'accessibilité.

Documentation de référence :
- [Castopod — Getting started with Docker](https://docs.castopod.org/main/en/getting-started/docker/)
- `security/README.md`, `security/plans/owasp_top10_audit_plan.md`
- `documentation/adr/adr_0003_deployment_production_clevercloud.md`

## Décision

1. **Infrastructure applicative**
   - Déployer Castopod sous forme d'image Docker officielle (`castopod/castopod:latest`).
   - En local, étendre `docker-compose.yml` pour inclure les services `castopod`, `castopod-db` (MariaDB 11 minimal) et `castopod-cache` (Redis), exposés sur un port dédié (par ex. `http://localhost:8000`).
   - En production CleverCloud, créer une application Docker dédiée pour Castopod et l'associer à un addon MySQL (plan MariaDB minimal) + un addon Redis (optionnel mais recommandé pour la scalabilité Castopod).

2. **Routage et exposition**
   - S'appuyer sur le reverse proxy CleverCloud pour router `saletesincere.fr/podcast` (et sous-routes) vers l'application Castopod, sans modification du serveur Fastify.
   - Documenter la configuration Cloudflare/CleverCloud afin que le mapping par chemin soit résilient (règle `/podcast*` → Castopod) et que le fallback CDN reste cohérent.
   - En local, accéder à Castopod directement via son port dédié (`http://localhost:8000`) ou via un proxy optionnel (ex. `npm run dev` + tunnel `traefik` si besoin de reproduire le chemin).

3. **Stockage média unifié**
    - Dédier un bucket Castopod séparé tout en restant sur MinIO/Cellar :
       - **Local** : créer `salete-media-podcast` dans MinIO via `s3cmd` ou `mc`, avec credentials Castopod dédiés.
       - **Production** : créer un bucket Cellar supplémentaire `salete-media-podcast` et utiliser une paire `CELLAR_*` distincte (ou scope IAM équivalent) pour Castopod.
    - En alternative, conserver un unique bucket `salete-media` en isolant les préfixes (`audio/` vs `podcast/`) si le provisioning d'un second bucket n'est pas possible.
    - Activer les ACL publiques identiques à l'app Fastify et appliquer des policies restreintes par bucket/prefix afin de limiter le risque A01 (Broken Access Control).

4. **Base de données**
   - Provisionner une base MariaDB distincte pour Castopod. Le « partage » de la base Fastify n'est pas possible techniquement (PostgreSQL ≠ MySQL). Nous documentons l'utilisation d'un addon MySQL CleverCloud (ou MariaDB auto-hébergée en dev) et précisons les credentials requis (`MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`).
   - Conserver PostgreSQL pour l'application Fastify ; aucune dépendance croisée n'est introduite.

5. **Sécurité & conformité**
   - Conserver les headers de sécurité Fastify côté application principale et ajouter des tests de non-régression via le plan OWASP (A05 pour la configuration CleverCloud/Cloudflare, A03 pour l'assainissement des paramètres de routage, A07 pour l'accès admin Castopod).
   - Restreindre l'accès à l'interface d'administration Castopod via IP allowlist ou authentification forte (2FA) en production.
   - Vérifier avec CleverCloud que les cookies/session Castopod sont confinés au chemin `/podcast` (SameSite=Lax) et ne contaminent pas l'application principale.

## Conséquences

- ✅ **Expérience unifiée** : `/podcast` rend Castopod accessible sans changer de domaine (routing CleverCloud guidé).
- ✅ **Mutualisation stockage** : MinIO/Cellar servent aussi bien Fastify que Castopod.
- ✅ **Déploiement cohérent** : CleverCloud reste la plateforme unique (2 applications Docker, 3 addons gérés).
- ❌ **Surcharge d'exploitation** : Maintenance d'une stack MariaDB/Redis supplémentaire et coordination multi-applications.
- ❌ **Coûts infra** : Nouveau plan MySQL/Redis chez CleverCloud (devis à prévoir).
- ❌ **Surface d'attaque élargie** : Exposition de Castopod (PHP) nécessite audits réguliers.

## Critères d'acceptation (Given/When/Then)

- **Given** un environnement local démarré via `docker-compose up`, **When** je visite `http://localhost:8000`, **Then** l'interface publique Castopod s'affiche avec les médias servis depuis MinIO.
- **Given** un fichier audio importé dans Castopod, **When** je consulte son URL publique, **Then** elle pointe vers `https://cellar-c2.services.clever-cloud.com/salete-media/podcast/...` et reste accessible.
- **Given** l'application déployée sur CleverCloud, **When** je ping `https://saletesincere.fr/podcast`, **Then** la réponse HTTP provient de Castopod via le routing CleverCloud avec un temps de réponse < 400ms (hors CDN) et les headers de sécurité de `server/middleware/security.js` restent visibles sur le mur Fastify.
- **Given** une tentative d'accès non authentifiée à `https://saletesincere.fr/podcast/cp-admin`, **When** aucune session n'est active, **Then** l'accès est refusé ou redirigé vers un écran de connexion Castopod (A01 mitigé).

## Interfaces publiques

- **Routage CleverCloud** :
   - Règle `/podcast*` → application Castopod
   - Application Fastify conserve la racine `/`
- **Accès local** :
   - Castopod disponible sur `http://localhost:8000` (ou port configuré)
- **Variables d'environnement** (ajouts proposés) :
   - `CASTOPOD_BASE_URL` (défaut : `http://localhost:8000` en dev)
   - `CASTOPOD_PUBLIC_URL` (défaut : `https://<castopod-app>.cleverapps.io`)
   - `CASTOPOD_S3_BUCKET=salete-media-podcast`
   - `CASTOPOD_S3_PREFIX=podcast/`
   - `CASTOPOD_MYSQL_URI`
   - `CASTOPOD_REDIS_URI`
- **Docker Compose** : services `castopod`, `castopod-db`, `castopod-cache` avec volumes `castopod-media`, `castopod-db`, `castopod-cache`.

## Risques OWASP ciblés

- **A01 Broken Access Control** : protéger l'admin Castopod, séparer les préfixes S3, limiter les méthodes HTTP exposées.
- **A03 Injection** : valider et nettoyer les règles CleverCloud/Cloudflare pour éviter les injections d'URL ou d'entêtes X-Forwarded.
- **A05 Security Misconfiguration** : config TLS, S3, reverse proxy ; garantir que les variables Castopod (CP_DISABLE_HTTPS=0) sont correctement définies.
- **A07 Identification & Authentication Failures** : exiger l'activation du 2FA Castopod en production.

## Suivi & tâches associées

1. ✅ **Créer `docker-compose.castopod.yml`** avec services MariaDB, Redis et Castopod
2. ✅ **Configurer le réseau Docker** pour permettre la communication entre les services (réseau externe `sale-wall_salete_net`)
3. ✅ **Fournir `.env.castopod.example`** avec les variables d'environnement nécessaires
4. ✅ **Mettre à jour `README.md`** avec les instructions complètes de démarrage Castopod
5. ⏳ **Documenter la configuration CleverCloud/Cloudflare** pour router `/podcast*` vers Castopod
6. ⏳ **Créer le bucket S3 `salete-media-podcast`** sur MinIO local et Cellar production
7. ⏳ **Audit sécurité Castopod** via `security/plans/owasp_top10_audit_plan.md`

## Mise en œuvre (15 octobre 2025)

### Configuration Docker locale

Le fichier `castopod/docker-compose.castopod.yml` a été créé avec :
- **MariaDB 11.4** : Base de données dédiée avec healthcheck
- **Redis 7.2** : Cache pour améliorer les performances
- **Castopod latest** : Image officielle avec configuration S3

Le réseau Docker `sale-wall_salete_net` est partagé avec le docker-compose principal pour permettre la communication entre MinIO et Castopod.

### Commandes de démarrage

```bash
# Démarrer tous les services
docker-compose up -d  # PostgreSQL + MinIO
docker-compose -f castopod/docker-compose.castopod.yml --profile castopod up -d  # Castopod

# Services disponibles
# - Fastify : http://localhost:3000
# - Castopod : http://localhost:8000
# - MinIO Console : http://localhost:9001
```

### Documentation mise à jour

Le README.md contient maintenant :
- Section dédiée "Castopod - Plateforme Podcast"
- Instructions de démarrage rapide
- Liste des services et ports
- Commande pour démarrer tous les serveurs en une fois

_Status: implémenté en environnement local — déploiement CleverCloud à venir._
