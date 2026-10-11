# Qualification de résilience — issue 56

## Summary

Campagne initiale sur VM dédiée : **19 scénarios validés, puis navigation finale
requalifiée séparément** après correction d’un sélecteur du banc. Shutdown,
SIGKILL et trois coupures brutales QEMU sont vérifiés. Données et droits sont
conservés ; reprise métier maximale : 93 secondes. La newsletter incertaine
reste identifiée sans renvoi aveugle. La revue de livraison ajoute des corrections
ciblées SQL/Brevo et du contrôleur CD, avec une requalification distincte
décrite en annexe ; les preuves de la VM conservent leur digest initial.

## Synthèse

Périmètre : site public, podcast, statistiques OP3 et newsletter, avec worker
actif, Sale-wall et stockage S3 désactivés. Le contrat exige une intention
confirmée durablement avant acquittement, aucun doublon nuisible, et un résultat
métier récupérable dans les 300 secondes suivant le retour des dépendances.
Une inscription incertaine est identifiée dans ce délai, sans la compter comme
un envoi réussi.

La campagne RUN6 conserve son échec sur le dernier sélecteur navigateur.
La correction concerne seulement le banc : les 19 autres scénarios restent
inchangés et le parcours corrigé passe séparément sur la même image et la base
conservée. Les preuves distinguent ces deux commandes ; aucune nouvelle
campagne intégrale verte n’est annoncée.

Le banc est une VM Ubuntu Noble, QEMU TCG, deux vCPU, 6 Gio, disque dédié 30 Go,
K3s et PostgreSQL 17.6. Contrôleur, fournisseurs synthétiques et compteurs d’effets
sont extérieurs à la VM. Le réseau invité est restreint ; SSH et HTTP sont
exposés uniquement en loopback. Les sondes HTTP suivent le manifest OVH ; le
script de readiness employé par le staging est vérifié séparément.

Chaque scénario indépendant démarre avec un nouveau pod, tout en conservant les
données PostgreSQL et le journal du fournisseur. Cela évite de cumuler entre cas
le backoff Kubernetes de crashes sans lien. À l’intérieur d’un scénario, aucun
redémarrage de préparation ne vient aider la reprise ; le deuxième crash coupe
une nouvelle tentative réellement commencée. Les délais de retry, expiration et
observation ne sont pas raccourcis.

Les fournisseurs sont simulés, mais HTTP, navigation Chromium avec sandbox,
lecteur WaveSurfer, PostgreSQL, pg-boss, SIGTERM, SIGKILL et coupures QEMU sont
réels. Cette qualification ne prouve ni livraison/réception d’email, ni reprise
après perte de l’hôte physique, ni débit de production sous une charge arbitraire.
Le couplage aux tables pg-boss impose une nouvelle vérification lors d’une montée
de version. Un rollback newsletter exige de conserver le handler protégé ou de
bloquer les inscriptions avant de réactiver l’ancien code ; les tables seules
ne suffisent pas.

Le détail de conception est dans [l’ADR 0024](adr/adr_0024_resilience_aux_coupures.md),
le contrat newsletter dans [son guide](newsletter-recovery.md), et la construction
reproductible du banc dans [son README](../scripts/qualification/README.md).

## Annexes

### Chronométrage et jalons

Début : **11 octobre 2026, 07:53:39 UTC / 09:53:39 Europe/Paris**.
Budget accepté : 3 h 10 à 4 h 30, hors attentes externes. Premier verdict exigé
avant 40 minutes ; signalement de tout blocage de plus de 10 minutes ou dérive
prévisible supérieure à 25 %. Échéance : 16 octobre 2026, 18 h Europe/Paris.

