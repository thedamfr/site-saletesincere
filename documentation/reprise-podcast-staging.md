# Reprise de la refonte podcast

Version 4 — 10 septembre 2026. Finition réalisée après les retours du propriétaire
sur téléphone ; version préparée pour revue dans la PR #32. Production inchangée.

## Version proposée

- Identité de la landing : cadre papier, typographies Inter/Oswald, jaquette
  illustrée officielle et carton Charbon & Wafer sombre.
- `/podcast` : description du RSS, trois derniers épisodes comme sur la home,
  épisode populaire OP3 et plateformes.
- Pages épisode : jaquette RSS, titre et lecteur propres à l'épisode, sans carte
  générale du podcast ; liens directs, badges vidéo et statistiques conservés.
- Badges vidéo noir sur jaune, contraste mesuré 11,69:1.
- Cartes populaire et épisode : marge intérieure de 24 à 40 px, hauteur automatique
  de l'image et proportions conservées ; image puis texte sur mobile, deux colonnes
  au-dessus de 900 px. Une jaquette absente n'empêche pas l'affichage du contenu.
- Les trois descriptions (podcast, épisode populaire et page épisode) affichent
  un aperçu de 200 caractères maximum, coupé à un mot, puis « Voir plus » / « Voir moins ».
  Le texte complet s'ouvre sur place avec les paragraphes du RSS. La clarification
  explicite du propriétaire lors de la reprise remplace la note initiale qui
  indiquait que ce comportement avait été annulé.

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

## Vérifications initiales sur le serveur (historique)

Build et tests ciblés exécutés sous Node 24. Les contrôles navigateur ont vérifié
la description RSS, les derniers épisodes, S3E2 avec YouTube et OP3, les badges et
la géométrie de la carte à 320, 390, 430, 768 et 1440 px dans WebKit et Chromium.
Le chevauchement exact de la capture iPhone n'a pas été reproduit dans le WebKit
actuel ; le correctif supprime le dimensionnement relatif en cause et les mesures
sur staging ne montrent aucun chevauchement. Une dernière validation sur iPhone
réel reste utile. Aucun contrôle navigateur n'a été ajouté au pipeline CI.

La suite complète comportait un échec dans `test/routes/episode.test.js` :
S1E5 attendait « 16 octobre 2025 » alors que le test utilisait le RSS réel.
Les tests d'intégration optionnels étaient ignorés.
Les changements locaux de documentation sur la livraison continue ne font pas
partie de cette PR.

Vérification initiale de la branche de PR : `npm run build` et `git diff --check`
réussis ; `npm test` : 159 réussites, 12 ignorés, un échec de date RSS S1E5.

## Reprise sur le Mac — 10 septembre 2026

La branche `codex/podcast-design-staging` a été récupérée au commit `55e7146`.
La revue du diff serveur, RSS et métadonnées de partage n'a pas révélé de
régression bloquante. Ce premier contrôle portait sur le fonctionnement et les
débordements ; la finition des descriptions a été reprise ensuite, ci-dessous.

Recette effectuée dans le navigateur intégré sur le staging existant :

- `/podcast` et `/podcast/3/2` sans débordement horizontal à 320, 390, 680, 768
  et 1440 px ; aucun chevauchement mesuré entre l'image populaire et son texte ;
- lecture audio puis pause au clavier sur S3E2, progression du compteur et
  libellé accessible du bouton vérifiés ;
- cartes de plateformes, liens directs Apple/Spotify/Deezer/YouTube et badges
  vidéo présents ; le lien d'évitement place la prochaine tabulation dans le contenu.

Ces contrôles de largeur ne remplacent pas la validation Safari sur iPhone réel.
Le lecteur a chargé la forme d'onde en environ 16 secondes lors de la recette ;
son fonctionnement et son chargement restent ceux de la version antérieure.

Sans réseau, la suite initiale révélait 22 échecs dans les trois fichiers de
routes épisode, Open Graph et SEO. Ils utilisent désormais les mêmes fixtures
déterministes dans `test/helpers/podcastApp.js`, avec une base simulée indisponible
et sans worker ni stockage. Un cas d'épisode absent est également couvert.

