# AGENTS.md — Saleté Sincère

## Objet du projet

Saleté Sincère est une application Node.js qui sert une landing page, un Sale-wall
audio et des pages de podcast. Le dépôt contient une seule application Fastify à la
racine. Ne pas inventer de fonctionnalité, de parcours utilisateur ou de besoin
métier absent de la demande.

Architecture principale :

- `server.js` : composition de l'application Fastify et routes HTTP ;
- `server/views/` : templates Handlebars rendus côté serveur ;
- `server/services/` : RSS Castopod, plateformes podcast, images OG, S3 et OP3 ;
- `server/queues/` : workers et jobs `pg-boss` ;
- `public/` et `style.css` : JavaScript navigateur et styles compilés ;
- `sql/` : migrations PostgreSQL numérotées ;
- `test/` : tests Node.js unitaires et de routes ;
- `documentation/` : PRD, ADR et documentation technique ;
- `security/` : guides et résultats d'audit.

La production publique est hébergée sur le MicroK8s partagé d’OVH, dans le
namespace `site-saletesincere`. PostgreSQL y stocke les données métier et sert
aussi à `pg-boss`. Le Sale-wall et le stockage objet sont désactivés sur cette
cible. Clever Cloud subsiste comme installation historique distincte ; son état
ne prouve pas celui du domaine public. La procédure opérationnelle est dans
`documentation/hebergement-deploiement.md`.

## Avant toute modification

1. Lire `readme.md`, `package.json` et les documents pertinents dans
   `documentation/`, notamment les ADR liés au comportement modifié.
2. Examiner le code existant, les tests concernés et l'état Git avant de proposer
   une solution.
3. Préserver les modifications locales de l'utilisateur et ignorer les changements
   sans rapport avec la tâche.
4. Pour une évolution structurante, une nouvelle interface publique, une migration
   ou un choix difficile à inverser, créer ou mettre à jour un ADR minimal. Une
   correction locale ne nécessite pas d'ADR.
5. Évaluer les risques de sécurité et d'accessibilité pertinents avant toute
   modification d'API, d'upload, de rendu public ou de donnée persistée.

Si les documents et le code divergent, signaler l'écart et privilégier le
comportement actuellement vérifiable, sauf instruction explicite contraire.

## Principes de réalisation

- Privilégier la solution la plus simple qui satisfait la demande.
- Ne pas anticiper de futurs besoins ni ajouter d'abstraction sans usage réel.
- Conserver les interfaces et conventions existantes lorsque cela reste sûr.
- Limiter chaque changement au périmètre demandé.
- Utiliser l'anglais pour le code et les identifiants ; utiliser le français pour
  l'interface et les contenus destinés au public.
- Utiliser `camelCase` en JavaScript, `snake_case` en SQL et `kebab-case` en CSS.
- Mettre à jour la documentation lorsque le comportement, la configuration ou les
  commandes changent.
- Ne jamais exposer de secret, jeton, URI de base complète ou valeur de `.env` dans
  les logs, tests, commandes partagées ou documents.

## Commandes et environnement local

Utiliser en priorité les scripts du `package.json` depuis la racine :

```bash
npm run dev
npm run build
npm test
npm run test:watch
npm run migrate
```

- Node.js 24 ou plus récent est requis ; le projet utilise les modules ES.
- `npm run build` compile notamment `style.css` vers `public/style.css`. Après une
  modification de template ou de classes Tailwind, vérifier le CSS compilé.
- Utiliser `docker compose up -d` pour PostgreSQL et MinIO locaux. Ne pas arrêter,
  supprimer ou recréer des volumes sans demande explicite.
- Avant d'appeler directement un binaire ou `npx`, vérifier qu'un script npm ne
  couvre pas déjà le besoin.
- Garder les serveurs locaux dans des sessions de terminal contrôlables. Ne pas
  installer de mécanisme de persistance sans demande explicite.
