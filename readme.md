---
title: Saleté Sincère
description: Site Saleté Sincère, newsletter, laboratoire du geste et smartlinks podcast
owner: @thedamfr
status: active
review_after: 2026-10-10
canonical_url: https://github.com/thedamfr/site-saletesincere
tags: [audio, platform, fastify, postgresql, tdd]
production_url: https://saletesincere.fr/
---

# Saleté Sincère

Le site Saleté Sincère présente les activités éditoriales, la newsletter, les
smartlinks du podcast et le laboratoire du geste. Le code historique du Sale-wall
subsiste, mais le mur vocal et ses uploads sont désactivés sur la production OVH.

## ✨ Fonctionnalités

- **🎙️ Podcast** : Smartlinks multiplateformes, lecture et métadonnées RSS
- **🎨 Identité** : Landing éditoriale et laboratoire public du geste du logo
- **📧 Newsletter intégrée** : Inscription double opt-in via API Brevo (backend-only)
- **🎨 Design responsive** : Interface adaptée mobile/desktop avec Tailwind CSS v4
- **♿ Accessibilité** : Labels ARIA, navigation au clavier, contraste élevé
- **🔒 Sécurité renforcée** : Rate limiting, validation stricte, audit OWASP Top 10
- **🚀 Hébergement** : MicroK8s sur OVH, PostgreSQL et worker `pg-boss`

---

## 🚀 Stack technique

- **Backend** : Fastify 5.x
- **Templates** : Handlebars (migration depuis Pug terminée ✅)
- **Frontend** : Vanilla JS et SVG animé
- **Styling** : Tailwind CSS v4 + PostCSS + CSS custom
- **Base de données** : PostgreSQL avec UUID
- **Stockage** : PostgreSQL sur OVH ; S3/Cellar réservé au code historique
- **Déploiement** : Image Docker publiée sur GHCR, puis activée sur MicroK8s OVH
- **Dev** : Nodemon + Docker Compose