Sous Node 26.7.0 : les 31 tests ciblés de routes et du parser RSS passent.
`npm run build` réussit sans modifier le CSS compilé et `git diff --check` passe.
Deux exécutions de `npm test` après correction donnent chacune 160 réussites,
12 tests optionnels ignorés et un échec dans `ogImageGenerator.memory.test.js`,
inchangé par cette PR : d'abord 63,41 Mo pour un seuil de 60 Mo, puis 11,79 Mo
après warmup pour un seuil de 10 Mo. Le test ciblé avec `--expose-gc` passe ses
deux assertions (−0,30 Mo puis −0,04 Mo). Aucun seuil ni script npm n'a été modifié.
La suite complète avec `NODE_OPTIONS=--expose-gc npm test` réussit ensuite :
161 tests passent, 12 restent ignorés et aucun n'échoue. Cela ne supprime pas
l'instabilité observée avec la commande par défaut.

À ce stade du premier contrôle, les corrections étaient encore locales ; aucun
commit, push, changement de staging, fusion ou déploiement n'avait été effectué.

## Descriptions dépliables après retour visuel

Le propriétaire a confirmé sa demande de textes courts avec « Voir plus ».
Le RSS conserve désormais les paragraphes complets dans `descriptionParagraphs`,
en plus de l'extrait existant utilisé pour les métadonnées. Le rendu commun aux
trois blocs utilise `details` / `summary`, sans dépendre de JavaScript : les textes
de 200 caractères ou moins restent affichés intégralement, les autres s'ouvrent
et se replient sur place. Les chaînes sont échappées par Handlebars.

La jaquette populaire garde ses proportions et est centrée verticalement sur
ordinateur. Sans image, le texte occupe toute la largeur de la carte.

Recette locale sur `http://127.0.0.1:3002/podcast` et `/podcast/3/2`, avec un
instantané du RSS public et des données de présentation relevées sur staging :
ouverture et fermeture des trois descriptions, clavier, texte intégral (10
paragraphes pour le podcast et 15 pour S3E2), absence de débordement du texte
déplié à 320, 390, 768 et 1440 px. Cette prévisualisation ne consulte pas PostgreSQL.

Validation après modification : `npm run build`, `git diff --check` et
`NODE_OPTIONS=--expose-gc npm test` réussis ; 169 tests passent et 12 tests optionnels
restent ignorés. L'instabilité du test mémoire sans GC explicite reste celle
documentée plus haut. Le staging distant sert encore la version initiale de la PR.

## Finition des jaquettes et préparation de la PR

Après ouverture de la prévisualisation via Tailscale sur son téléphone, le
propriétaire a demandé une marge autour de la jaquette populaire et l'affichage
de cette même jaquette sur la page épisode. Les deux cartes partagent désormais
une grille responsive avec marge intérieure ; le texte occupe toute la carte si
le RSS n'a pas de jaquette. Aucune image n'est recadrée ou étirée.

La prévisualisation temporaire sur le Mac reste accessible aux mêmes adresses
Tailscale, avec `?preview=covers-6` pour éviter le HTML précédent conservé en cache.
Le listener est limité à l'interface Tailscale et relaie le serveur local ; aucun
service persistant n'a été installé. Le staging OVH n'a pas été actualisé.

Validation finale sous Node 26.7.0 : `npm run build` et `git diff --check` réussis ;
`NODE_OPTIONS=--expose-gc npm test` : 171 tests réussis, 12 tests optionnels ignorés,
aucun échec. Le test de couverture épisode a été vérifié en échec avant ajout de
l'image, puis en réussite ; le cas sans image est couvert. La réserve sur le test
mémoire sans GC explicite demeure documentée ci-dessus.

Contrôle navigateur via Tailscale : jaquette chargée, ratio carré préservé, marge
de 24 px sur téléphone, absence de chevauchement et de débordement à 320, 390,
768, 900, 1024 et 1440 px. La revue indépendante des descriptions, métadonnées et
tests n'a trouvé aucun blocage. La fusion et le déploiement de production restent
des opérations distinctes, non effectuées dans cette reprise.