- Pour déployer ou diagnostiquer la production, lire d’abord le guide d’hébergement,
  vérifier la cible OVH et limiter les opérations au namespace de cette application.
  Ne pas modifier les autres services du cluster partagé.
- Pour inspecter l’installation historique Clever Cloud, utiliser la CLI `clever`
  et l'alias `sale-wall`.
  Ne jamais recopier les secrets retournés par `clever env`.

## Fastify, templates et API

- Garder la composition des plugins et routes testable via `buildApp()`.
- Les vues sont en Handlebars ; ne pas réintroduire Pug.
- Garder la logique métier et les accès externes hors des templates.
- Préserver le rendu serveur, le HTML sémantique, la navigation clavier, les états
  de focus et les textes alternatifs utiles.
- Les entrées HTTP sont validées côté serveur. Borne stricte des fichiers audio :
  format autorisé, taille, durée et nombre de fichiers.
- Les erreurs publiques restent stables et ne révèlent ni stack trace ni détails
  d'infrastructure.
- Préserver les en-têtes de sécurité, les limites de débit et les politiques CORS
  restrictives.

## PostgreSQL, migrations et mode dégradé

- Les migrations SQL sont numérotées dans `sql/`. Toute migration doit préserver les
  données existantes, documenter le retour arrière et être vérifiée sur PostgreSQL.
- Ne pas supposer qu'une connexion PostgreSQL implique l'autorisation d'écrire : la
  base peut être en recovery ou en lecture seule.
- Les contenus indépendants de la base ne doivent pas attendre un probe PostgreSQL.
- Le serveur HTTP doit pouvoir démarrer lorsque PostgreSQL ou `pg-boss` est
  temporairement indisponible.
- `/health` est une liveness HTTP et reste en 200 ; son payload expose séparément le
  mode, l'état de la base et l'état du worker.
- Les états de base utilisés par le worker sont `unknown`, `unavailable`,
  `read_only` et `read_write`.
- Le Lot 1 garantit `/`, `/podcast` et `/health` sans base. Ne pas étendre cette
  promesse à `/wall`, aux pages épisode ou aux écritures sans implémenter les lots
  correspondants du PRD `documentation/prd_mode_degrade_sans_bdd.md`.
- `ALLOW_DEGRADED_MODE` n'est plus la stratégie de démarrage du Lot 1. Ne pas
  réintroduire une branche de comportement concurrente fondée sur ce flag.

## `pg-boss` et workers podcast

`pg-boss` reste nécessaire pour la résolution des liens d'épisode, les images Open
Graph, le cache associé et les statistiques OP3. Ne pas le remplacer ou le retirer
sans décision produit explicite.

Invariants du worker :

- son démarrage ne bloque pas l'ouverture du port HTTP ;
- une seule tentative ou boucle de retry peut être active ;
- une instance n'est publiée comme prête qu'après `start()` et la création de queue ;
- une instance partiellement initialisée est arrêtée et remplacée au retry ;
- un retour PostgreSQL permet de passer à `ready` sans redémarrer le serveur ;
- l'arrêt de Fastify annule le retry et arrête proprement l'instance active ;
- `DISABLE_WORKER=true` reste réservé aux tests et opérations explicitement sans
  worker.

Tout changement de cycle de vie doit couvrir au minimum le singleton, l'échec de
démarrage, le retry et l'arrêt gracieux.

## Développement piloté par les tests

Pour tout changement de comportement testable, suivre un cycle court :

1. Décrire les comportements attendus et les cas limites.
2. Ajouter un test ciblé et vérifier qu'il échoue pour la bonne raison (RED).
3. Écrire l'implémentation minimale qui le fait passer (GREEN).
4. Ajouter le comportement suivant, un test à la fois.
5. Refactoriser lorsque les tests sont verts.

Les tests utilisent le runner natif `node:test` et `node:assert/strict`. Ils doivent
rester lisibles, suivre Arrange–Act–Assert et tester le comportement plutôt que
recopier l'implémentation. Éviter le sur-mocking et les accès réseau ou I/O réels
dans les tests unitaires.