La production **`saletesincere.fr` est servie par OVH**, derrière Cloudflare.
Au contrôle du 10 septembre 2026 vers 17:10 UTC, `staging.saletesincere.fr`
reste partiel : `/health` signale une base `read_only` et un worker `stopped`.
Le propriétaire demande un **staging complet et isolé**, avec application,
PostgreSQL, worker, stockage nécessaire et configuration propres ; la preview
partielle ne satisfait pas cette demande. Voir
[l'état observé](documentation/hebergement-deploiement.md#prévisualisation-observée-sur-staging)
et [les critères du staging complet](documentation/hebergement-deploiement.md#staging-complet-exigé).
Clever Cloud reste actif séparément et reçoit encore les mises à jour de `main`.

**Une fusion sur `main` publie l’image GHCR, mais ne déploie pas automatiquement
OVH.** Il faut mettre à jour le Deployment avec le tag du commit fusionné puis
vérifier le domaine public. Voir le
[guide d’hébergement et de déploiement](documentation/hebergement-deploiement.md)
et [l’ADR 0018](documentation/adr/adr_0018_migration_ovh_et_retrait_sale_wall.md).

**Direction à suivre :** sélection et build sur les runners GitHub Actions,
publication GHCR, puis déploiement automatique par digest sur Penthouse après
CI verte du push `main` et recette applicative. Le serveur ne reconstruit pas
l’application dans le parcours courant. Cette
[livraison continue](documentation/livraison-continue.md) reste à implémenter.


### Mode dégradé PostgreSQL

Le serveur HTTP démarre sans attendre PostgreSQL ni `pg-boss`. En cas de base
indisponible ou en lecture seule, la landing et le podcast restent accessibles,
les pages épisode utilisent leur contenu RSS. Le worker se reconnecte
automatiquement sans restart.

`GET /health` reste une liveness HTTP en 200 et expose séparément `mode`,
`database.state`, `episodeWorker.state` et `episodeIntents.pending`. Sur OVH,
`DISABLE_WALL=true` fait rediriger `/wall` vers `/` et refuse ses anciennes
écritures en 410, indépendamment de l’état de la base. Les réponses dégradées en
503 du mur ne concernent que les installations où il reste activé.

Voir le [PRD du mode dégradé](documentation/prd_mode_degrade_sans_bdd.md).

---

## 🎨 Système de Templates : Handlebars

### Templating Engine

Le projet utilise **Handlebars** comme moteur de templating côté serveur via `@fastify/view`.

**Pourquoi Handlebars ?**
- ✅ **Syntaxe proche du HTML** : `{{variable}}` au lieu de syntaxe propriétaire
- ✅ **Lisibilité universelle** : Facile à comprendre sans formation
- ✅ **Logique limitée** : Force à garder la logique métier côté serveur
- ✅ **Support IDE natif** : Autocomplétion, validation, formatting
- ✅ **Debugging simple** : Erreurs claires et compréhensibles

### Structure des vues

```
server/views/
├── index.hbs              # Homepage avec posts dynamiques
├── manifeste.hbs          # Page manifeste
├── layout.hbs             # Layout pour futures pages (non utilisé pour l'instant)
├── partials/
│   └── header.hbs         # Header réutilisable (enregistré manuellement)
└── newsletter/
    ├── subscribe.hbs      # Formulaire inscription
    ├── pending.hbs        # Vérification email
    ├── confirmed.hbs      # Confirmation réussie
    └── error.hbs          # Gestion d'erreurs
```

### Utilisation

```javascript
// Configuration Fastify
import handlebars from "handlebars";

// Enregistrer helpers personnalisés
handlebars.registerHelper('eq', (a, b) => a === b);

// Enregistrer partials
const headerPartial = fs.readFileSync("server/views/partials/header.hbs", "utf-8");
handlebars.registerPartial('header', headerPartial);

await app.register(fastifyView, {
  engine: { handlebars },
  root: path.join(__dirname, "server/views")
});

// Dans les routes
app.get("/", async (req, reply) => {
  reply.view("index.hbs", { 
    title: "Saleté Sincère",
    posts,
    stats
  });
});
```

### Syntaxe Handlebars

```handlebars
{{!-- Variables --}}
<h1>{{title}}</h1>
<p>{{stats.total_posts}} récits partagés</p>

{{!-- Conditions --}}
{{#if posts.length}}
  <p>Il y a des posts !</p>
{{else}}
  <p>Aucun post</p>
{{/if}}

{{!-- Boucles --}}
{{#each posts}}
  <article>
    <h2>{{title}}</h2>
    <p>{{duration}}</p>
  </article>
{{/each}}

{{!-- Partials --}}
{{> header}}

{{!-- Helpers personnalisés --}}
{{#if (eq badge 'wafer')}}
  <span>Badge Wafer</span>
{{/if}}
```

---

## � Sécurité

### 🛡️ Statut de Sécurité : ✅ SÉCURISÉ

- **Audit OWASP Top 10** : ✅ Conforme (Score 11/11)
- **Vulnérabilités critiques** : 0 détectée
- **Dernier audit** : 15 juillet 2025
- **Système de protection** : Rate limiting, validation stricte, headers sécurisés

### 🚦 Protections Actives

#### Rate Limiting
- **Posts audio** : 3 uploads/heure par IP
- **Votes** : 10 votes/heure par IP  
- **Newsletter** : 5 inscriptions/heure par IP
- **Navigation** : 100 pages/minute par IP

#### Validation des Données
- **Audio** : Format WebM/Opus, durée 30s-3min, taille max 10MB
- **Champs** : Validation stricte titre/transcription/badge
- **IDs** : Validation UUID pour tous les identifiants

#### Headers de Sécurité
```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

#### Gestion des Erreurs
- Messages d'erreur sanitisés (pas de stack traces)
- Logging sécurisé côté serveur
- Pas d'exposition d'informations techniques

### 🔍 Audit et Monitoring

```bash
# Lancer un audit de sécurité complet
./scripts/prepare_audit.sh full

# Résultats dans security/reports/
```

**📋 Documentation complète** : [`security/README.md`](security/README.md)

---

## �📦 Structure du projet

```
salete-sincere/
├── server.js            # Serveur Fastify principal
├── AGENTS.md            # Instructions canoniques pour les agents et contributeurs
├── server/
│   ├── views/           # ✅ Templates Handlebars
│   │   ├── *.hbs        # Templates Handlebars
│   │   └── partials/    # Composants réutilisables (header)
│   ├── middleware/      # Middleware Fastify
│   │   ├── rateLimiter.js
│   │   └── security.js
│   ├── validators/      # Validation données
│   │   └── audioValidator.js
│   └── newsletter/      # Module newsletter Brevo
│       ├── brevoClient.js  # Client API Brevo
│       └── routes.js       # Routes newsletter (/newsletter/*)
├── .github/
│   └── copilot-instructions.md  # Instructions TDD spécifiques projet
├── public/              # Assets statiques
│   ├── style.css        # CSS compilé
│   ├── custom.css       # CSS custom
│   └── js/
│       └── record.js    # Gestion enregistrement vocal
├── uploads/             # Fichiers audio uploadés
├── sql/                 # Scripts SQL
├── scripts/             # Scripts utilitaires et audit
├── security/            # Audit et documentation sécurité
│   ├── README.md        # Vue d'ensemble sécurité
│   ├── audit_guide.md   # Guide d'utilisation
│   ├── plans/           # Plans d'audit
│   └── reports/         # Rapports de sécurité
├── documentation/       # ADR et docs
│   └── adr/             # Architecture Decision Records
│       ├── adr_0008_migration_pug_vers_html.md  # 📄 Décision migration (historique)
│       └── adr_0009_migration_handlebars.md     # 📄 Migration Handlebars (actuel)
├── castopod/            # Config Docker & docs Castopod (image officielle)
├── style.css            # CSS source (Tailwind)
├── .env                 # Variables d'environnement (dev local)
├── docker-compose.yml   # PostgreSQL + MinIO
├── Dockerfile           # Build production
└── package.json         # Dépendances et scripts
```

---

## ⚙️ Développement local

### Prérequis
- **Node.js** ≥ 24
- **Docker** (via Colima sur macOS)

```bash
# Installation Docker via Colima (macOS)
brew install colima docker docker-compose
colima start

# Vérifier que Docker fonctionne
docker --version
```

### 1. Installation
```bash
git clone <repo>
cd salete-sincere
npm install

# Outils pour l’installation historique Clever Cloud (optionnel)
brew install clever-tools postgresql s3cmd
```

### 2. Configuration
```bash
# Copier et adapter les variables d'environnement
cp .env.example .env
```

### 3. Démarrer les services
```bash
# S'assurer que Docker est démarré
colima status    # Devrait afficher "Running"
# Si arrêté : colima start

# DÉVELOPPEMENT : Lancer PostgreSQL + MinIO/S3
docker-compose up -d

# Vérifier que les services sont UP
docker-compose ps
```

### 4. Initialiser la base de données
```bash
# Initialiser les tables et données de test
docker exec -i salete_pg psql -U salete -d salete < sql/001_init.sql
```

### 5. Compiler le CSS (OBLIGATOIRE)
```bash
# ⚠️ IMPORTANT : Compiler le CSS avant le premier lancement
npm run build:css
```
**🚨 Cette étape est cruciale** : Sans compilation CSS, les styles Tailwind ne seront pas appliqués et l'interface sera cassée.

### 6. Lancer le serveur de dev
```bash
# Mode développement : serveur local avec live reload
npm run dev          # Serveur avec nodemon (port 3000)
npm run dev:css      # Watch CSS (optionnel, terminal séparé)
```

**Note** : En mode développement, seuls PostgreSQL et MinIO tournent dans Docker. Le serveur Node.js tourne en local pour le live reload.

### 7. Accéder à l'application
- **App** : http://localhost:3000
- **S3 Console** : http://localhost:9001 (admin/password: salete/salete123)

---

## 🧪 Tests

Le projet utilise le **Node.js Test Runner natif** (Node.js ≥ 24) — zéro dépendance externe.

### Lancer les tests

```bash
# Lancer tous les tests
npm test

# Mode watch (relance automatique à chaque changement)
npm run test:watch
```

Pour le logo animé, le [contrôle visuel du laboratoire](documentation/logo-animation.md)
vérifie les pixels de 101 étapes dans un navigateur avec `npm run check:logo-animation`.

Certains anciens tests de routes podcast utilisent encore le RSS réel via
`test/helpers/app.js` : la suite par défaut n’est donc pas entièrement hermétique
au réseau. Les tests d’intégration base et plateformes sont opt-in :
`RUN_DATABASE_INTEGRATION_TESTS=true`
avec une `DATABASE_URL` de test pour PostgreSQL, ou
`RUN_EXTERNAL_INTEGRATION_TESTS=true` avec une base de test et les credentials
plateformes requis. Ne jamais pointer ces tests vers la production.

### Structure des tests

```
test/
├── services/
│   └── castopodRSS.test.js    # Tests parser RSS podcast
└── ...                         # Autres tests à venir
```

### Écrire un test

```javascript
// test/services/example.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { myFunction } from '../../server/services/example.js';

describe('My Service', () => {
  it('should do something', async () => {
    const result = await myFunction();
    
    assert.strictEqual(result, 'expected value');
    assert.ok(result !== null, 'Result should exist');
    assert.match(result, /pattern/);
  });
});
```

### Assertions disponibles

Node.js Test Runner utilise le module natif `node:assert/strict` :

- `assert.strictEqual(actual, expected)` - Égalité stricte (`===`)
- `assert.deepStrictEqual(actual, expected)` - Comparaison profonde d'objets
- `assert.ok(value, message)` - Vérifie que value est truthy
- `assert.match(string, regex)` - Test regex
- `assert.throws(() => fn())` - Vérifie qu'une exception est levée
- `assert.rejects(promise)` - Vérifie qu'une promesse est rejetée

**Documentation complète** : https://nodejs.org/api/assert.html

### Données de test

Les fichiers de test data sont stockés dans `test_data/` :

```
test_data/
├── castopod_rss_sample.xml     # RSS complet (20KB) pour tests d'intégration
├── castopod_rss_minimal.xml    # RSS minimal (1KB) pour tests unitaires rapides
└── fake_audio.txt              # Fichier audio fictif
```

### Philosophie TDD du projet

Le projet suit une approche **Test-Driven Development** stricte :

1. **RED** : Écrire le test qui échoue
2. **GREEN** : Implémenter le minimum pour passer le test
3. **REFACTOR** : Améliorer le code sans casser les tests

Cycles courts (≤10 min) avec commits atomiques à chaque phase GREEN.

**📚 Voir** : `.github/copilot-instructions.md` pour les règles TDD complètes

---

## 🎙️ Castopod — configuration locale historique (optionnelle)

Cette section décrit l’ancien environnement local inclus dans ce dépôt, pas le
déploiement courant du Podcast Studio. Ne pas l’appliquer au cluster de production
pour publier le site Saleté Sincère.

Castopod est une plateforme open-source pour héberger et gérer des podcasts. Elle est intégrée au projet pour publier des épisodes longs à partir des posts audio.

### Démarrage rapide

```bash
# 1. Créer le fichier de configuration
cp castopod/.env.castopod.example castopod/.env.castopod

# 2. Démarrer Castopod (nécessite PostgreSQL + MinIO déjà lancés)
docker-compose -f castopod/docker-compose.castopod.yml --profile castopod up -d

# 3. Accéder à Castopod
# Interface web : http://localhost:8000
```

### Services Castopod

Castopod démarre 3 services supplémentaires :
- **castopod** : Application web PHP (port 8000)
- **castopod-db** : Base MariaDB 11.4 dédiée
- **castopod-cache** : Cache Redis pour les performances

### Configuration S3

Castopod utilise un bucket S3 dédié `salete-media-podcast` pour stocker les médias podcast :
- Bucket séparé du bucket principal (`salete-media`)
- Préfixe : `podcast/`
- Configuration dans `castopod/.env.castopod`

### Arrêt de Castopod

```bash
docker-compose -f castopod/docker-compose.castopod.yml --profile castopod down
```

### Documentation complète

Consultez [`castopod/README.md`](castopod/README.md) pour :
- Configuration détaillée
- Création utilisateur admin
- Intégration avec MinIO/Cellar
- Déploiement CleverCloud

**Référence** : [ADR 0006 - Intégration Castopod](documentation/adr/adr_0006_castopod_integration.md)

---

## 🚀 Démarrer TOUS les serveurs en une commande

```bash
# 1. Démarrer PostgreSQL + MinIO/S3
docker-compose up -d

# 2. Démarrer Castopod (MariaDB + Redis + Castopod)
docker-compose -f castopod/docker-compose.castopod.yml --profile castopod up -d

# 3. Démarrer le serveur Fastify
npm run dev
```

**Accès aux services** :
- 🎙️ **App principale** : http://localhost:3000
- 📻 **Castopod** : http://localhost:8000
- 📦 **Console S3** : http://localhost:9001 (salete/salete123)

---

## 🆘 Troubleshooting Rapide

### ❌ Interface cassée / Styles non appliqués
**Symptôme** : L'interface semble cassée, boutons invisibles, pas de styles

**Solution** :
```bash
# Recompiler le CSS Tailwind
npm run build:css
```

**Explication** : Les classes Tailwind CSS ne sont générées que lors de la compilation. Si vous modifiez les templates `.hbs` ou ajoutez de nouvelles classes, il faut recompiler.

### ❌ Erreur de connexion base de données
**Symptôme** : `Connection refused` ou `database salete does not exist`

**Solution** :
```bash
# Vérifier que Docker tourne
colima status
docker-compose ps

# Redémarrer les services si nécessaire  
docker-compose up db s3 -d

# Configurer les permissions MinIO (première fois)
./scripts/setup-local-minio.sh
```

### ❌ Permissions micro non accordées
**Symptôme** : L'enregistrement vocal ne fonctionne pas

**Solution** : Autoriser le micro dans votre navigateur (icône 🔒 dans la barre d'adresse)

---

### 📋 Modes d'utilisation

#### 🛠️ Mode Développement (recommandé)
```bash
# 1. Services seulement (DB + S3)
docker-compose up db s3 -d

# 2. Serveur en local avec live reload
npm run dev
```
✅ **Avantages** : Live reload, debug facile, performance optimale

#### 🐳 Mode Production/Tests
```bash
# Tout dans Docker
docker-compose --profile production up -d
```
✅ **Avantages** : Tester le conteneur localement ; l’orchestration de production
reste MicroK8s et non Docker Compose.

## 🎙️ Enregistrement vocal — historique du Sale-wall

Fonctionnalité conservée dans le code, désactivée sur OVH. Les instructions
ci-dessous ne sont pas une procédure de remise en service en production.

### Utilisation
1. Cliquer sur le bouton "**+ Enregistrer votre histoire**" dans le hero
2. Remplir le titre de l'histoire
3. Cliquer sur "**Commencer l'enregistrement**" (permission micro requise)
4. Parler pendant max 3 minutes
5. Cliquer sur "**Arrêter l'enregistrement**"
6. Écouter la prévisualisation
7. Transcrire manuellement le contenu
8. Choisir le badge (Wafer/Charbon)
9. Cliquer sur "**Partager votre histoire**"

### Contraintes techniques
- **Format audio** : WebM/Opus (navigateurs modernes)
- **Durée max** : 3 minutes
- **Transcription** : Obligatoire pour l'accessibilité
- **Stockage** : Local en dev (`/uploads/`), S3/Cellar en production (`salete-media` pour le mur, `salete-media-podcast` pour Castopod)
- **URLs publiques** : `https://cellar-c2.services.clever-cloud.com/salete-media/audio/[filename]`

---

## 🏗️ Scripts disponibles

```bash
npm run dev          # Développement avec nodemon (serveur seulement)
npm run dev:css      # Watch compilation CSS (optionnel, terminal séparé)
npm run build        # Build complet (CSS + views) pour production
npm run build:css    # ⚠️ OBLIGATOIRE : Compilation CSS Tailwind
npm start            # Démarrage production
```

**💡 Quand utiliser `npm run build:css` ?**
- ✅ **Toujours** avant le premier lancement  
- ✅ Après modification des templates Handlebars  
- ✅ Après ajout de nouvelles classes Tailwind CSS  
- ✅ Si l'interface semble cassée ou les boutons invisibles

---

## 🐳 Tester le conteneur en local

```bash
# Build et lancement complet
docker compose build --no-cache
docker compose up -d

# Accès : http://localhost:3000
```

---

## 🚀 Hébergement et déploiement de production

La procédure de référence est le
[guide d’hébergement et de déploiement](documentation/hebergement-deploiement.md).

- Production : [saletesincere.fr](https://saletesincere.fr), MicroK8s OVH,
  namespace et Deployment `site-saletesincere`.
- Images : `ghcr.io/thedamfr/site-saletesincere:<SHA du commit fusionné>`,
  publiées par [GitHub Actions](.github/workflows/publish-image.yml).
- Activation : mise à jour explicite du conteneur `web` sur OVH, puis contrôle du
  rollout, de l’image active et du domaine public.
- Staging : encore incomplet au relevé du 10 septembre vers 17:10 UTC. La cible
  exige les mêmes critères de santé en mode normal que la production, des tests
  métier sur des données et dépendances isolées, et aucun effet de production.
  Il doit rester disponible pendant les rollouts de production ; voir le
  [contrat du staging complet](documentation/hebergement-deploiement.md#staging-complet-exigé).
- Clever Cloud : installation historique toujours reliée à GitHub. Un déploiement
  réussi sur Clever ne suffit pas à publier sur le domaine public.

### Configuration et données

Sur OVH, PostgreSQL et `pg-boss` restent actifs ; `DISABLE_STORAGE=true` et
`DISABLE_WALL=true` désactivent Cellar/S3 et le mur vocal. Une publication du site
ne doit ni recréer de bucket ni réimporter la base Clever.

Les réglages non sensibles sont portés par le ConfigMap
`site-saletesincere-env`. Les credentials applicatifs et la connexion PostgreSQL
restent dans des Secrets Kubernetes distincts ; ne pas les afficher ou les
recopier dans les commandes, documents ou logs de déploiement.

Les fonctions newsletter, OP3 et YouTube conservent leurs propres paramètres :

- Newsletter : `BREVO_BASEURL`, `BREVO_API_KEY`, identifiants de listes et template
  DOI, `SALENEWS_PUBLIC_BASEURL`.
- OP3 : `OP3_API_TOKEN`, `OP3_GUID`, `OP3_PUBLIC_STATS_ENABLED`. L’activation du
  compteur public exige un cache rempli et vérifié.
- YouTube : `YOUTUBE_CHANNEL_URL`, `YOUTUBE_UPLOADS_PLAYLIST_ID`,
  `YOUTUBE_API_KEY`. La résolution des épisodes se fait dans le worker.

Voir les PRD [newsletter](documentation/adr/adr_0005_newsletter_brevo_integration.md),
[OP3](documentation/prd_traction_podcast_op3.md) et
[YouTube](documentation/prd_youtube_podcast.md) avant de modifier ces fonctions.
Toute migration ou modification de secret nécessite une autorisation distincte.

### Retour arrière

Le retour arrière normal consiste à redéployer l’image OVH précédemment validée,
sans changer les volumes ni la base. Revenir vers Clever est une opération
distincte : vérifier d’abord le routage et la compatibilité des données, sans
supposer les deux bases synchronisées.

L’[ADR 0003](documentation/adr/adr_0003_deployment_production_clevercloud.md)
conserve les procédures Clever/Cellar et les tests de 2025 comme historique.
Ils ne sont plus les consignes de production courante.

---

## 🧪 Développement

### Technologies utilisées
- **Fastify 5.x** : Framework web rapide + @fastify/multipart
- **Handlebars** : Moteur de templates SSR
- **Tailwind CSS v4** : Framework CSS utilitaire
- **PostCSS** : Processeur CSS
- **MediaRecorder API** : Enregistrement audio natif
- **PostgreSQL** : Base de données avec UUID et triggers
- **Nodemon** : Live reload en développement

### Structure du code
- Serveur principal dans `server.js` avec routes API intégrées
- Templates Handlebars dans `server/views/` (*.hbs + partials/)
- JavaScript client dans `public/js/record.js` (classe VoiceRecorder)
- CSS source dans `style.css` (compilé vers `public/style.css`)
- CSS custom dans `public/custom.css` (polices, boutons personnalisés)

### API Endpoints
- **POST /api/posts** : Création d'un post vocal (multipart/form-data)
- **POST /api/posts/:id/vote** : Vote pour un post
- **GET /audio/:filename** : Accès aux fichiers audio

### Routes Newsletter
- **GET /newsletter** : Formulaire d'inscription
- **POST /newsletter/subscribe** : Traitement inscription (double opt-in)
- **GET /newsletter/confirmed** : Page confirmation après clic email

### Tips de dev
- Gardez les DevTools ouverts avec cache désactivé
- Utilisez `npm run dev` pour le live reload
- Rebuilder le CSS avec `npm run build:css` si les classes Tailwind n'apparaissent pas
- Les variables d'env sont dans `.env` pour le dev local
- Permissions micro requises pour l'enregistrement vocal

---

## 🤝 Contribution

### Méthodologie TDD-first
Ce projet suit une approche **Test-Driven Development** stricte :
- **Instructions canoniques** : [`AGENTS.md`](AGENTS.md) - Architecture, sécurité, TDD et livraison
- **Instructions Copilot** : [`.github/copilot-instructions.md`](.github/copilot-instructions.md) - Renvoi vers la source canonique
- **Cycle recommandé pour le code** : critères → test ciblé → code minimal → refactor

### Processus de contribution
1. **Consulter la documentation** : Lire `AGENTS.md` et les ADR liés à la tâche
2. Fork le projet
3. Créez une branche feature (`git checkout -b feature/nouvelle-fonctionnalite`)
4. **Suivre TDD** : ADR minimal + tests d'abord + implémentation minimale
5. Committez vos changements (`git commit -am 'Ajout nouvelle fonctionnalité'`)
6. Push sur la branche (`git push origin feature/nouvelle-fonctionnalite`)
7. Ouvrez une Pull Request

---

## 📄 Licence

Le README historique annonce MIT, mais aucun fichier `LICENSE` n’est versionné
dans ce checkout au 10 septembre 2026. Le texte de licence reste à formaliser.