| Étape | Budget | Observation |
| --- | --- | --- |
| Checkout, baseline et frontières | 15–20 min | Checkout isolé de main, baseline 42 fichiers verts, régressions reproduites |
| VM et contrôleur | 15–20 min | Banc PostgreSQL opérationnel à 08:08:12 UTC, soit 14 min 33 s |
| Podcast, OP3 et cycle de vie | 40–60 min | Tests ciblés et PostgreSQL réels ; reprise prolongée et courses corrigées |
| Newsletter et réconciliation | 70–90 min | Journal, historique immuable, CAS, réconciliation ; 8 cas PostgreSQL réels verts |
| Golden Journeys avec coupures | 40–60 min | 20 scénarios réussis ; campagne finale et dérive détaillées ci-dessous |
| Non-régression et dossier | 10–20 min | Suites npm, liens locaux, diff et identité du candidat vérifiés ; preuves archivées |

La qualification et l’arrêt du banc sont achevés à **11:05:08 UTC**, soit
**3 h 11 min 29 s** après le début. La fenêtre de qualification s’étend du
premier banc à 08:22:25 jusqu’à cette clôture : **2 h 42 min 43 s**, corrections
du contrôleur et travaux parallèles inclus. Ce dépassement du lot de 40–60 min
est explicite ; le budget total de 3 h 10–4 h 30 reste respecté.
Dossier finalisé à **11:08:16 UTC**, soit **3 h 14 min 37 s**,
avant archivage et transfert du checkout isolé.

Ces travaux ont été menés en parallèle ; additionner les durées individuelles
ne donne pas la durée murale. Le premier candidat utilisable et ses résultats
RSS/OP3 ont été établis à 08:24:04 UTC, soit **30 min 25 s**, avant le jalon de
40 minutes. Les images intermédiaires
ne sont pas présentées comme la qualification du candidat final.

La campagne précédente a validé 18 scénarios avant un refus du contrôleur,
avant signal : sa vérification SSH consommait le JSON destiné à la coupure
conditionnelle. Le stdin SSH a été isolé, avec une régression reproduite puis
verte. La campagne complète a été relancée à 09:38:31 UTC sur une nouvelle
base synthétique, sans changer l’image applicative. Le dépassement prévisible
de 25 % du budget de la seule qualification a été signalé ; aucun délai de
retry, de coupure ou de reprise n’a été réduit pour compenser.

Cette relance a ensuite révélé une course de l’observateur : la coupure
applicative était bien exécutée (sortie 137, processus remplacé), mais sa
connexion SQL avait déjà disparu quand le contrôleur cherchait l’état « armé ».
La correction accepte une confirmation achevée et vérifiée pour un job
actif, tout en conservant l’ordre strict d’ouverture des fenêtres de commit ;
ses neuf tests passent après reproduction de la course. La campagne complète
reprend à 09:52:39 UTC, toujours sur la même image.
Les campagnes interrompues restent des échecs du banc, jamais des succès globaux.

Une autre assertion tardive a rencontré `lastState: {}` dans Kubernetes,
malgré le compteur de redémarrages et le nouveau conteneur. L’observateur
applicatif exige désormais la mort effective du processus via son pidfd après
SIGKILL. Le contrôleur conserve immédiatement les codes de sortie disponibles,
refuse les contradictions et ne fabrique jamais un code 137 absent. Le mode de
coupure VM garde ses vérifications d’identité et son protocole distincts.
La campagne complète du banc ainsi corrigé démarre à **10:10:18 UTC** sur la
base neuve `site_qualification_candidate7`. Les bases précédentes sont
conservées. Les sources applicatives et le digest restent inchangés depuis
la construction achevée à 08:36:43 UTC.

### Identité et preuves du candidat

Base Git : `df4cf4ba56b2d48130c2bbf54473abef482f5b5d`.
Les modifications locales ne sont pas commitées : le SHA de base n’est donc pas
présenté comme le SHA du contenu candidat. L’image est rattachée à l’empreinte
SHA-256 des entrées runtime, au patch binaire et au digest du manifest OCI.
Les scripts de qualification ont leurs empreintes distinctes dans le rapport.

