---
title: Production Deployment CleverCloud
description: Configuration et déploiement de l'application sur CleverCloud avec PostgreSQL et Cellar S3
owner: @thedamfr
status: active
review_after: 2026-01-01
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/adr/adr_0003_deployment_production_clevercloud.md
tags: [adr, infrastructure, clevercloud, postgresql, s3]
adr_number: 0003
date_created: 2025-07
date_deployed: 2025-07-12
impact: critical
production_url: https://app-cb755f4a-25da-4a25-b40c-c395f5086569.cleverapps.io/
---

# ADR 0003 — Production Deployment CleverCloud ✅

## Contexte

Le MVP "Saleté Sincère" a été développé et testé en local. Il faut maintenant le déployer en production sur CleverCloud avec une configuration complète : base de données PostgreSQL, stockage S3/Cellar, et intégration continue via Git hooks.

## Statut : ✅ TERMINÉ

**Date de déploiement** : 12 juillet 2025  
**Version** : Production 1.0  
**URL de production** : https://app-cb755f4a-25da-4a25-b40c-c395f5086569.cleverapps.io/

## Décision

Déploiement complet sur CleverCloud avec :
- **Application Node.js** : Serveur Fastify avec build automatique
- **PostgreSQL addon** : Base de données managée avec variables d'environnement auto-injectées
- **Cellar S3 addon** : Stockage objet compatible S3 pour les fichiers audio
- **Déploiement Git** : Push automatique sur la branche `main`

## Configuration réalisée

### 1. ✅ Application CleverCloud
- **App ID** : `app_cb755f4a-25da-4a25-b40c-c395f5086569`
- **Organisation** : "Saleté Sincère"
- **Type** : Node.js
- **Région** : Paris (PAR)
- **Scaling** : S (développement)

### 2. ✅ PostgreSQL Addon
- **Addon ID** : `addon_ca04b4a7-292e-49ae-9e85-f28b9f75c77b`
- **Nom** : `sale-wall-pgsql`
- **Plan** : DEV PostgreSQL
- **Version** : 15
- **Variables injectées** :
  ```bash
  POSTGRESQL_ADDON_URI=postgresql://user:pass@host:port/db
  POSTGRESQL_ADDON_HOST=blkhybjqferw2aiiybqg-postgresql.services.clever-cloud.com
  POSTGRESQL_ADDON_PORT=50013
  POSTGRESQL_ADDON_USER=udfxl3evwc1n7ipeguk3
  POSTGRESQL_ADDON_PASSWORD=***
  POSTGRESQL_ADDON_DB=blkhybjqferw2aiiybqg
  ```

### 3. ✅ Cellar S3 Addon
- **Addon ID** : `addon_d5a981fe-9f4e-41a7-adde-e3d2a0ccd37a`
- **Nom** : `sale-wall-s3`
- **Plan** : S Cellar S3 storage
- **Endpoint** : `cellar-c2.services.clever-cloud.com`
- **Variables injectées** :
  ```bash
  CELLAR_ADDON_HOST=cellar-c2.services.clever-cloud.com
  CELLAR_ADDON_KEY_ID=AL5E4LISGQCYHU5G83BU
  CELLAR_ADDON_KEY_SECRET=***
  ```

### 4. ✅ Base de données initialisée
- **Tables créées** : `posts`, `votes` avec UUID, indexes et triggers
- **Données de test** : 4 posts avec audio et votes
- **Commandes utilisées** :
  ```bash
  brew install postgresql
  export PATH="/opt/homebrew/opt/postgresql@14/bin:$PATH"
  PGPASSWORD="***" psql -h host -p port -U user -d db -f sql/001_init.sql
  ```

### 5. ✅ Stockage S3/Cellar configuré
- **Bucket créé** : `salete-media`
- **Configuration s3cmd** : Endpoint, credentials, accès public
- **Commandes utilisées** :
  ```bash
  brew install s3cmd
  s3cmd --configure
  s3cmd mb s3://salete-media
  ```

### 6. ✅ Code adapté pour la production
- **Détection environnement** : `process.env.NODE_ENV === 'production' || !!process.env.CELLAR_ADDON_HOST`
- **Stockage conditionnel** : Local en dev (`/uploads/`), S3 en production
- **URLs dynamiques** : `https://cellar-c2.services.clever-cloud.com/salete-media/audio/filename`
- **Logs de debug** : Configuration S3 et base de données visibles au démarrage

## Tests de validation

### 1. ✅ Connexion base de données
- **Statut** : ✅ Connexion réussie
- **Vérification** : Logs `✅ Database connected successfully`
- **Requêtes** : SELECT, INSERT, UPDATE fonctionnels

### 2. ✅ Upload fichiers audio
- **Statut** : ✅ Upload S3 opérationnel
- **Fichiers testés** : 3 fichiers audio uploadés
  - `audio_1752304442181.webm` (3,437 bytes)
  - `audio_1752304625905.webm` (1,519 bytes)
  - `audio_1752304733570.webm` (1,113 bytes)