Ne pas imposer un ADR ou un test artificiel à une modification exclusivement
documentaire. Pour une correction de comportement, ajouter un test de régression
proportionné au risque.

## Documentation et clôture de PRD

- Pour une modification exclusivement documentaire, vérifier au minimum
  `git diff --check`, les liens locaux modifiés et l'éventuel contrôle Markdown
  existant. Ne pas relancer les builds applicatifs par défaut lorsqu'ils ne lisent
  pas ces fichiers ; indiquer explicitement qu'ils n'ont pas été exécutés.
- Lorsqu'un PRD est livré, conserver son état initial comme historique, mettre à
  jour sa version, sa date et son statut, puis consigner les résultats réellement
  vérifiés en production et les suivis non bloquants.
- Garder les faits volatils — versions déployées, résultats de migrations et
  incidents — dans les PRD, README ou runbooks. Ce fichier ne contient que les
  règles de travail durables.
- Si une ambiguïté de PRD modifie le parcours utilisateur, l'interface publique ou
  une décision métier, demander une revue humaine précoce.

## Git, GitHub et déploiement

- Ne pas créer de commit, pousser, ouvrir une PR ou déployer sans demande explicite.
- Garder les commits et PR limités à leur objectif ; ne jamais inclure silencieusement
  des modifications locales sans rapport.
- Ouvrir les PR en draft pendant leur préparation, puis les passer explicitement en
  `Ready for review` lorsqu'elles sont testées et prêtes.
- Pour `gh`, contrôler l'authentification avec l'accès réseau et au trousseau prévu
  par l'environnement. Un échec dans le sandbox ne suffit pas à conclure que le CLI
  est déconnecté.
- Une mise à jour de `main` déclenche la CI, la publication ou réutilisation d'une
  image GHCR validée, puis sa réconciliation automatique par digest sur OVH.
  Attendre le contrôle distinct `Verify OVH delivery` et vérifier le domaine.
  Le commit évalué de `main` peut différer du commit source d'une image réutilisée ;
  conserver cette distinction. L'installation historique Clever reçoit encore `main`.
- Tout déploiement manuel ou retour arrière doit respecter le verrou commun du
  service de livraison. Suspendre le timer et attendre le service avant une
  intervention exceptionnelle, puis suivre `documentation/livraison-continue.md`.
  Ne pas installer de token GitHub sur OVH : le service utilise l'état public validé.
- Un déploiement autorisé n’est terminé qu’après contrôle de l’image réellement
  active sur OVH, des pods, de `/health` et des routes touchées sur le domaine
  public. Un workflow vert ou un statut Clever `running` ne suffit pas.
- Les livraisons du Site doivent notifier le propriétaire via son bot Telegram,
  après réussite vérifiée comme après échec, avec une sévérité fondée sur l'état
  observé du service. Vérifier l'acceptation de l'envoi sans déduire sa réception
  sur le téléphone. Suivre le mécanisme de déduplication du runbook.
- Ne pas réappliquer aveuglément les manifests d’amorçage Kubernetes : leurs tags
  d’image peuvent être anciens. Ne pas modifier DNS, secrets ou ressources
  partagées au titre d’une simple publication applicative.
- Ne jamais lancer une migration de production, modifier une variable Clever ou
  un Secret Kubernetes, ni supprimer une ressource sans autorisation explicite et
  cible vérifiée. Un retour vers Clever demande une décision distincte sur le
  routage et les données ; les bases ne doivent pas être supposées synchronisées.

## Vérifications et compte rendu

Choisir les vérifications proportionnées au changement :

```bash
npm test
npm run build
git diff --check
```

Ne pas prétendre qu'une vérification a réussi si elle n'a pas été exécutée. Si une
commande échoue à cause de l'environnement ou d'un problème préexistant, donner la
commande et l'erreur utile en distinguant clairement ce problème du changement.

À la fin d'une tâche, résumer de façon concise le résultat, les fichiers importants,
les vérifications exécutées et les limites ou prochaines étapes réellement utiles.