| Identifiant | Valeur |
| --- | --- |
| Image de la campagne finale | `docker.io/library/site-issue56@sha256:f69f8f7c0e9fb6293238b7e2dd65a6247c79d7b000d6a8e01be4c5ea4d0a5959` |
| Entrées runtime SHA-256 | `7438b33f8a9f3effe312e8079fc0f0e7e7ab757a7052547c4e1d6146ee7d13b7` |
| Patch runtime SHA-256 | `5017755fef3a8794e9039220724b317f0cc757cd4aef96fb0af9b7c85c3a501c` |
| UUID de la VM | `c5bd30a1-af55-48f6-8d3a-6ce3db334e51` |

L’image est importée localement dans la VM ; son nom Docker ne signifie pas
qu’elle a été publiée dans un registre. Le patch runtime désigne les entrées
de construction, pas les documents et outils de qualification ajoutés ensuite.

Le contrôleur écrit `environment.json`, `results.json`, les durées et les captures
dans un dossier neuf hors Git. Les échecs exploratoires sont conservés. Les
options PostgreSQL, clés SSH, adresses de test et réponses brutes n’entrent pas
dans le dossier versionné. Les [preuves expurgées](preuves/issue-56-2026-10-11.json) rattachent les
20 scénarios, commandes, empreintes et événements du contrôleur à ce candidat.
Il s’agit de contrôles locaux ; aucun résultat CI ni aucune review externe
ne sont revendiqués.


### Résultats de la campagne finale

La campagne intégrale RUN6 conserve son **code 1** : 19 scénarios réussis,
puis échec du sélecteur navigateur qui visait encore l’épisode 2, absent des
trois derniers après injection des épisodes 3 à 7. Le parcours corrigé suit
le dernier épisode ; sa requalification ciblée sur la même image et la base
conservée se termine avec le **code 0**. Les 19 corps de scénarios et les sept
autres fichiers du banc gardent leurs empreintes. L’ancien contrôleur est
archivé et son SHA vérifié avant comparaison.

Les **20 scénarios sont donc couverts par deux exécutions** ; aucun succès
global de RUN6 ni nouvelle campagne intégrale verte ne sont revendiqués.
La commande ciblée n’exécute ni migration, ni déploiement, ni nouvelle coupure.
Elle rétablit le catalogue synthétique 0 à 7 en mémoire et vérifie en lecture
seule la base existante, l’image, le journal et les compteurs d’effets.

Le nettoyage final est vérifié à **11:05:08 UTC** : 54.76 minutes
depuis le démarrage de RUN6, requalification et préparation du contrôle incluses.
La VM est arrêtée ; ses disques et les bases synthétiques sont conservés.
Les ports du banc sont fermés après nettoyage. Les images et preuves brutes
sont conservées dans le dossier privé local `.qualification-evidence/`,
exclu de Git ; le banc VM reste dans `/tmp/site-issue56-qualification`.
Ce dernier emplacement est temporaire et ne constitue pas une sauvegarde
après perte ou redémarrage de l’hôte.

