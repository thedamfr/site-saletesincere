# Reprise de la refonte podcast

État au 10 septembre 2026. PR de travail destinée à être reprise sur le MacBook.

## Version proposée

- Identité de la landing : cadre papier, typographies Inter/Oswald, jaquette
  illustrée officielle et carton Charbon & Wafer sombre.
- `/podcast` : description du RSS, trois derniers épisodes comme sur la home,
  épisode populaire OP3 et plateformes.
- Pages épisode : titre et lecteur propres à l'épisode, sans carte générale du
  podcast ; liens directs, badges vidéo et statistiques conservés.
- Badges vidéo noir sur jaune, contraste mesuré 11,69:1.
- Carte populaire : hauteur automatique de l'image, proportions conservées et
  image puis texte dans le flux normal sur mobile ; deux colonnes sur desktop.
- La tentative de paragraphes avec « Lire la suite » après 200 caractères a été
  annulée à la demande du propriétaire. Ne pas la réintroduire implicitement.

## Staging actuellement servi

URL : https://staging.saletesincere.fr/podcast ; exemple : `/podcast/3/2`.
Namespace : `site-saletesincere`, Deployment et Service : `site-saletesincere-preview`.
Image de base : `ghcr.io/thedamfr/site-saletesincere:f03a1be99bd48ae839f08e9cf310cf87aa1b99f3`.
ConfigMap immuable : `podcast-preview-a82c4c5e5ad7`. Les fichiers montés sous `/app`
sont `server.js`, `server/services/castopodRSS.js`, `server/views/podcast.hbs` et
`public/style.css`. Cette preview n'est pas une nouvelle image applicative.

Le Secret PostgreSQL existant est référencé via `DATABASE_URL`, après accord
explicite du propriétaire. `PGOPTIONS=-c default_transaction_read_only=on` règle
les sessions en lecture seule ; ce n'est pas un rôle PostgreSQL restreint.
`DISABLE_WORKER`, `DISABLE_STORAGE` et `DISABLE_WALL` restent à `true`.
`OP3_PUBLIC_STATS_ENABLED=true` et `YOUTUBE_CHANNEL_URL=https://www.youtube.com/@CharbonWafer`.
Le lancement appelle `buildApp()`, amorce `databaseAvailability.check()` sans
attente bloquante, puis ouvre HTTP. `/health` retourne `degraded/read_only/stopped`.
Les caches sont actualisés par le worker de production.

L'Ingress staging conserve son `noindex`, son DNS et son certificat. La production
reste sur son Deployment initial avec `normal/read_write/ready`.
Ne pas réappliquer `k8s/ovh/ingress.yaml` : il cible encore le Service production.

Tailscale temporaire : http://100.98.206.59:3001/podcast, via une session
`kubectl -n site-saletesincere port-forward --address 100.98.206.59
service/site-saletesincere-preview 3001:3000`. Le tunnel doit être rouvert après
un remplacement du pod ; il ne constitue pas un service persistant.

## Quota et publication ultérieure

La preview utilise la marge du quota qui sert normalement au pod supplémentaire
d'un rollout de production. Son rollout est `maxSurge: 0`, `maxUnavailable: 1`.
Avant un déploiement production, coordonner l'arrêt de la preview
(`scale deployment/site-saletesincere-preview --replicas=0`) pour libérer cette
marge. Ne pas modifier le quota ou le rollout de production implicitement.
Une fusion déclenche la publication GHCR et le déploiement historique Clever ;
l'activation OVH reste distincte. Cette PR ne fusionne et ne déploie pas la production.

## Vérifications et limites

Build et tests ciblés exécutés sous Node 24. Les contrôles navigateur ont vérifié
la description RSS, les derniers épisodes, S3E2 avec YouTube et OP3, les badges et
la géométrie de la carte à 320, 390, 430, 768 et 1440 px dans WebKit et Chromium.
Le chevauchement exact de la capture iPhone n'a pas été reproduit dans le WebKit
actuel ; le correctif supprime le dimensionnement relatif en cause et les mesures
sur staging ne montrent aucun chevauchement. Une dernière validation sur iPhone
réel reste utile. Aucun contrôle navigateur n'a été ajouté au pipeline CI.

La suite complète comporte un échec connu dans `test/routes/episode.test.js` :
S1E5 attend « 16 octobre 2025 » alors que le test utilise le RSS réel. Ne pas annoncer
une suite entièrement verte. Les tests d'intégration optionnels restent ignorés.
Les changements locaux de documentation sur la livraison continue ne font pas
partie de cette PR.

Vérification finale de la branche de PR : `npm run build` et `git diff --check`
réussis ; `npm test` : 159 réussites, 12 ignorés, un échec de date RSS S1E5.