- **Accès public** : ✅ Fichiers accessibles via navigateur
- **URLs générées** : `https://cellar-c2.services.clever-cloud.com/salete-media/audio/filename`

### 3. ✅ Fonctionnalités métier
- **Enregistrement vocal** : ✅ MediaRecorder fonctionne
- **Transcription manuelle** : ✅ Saisie obligatoire
- **Système de votes** : ✅ Vote par IP, prévention double vote
- **Affichage des posts** : ✅ Liste avec compteurs de votes

### 4. ✅ Interface utilisateur
- **Charte graphique** : ✅ Couleurs, polices, responsive
- **Formulaire inline** : ✅ Dépliable dans le hero
- **Feedback utilisateur** : ✅ Toast notifications, états visuels
- **Accessibilité** : ✅ Labels ARIA, navigation clavier

## Problèmes rencontrés et solutions

### 1. 🔧 Contrainte `audio_path NOT NULL`
- **Problème** : En production, `audio_path` était NULL mais la colonne était `NOT NULL`
- **Solution** : Migration pour permettre `audio_path` NULL en production
- **Commande** : `ALTER TABLE posts ALTER COLUMN audio_path DROP NOT NULL;`

### 2. 🔧 Configuration s3cmd
- **Problème** : Configuration manuelle nécessaire
- **Solution** : Utilisation du fichier de config fourni
- **Commande** : `cp /Users/thedamfr/Downloads/s3cfg ~/.s3cfg`

### 3. 🔧 Outils de production
- **Problème** : PostgreSQL client et s3cmd non installés
- **Solution** : Installation via Homebrew
- **Commandes** : `brew install postgresql s3cmd`

## Métriques de production

### Performance
- **Temps de réponse** : < 200ms pour les pages
- **Upload audio** : ~1-2s pour fichiers < 5MB
- **Connexion DB** : < 100ms
- **Accès S3** : < 150ms

### Capacité
- **Stockage DB** : Plan DEV PostgreSQL
- **Stockage S3** : Plan S Cellar (100GB)
- **Scaling app** : S (1 instance, autoscaling disponible)

### Monitoring
- **Logs applicatifs** : Disponibles via `clever logs`
- **Métriques système** : Console CleverCloud
- **Santé app** : Endpoint `/health`

## Évolutions post-déploiement

### Immédiat
- [x] Tests utilisateurs réels
- [x] Validation du flow complet
- [x] Monitoring des erreurs

### Court terme
- [ ] Métriques d'usage (analytics)
- [ ] Optimisation des requêtes DB
- [ ] Cache pour les posts populaires
- [ ] Compression audio côté client

### Moyen terme
- [ ] Scaling automatique
- [ ] Backup automatique DB
- [ ] CDN pour les assets statiques
- [ ] Monitoring avancé (alertes)

## Retour d'expérience

### Ce qui a bien fonctionné
- **CleverCloud** : Déploiement simple via Git hooks
- **Addons** : Variables d'environnement automatiquement injectées
- **S3/Cellar** : Compatible avec l'écosystème AWS, APIs identiques
- **PostgreSQL** : Performances correctes, pas de latence notable
- **Configuration** : Détection automatique dev/prod via variables d'env

### Points d'attention
- **Timing déploiement** : Attendre que les addons soient créés avant le push
- **Variables d'env** : Bien vérifier l'injection automatique
- **Outils locaux** : Installer les CLI nécessaires pour la maintenance
- **Bucket S3** : Créer manuellement le bucket après l'addon

### Leçons apprises
- Toujours tester la configuration S3 avant le déploiement
- Les migrations de base peuvent être nécessaires entre dev et prod
- La configuration des outils externes (s3cmd, psql) est cruciale
- CleverCloud injecte automatiquement les variables d'environnement des addons
- L'endpoint S3 diffère selon le provider (AWS vs Cellar)

## Conclusion

Le déploiement en production est **100% opérationnel** avec :
- ✅ Application accessible publiquement
- ✅ Base de données PostgreSQL fonctionnelle
- ✅ Stockage S3/Cellar configuré
- ✅ Upload et lecture audio testés
- ✅ Toutes les fonctionnalités MVP validées

Le MVP "Saleté Sincère" est maintenant prêt pour les utilisateurs réels ! 🎉

## Commandes de maintenance

```bash
# Vérifier les addons
clever addon list --org "Saleté Sincère"

# Voir les variables d'environnement
clever addon env <addon-id>

# Accéder à la base de données
export PATH="/opt/homebrew/opt/postgresql@14/bin:$PATH"
PGPASSWORD="***" psql -h host -p port -U user -d db

# Gérer les fichiers S3
s3cmd ls s3://salete-media/
s3cmd info s3://salete-media/audio/filename.webm

# Voir les logs
clever logs
clever logs --deploy
```