| Golden Journey | Durée du scénario | Résultat |
| --- | ---: | --- |
| Candidat par digest, migrations rejouées et droits restreints | 92.276 s | Réussi |
| RSS reconstruit sans visite les caches vides et le trailer avec itemGuid | 7.522 s | Réussi |
| Navigation publique → épisode → lecture audio → lien plateforme | 6.747 s | Réussi |
| PostgreSQL absent puis disponible : HTTP dégradé, refus newsletter et reprise automatique | 116.005 s | Réussi |
| Panne fournisseurs prolongée puis retour : intentions acceptées et OP3 réarmés sans visite | 119.895 s | Réussi |
| Crash pendant traitement après acquittement durable : même intention reprise | 128.315 s | Réussi |
| Crash après commit métier avant acquittement pg-boss : résultat unique | 90.575 s | Réussi |
| Crash avant commit du journal : aucun acquittement ni effet, nouvelle soumission sûre | 50.710 s | Réussi |
| newsletter : double soumission concurrente et identité unique | 1.094 s | Réussi |
| newsletter : demande durable et retour tardif de Brevo | 56.759 s | Réussi |
| newsletter : contact bloqué sans réactivation ni tentative | 1.434 s | Réussi |
| newsletter : crash après effet avant réponse et déduplication | 33.189 s | Réussi |
| newsletter : résultat absent, second crash et aucun renvoi | 89.907 s | Réussi |
| newsletter : échec individuel dans une réponse HTTP 201 | 0.927 s | Réussi |
| newsletter : PostgreSQL en lecture seule refuse tout effet | 98.726 s | Réussi |
| SIGTERM applicatif : arrêt gracieux terminé sans destruction forcée | 38.068 s | Réussi |
| shutdown VM : données acquittées, droits et temporaires | 240.459 s | Réussi |
| crash VM : données acquittées, droits et temporaires | 228.536 s | Réussi |
| Deuxième coupure VM pendant récupération puis résultat métier sous 300 secondes | 653.417 s | Réussi |
| Navigation et lecture audio après coupures réelles (requalification ciblée) | 9.532 s | Réussi |

Ces durées incluent les pannes provoquées et les observations du scénario ;
elles ne désignent pas toutes le délai de reprise. Les remises en condition
entre scénarios sont enregistrées séparément et incluses dans la durée totale.

| Cycle VM | Boot SSH | PostgreSQL depuis lancement VM | HTTP après PostgreSQL | Worker après PostgreSQL |
| --- | ---: | ---: | ---: | ---: |
| Shutdown normal | 57.453 s | 158.248 s | 0.022 s | 50.564 s |
| Coupure brutale | 56.758 s | 158.954 s | 0.043 s | 48.318 s |
| Première coupure pendant traitement | 57.551 s | 166.120 s | 0.026 s | 44.710 s |
| Deuxième coupure pendant récupération | 56.177 s | 158.175 s | 0.020 s | 46.399 s |

Le délai métier maximal observé est **92.955 s**, pour la charge
qualifiée. L’incertitude newsletter est identifiée en **88.277 s** ;
elle n’est pas comptée comme un effet externe confirmé. Les données déjà
acquittées sont aussi relues après chaque cycle.

Le temps PostgreSQL inclut le boot SSH : ne pas les additionner. HTTP et worker
sont sondés après le retour PostgreSQL ; leurs temps sont donc des bornes
d’observation, pas une mesure du premier instant où HTTP était disponible.
Le contrat de 300 secondes commence au retour des dépendances, pas à la coupure
ni au lancement QEMU. Les événements conservent également la durée d’injection
et les changements de boot ID.

Une vérification indépendante en lecture seule compare les sept tentatives
newsletter avant les coupures brutales, puis après une et trois coupures :
identifiants et références inchangés, dates identiques à la milliseconde,
aucun ajout ni perte. Elle ne couvre pas le shutdown normal ni les autres
colonnes ; les protections d’immutabilité sont vérifiées séparément sur
PostgreSQL. Son périmètre et ses empreintes figurent dans les preuves JSON.

### Commandes de validation

| Vérification achevée | Résultat | Durée murale |
| --- | --- | ---: |
| `npm test` — dernière révision du banc | 308 tests : 293 réussis, 15 sautés, aucun échec | 27,667 s |
| `npm run build` | Réussi, empreinte runtime inchangée | 0,815 s |
| `npm run test:e2e` | Trois Golden Journeys réussis | 2,568 s |
| `npm run test:e2e:photography` | Trois Golden Journeys, quatre tests du runner réussis | 3,670 s |
| `npm run test:e2e:resilience` puis `-- --navigation-only` | 19 réussis ; navigateur requalifié séparément | Fenêtre totale 54,76 min |
| Tests PostgreSQL ciblés | Journal : 8 ; queue : 1 ; timeout SQL : 1 ; tous réussis | Voir preuves brutes |
| Contrôleur et observateurs | 8 Python, également sous `-O` ; 10 Python ; 23 JavaScript, tous réussis | Voir preuves brutes |

La dernière suite générale date du 11 octobre à 11:04:22 UTC. Les 15 sauts
concernent des vérifications conditionnelles ; ils ne sont pas comptés comme
réussites. Les tests PostgreSQL ciblés sont exécutés séparément sur le banc.
Les suites navigateur existantes ont aussi produit six captures inspectées.
Les corrections ultérieures du banc n’ont pas changé le runtime ni les parcours
de ces suites ; build et navigateur n’ont donc pas été répétés inutilement.

Node.js 24 est requis. Avec un banc préparé et l’image importée :

```sh
npm test
npm run build
npm run test:e2e
npm run test:e2e:photography
RESILIENCE_VM_STATE=/chemin/prive \
RESILIENCE_DATABASE=site_qualification_candidate8 \
RESILIENCE_OUTPUT=/chemin/prive/preuves-neuves \
E2E_BROWSER_EXECUTABLE=/chemin/chromium \
npm run test:e2e:resilience
git diff --check
```

Choisir une base neuve pour rejouer la campagne complète. La commande ciblée
utilisée pour la navigation exige au contraire la base de la campagne précédente
et ses preuves ; elle n’est pas un substitut aux scénarios de coupure :

```sh
RESILIENCE_VM_STATE=/chemin/prive \
RESILIENCE_DATABASE=site_qualification_candidate7 \
RESILIENCE_PREVIOUS_OUTPUT=/chemin/prive/resilience-run-6 \
RESILIENCE_OUTPUT=/chemin/prive/navigation-neuve \
E2E_BROWSER_EXECUTABLE=/chemin/chromium \
npm run test:e2e:resilience -- --navigation-only
```

Les tests PostgreSQL supplémentaires utilisent uniquement les options privées de
la base du banc, jamais une URI copiée en ligne de commande :

```sh
RESILIENCE_POSTGRES_OPTIONS=/chemin/prive/postgres-options.json \
node test/queues/recovery.postgres.test.js
NEWSLETTER_TEST_DATABASE_OPTIONS=/chemin/prive/postgres-options.json \
node --test --test-isolation=none test/newsletter/postgres.test.js
RESILIENCE_TEST_DATABASE_OPTIONS=/chemin/prive/postgres-options.json \
node --test --test-isolation=none test/resilience/sql-timeout.postgres.test.js
```

Les bases/schémas temporaires de ces tests ciblés sont isolés puis nettoyés.
Les bases de la campagne VM sont conservées après qualification. L’administrateur
synthétique prépare les migrations ; le service utilise un rôle non superuser,
sans création de rôle ni de base. Les droits et les tentatives sont vérifiés à
nouveau après coupure.

Les tests ciblés de réarmement utilisent aussi des lignes artificiellement
anciennes pour vérifier la sélection SQL ; ils ne prouvent pas les délais.
La campagne VM attend les expirations et retries réels. Les réponses externes
simulées couvrent les indisponibilités, délais et résultats Brevo ambigus ;
elles ne couvrent pas toutes les réponses fournisseur malformées. Par exemple,
une réponse Apple HTTP 200 sans tableau `results` reste un résultat partiel.

### Frontières d’acquittement vérifiées

| Intention | Frontière durable | Contrôle de reprise |
| --- | --- | --- |
| Enrichissement podcast | Identifiant pg-boss persisté ou job non terminal déjà confirmé | Même identifiant après crash ; ligne métier unique après commit précédant l’acquittement du job |
| Inscription newsletter | Ligne unique par email normalisé et liste | Crash avant commit : aucun acquittement ni effet ; nouvelle soumission sûre |
| Mutation Brevo | Tentative ajoutée atomiquement avec `ready → sending`, avant l’appel | Réponse perdue : lecture de réconciliation ; résultat absent : `uncertain`, sans second envoi |
| Retour de dépendance | Retour effectif PostgreSQL ou fournisseur dans le contrôleur | Chronomètre métier partagé de 300 secondes ; boot VM et incertitudes rapportés séparément |

Ces frontières sont exercées par les
[scénarios de coupure](../test/e2e/durable-boundaries.mjs), les
[Golden Journeys newsletter](../test/e2e/newsletter-resilience.mjs) et la
[campagne VM](../test/e2e/resilience.test.mjs). Le contrôleur observe les
conditions SQL avant le signal et vérifie le remplacement effectif du processus.
Les compteurs de mutations du fournisseur restent extérieurs à la VM.

### Passage ultérieur en production

Cette préparation ne publie aucune image et n’exécute aucune migration de
production. Pour une livraison autorisée ultérieurement, suivre le guide
d’hébergement, appliquer la migration additive avant le nouveau handler et
qualifier le digest effectivement déployé. Préserver les journaux lors d’un
retour arrière et empêcher le retour de l’ancien envoi aveugle. Les anciennes
limites de jobs sont actualisées sans effacer leurs identifiants ni compteurs.


### Complément de revue avant livraison — 11 octobre 2026

La première publication du candidat `c1327170153e3507755c587a38f0179a0b3fcccf`
a réussi les suites CI et la recette staging. La revue a ensuite confirmé trois
cas absents de cette première qualification. Le candidat suivant les corrige :

- Une erreur de connexion inactive du pool doit déclencher le retry du manager,
  même si sa connexion pg-boss reste saine. Une ligne réutilise le gestionnaire
  d’erreurs existant. RED : deux échecs ciblés ; GREEN : 19 tests pool/manager/RSS,
  avec reprise sans requête HTTP, singleton et arrêt pendant retry.
- Une configuration newsletter exige aussi une liste finale valide, pour éviter
  de réinscrire un contact déjà confirmé. Les mutations refusées en 401/403/404
  restent `ready` et reprennent après réparation ; 400/422 et l’incertitude des
  5xx restent inchangés. RED : 12 échecs ; GREEN : 35 tests client/service/routes.
- Sur PostgreSQL 17.6 jetable, 11 tests réussissent : chaque refus explicite est
  conservé, puis une nouvelle instance reprend ; trois tentatives produisent
  un seul effet confirmé, sans répétition lors d’une nouvelle soumission.

Le staging a également révélé un défaut du contrôle CD : un ancien pod terminal,
absent des endpoints, restait compté parmi les pods devant être prêts. Le calcul
corrigé exige exactement le nombre de pods actifs attendu, tous Running/Ready
avec le digest demandé, et conserve les contrôles du Deployment. Régression
RED puis 20 tests de politique verts ; suite delivery complète : 37 tests verts.
Suivi : [issue 60](https://github.com/thedamfr/site-saletesincere/issues/60).

Les scénarios de coupure de cette page restent attachés à l’image initiale.
Ils ne sont pas présentés comme une nouvelle campagne intégrale du correctif.
Les chemins modifiés sont requalifiés par les tests ciblés ci-dessus, la suite
npm complète, la nouvelle image CI et les Golden Journeys staging. Les SHA,
digests, exécutions CI, installation du contrôleur et contrôles de production
sont rattachés à la [PR 57](https://github.com/thedamfr/site-saletesincere/pull/57).
Les logs RED/GREEN sont conservés dans le dossier privé de livraison.

Non-régression locale après corrections : `npm test` réussit 318 tests, avec
15 ignorés et aucun échec ; build, trois Golden Journeys `test:e2e` et quatre
tests photography réussissent. Le premier lancement photography utilisait
un binaire sans sandbox utilisable sur cet hôte ; son échec est conservé.
Le rejeu définit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` vers Chromium autorisé
et garde `chromiumSandbox: true`. Aucun code applicatif n’a changé entre eux.
