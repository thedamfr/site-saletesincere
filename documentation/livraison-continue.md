# Livraison continue vers OVH

Version 5 — **11 septembre 2026**. CI, staging et livraison de production
livrés et vérifiés. La recette et la correction du retrait des pods sont
consignées dans la section de livraison.
La décision est décrite dans [l’ADR 0020](adr/adr_0020_livraison_continue_et_staging.md).

## Publier

Une PR exécute les tests, le build CSS, les migrations sur PostgreSQL jetable
(deux exécutions successives) et le rendu Kustomize. Après merge sur `main`,
`Validate and publish` compare toutes les entrées de l’image à celles d’un
artefact validé. Il construit et publie sur GHCR seulement si elles diffèrent.
Un changement documentaire peut donc réutiliser un digest validé en staging,
même lorsque le commit évalué est un nouveau merge. Les chemins inconnus
provoquent une reconstruction. L’absence d’un artefact encore conservé déclenche
également un build, ce qui permet une reprise après expiration des artefacts.

Le run écrit un manifeste public dans la branche `codex/delivery-state` :
commit évalué, commit source de l’image, digest, empreinte des entrées, empreinte
des migrations et hash du CSS. Il ne contient aucun secret. Le service OVH attend
la réussite complète du run, en vérifie la provenance et la tête de branche, puis
active le digest. La production accepte uniquement `main`.

Le service `site-saletesincere-delivery.timer` vérifie cet état toutes les minutes.
Il tourne sous `site-delivery`, avec un accès Kubernetes limité aux deux
Deployments applicatifs et à la lecture des pods/quotas du namespace.
Aucun token GitHub n’est stocké sur OVH et aucun port entrant n’a été ouvert.
L’image est téléchargée depuis le registre public GHCR. Le token GitHub reste
sur les runners pour la publication et les statuts de recette.

`Verify OVH delivery` attend la version attendue sur le domaine public puis
contrôle la santé normale, les pages, l’épisode, les redirections et le CSS.
Il publie le statut `OVH / production` ou `OVH / staging`. Un échec ou un délai
dépassé reste rouge. Le service contrôle aussi les imageID des pods ; son journal
et son fichier d’état conservent cette preuve distincte de la recette HTTP.

## Notifications Telegram

Après une réussite de staging ou de production, le service refait deux recettes
publiques à 30 secondes d'intervalle, puis notifie le propriétaire via son bot
existant. Le message donne l'environnement, la sévérité, le commit évalué,
la version attendue et observée, le digest et les liens du site et du run GitHub.
Un succès n'est jamais annoncé sur la seule publication GHCR.

Les échecs de rollout et de recette sont notifiés, y compris lors d'une nouvelle
tentative d'un même run. Les échecs de tests, build ou publication sont relevés
dans les 100 derniers runs GitHub toutes les cinq minutes, même sans manifeste
de livraison. Une publication réussie restée sans activation après quinze minutes
est également signalée. Les PR et les annulations remplacées par une demande
plus récente ne produisent pas de message ; l'historique antérieur à l'activation
des notifications n'est pas rejoué.

| Sévérité | Observation |
| --- | --- |
| INFORMATION | Déploiement réussi, version et recette vérifiées |
| AVERTISSEMENT | Échec de staging, ou livraison bloquée avec production toujours saine |
| ÉLEVÉE | Production répondant en mode dégradé, ou version attendue active dont la recette échoue |
| CRITIQUE | Production injoignable ou en erreur HTTP, après deux observations depuis OVH |

Les credentials restent dans les fichiers existants du bot, transmis au service
par `LoadCredential`. Ils ne sont ni exportés vers GitHub ni inclus dans les images
ou les logs. Le destinataire doit être un chat privé positif, lié au même bot.
L'installateur crée deux références locales sous `/etc/credstore`, sans recopier
les valeurs. Ces identifiants sont facultatifs au démarrage de systemd : leur
absence fait échouer l'envoi, sans empêcher le réconciliateur de démarrer.
Le relais conversationnel, son historique et sa configuration restent inchangés.

`/var/lib/site-saletesincere-delivery/notifications.json` conserve le point de
départ, les runs récemment consultés et les accusés d'acceptation Telegram, sans
token ni identifiant de chat. Un run, résultat et niveau de sévérité déjà accepté
n'est pas réémis. Une récupération après échec peut donc envoyer un succès ; une
aggravation peut envoyer une autre sévérité. Les refus sont journalisés et repris
après cinq minutes, sans refaire le déploiement. Un crash entre l'acceptation
Telegram et la sauvegarde du reçu peut néanmoins produire un doublon au retry.
L'acceptation par l'API ne prouve pas la réception sur le téléphone.

Le mécanisme dépend de l'hôte OVH et de l'accès aux API publiques GitHub/Telegram.
Une panne complète de cet hôte ne peut être signalée par ce même service ; les
statuts GitHub restent un contrôle indépendant. Si Telegram est indisponible,
consulter son erreur dans le journal du service et le prochain retry enregistré.

Recette du 11 septembre 2026 : 193 tests réussis, 12 intégrations externes
ignorées, build et contrôles de syntaxe réussis. Le
[run staging 34580876597](https://github.com/thedamfr/site-saletesincere/actions/runs/34580876597)
a été activé en 23 secondes ; après deux recettes publiques, Telegram a accepté
le message de succès à 08:50:48 UTC. Le
[run contrôlé 34580878785](https://github.com/thedamfr/site-saletesincere/actions/runs/34580878785)
demandait volontairement une publication production hors `main` : il a échoué
sur `Production requires main`, avant tout build ou activation. La production
est restée saine et son pod inchangé ; Telegram a accepté l'AVERTISSEMENT
à 08:51:52 UTC. Ces reçus prouvent l'acceptation par l'API, pas la lecture des
messages sur le téléphone. La [PR 36](https://github.com/thedamfr/site-saletesincere/pull/36)
consigne également la notification du déploiement de production après fusion.

## Livrer un candidat en staging

```bash
gh workflow run publish-image.yml --repo thedamfr/site-saletesincere \
  --ref <BRANCHE_CANDIDATE> -f environment=staging -f force_build=false
```

L’option `force_build=true` reconstruit même si les entrées sont identiques.
Une demande manuelle `production` est refusée hors `main`. Les anciens tags
`image-*` ne déclenchent plus de livraison.

[Staging](https://staging.saletesincere.fr) utilise le Deployment
`site-saletesincere-staging`, PostgreSQL `site-saletesincere-staging-postgres`,
un PVC de 4 GiB et des identifiants dédiés. Ses règles réseau bloquent l’accès
au PostgreSQL de production. Le worker est actif. Les migrations sont appliquées
sur une base neuve, sans copie des données ni des jobs de production.

Les intégrations podcast consultent les services en lecture. La newsletter
utilise l’API interne `site-saletesincere-staging-brevo`, sans sortie réseau et
sans credential Brevo réel. Elle permet de tester la soumission du formulaire
avec une adresse synthétique ; elle n’envoie aucun email. La réception effective
d’un DOI chez Brevo n’est donc pas couverte par cette recette.

Le mur et S3 restent désactivés comme en production. Le staging conserve
`noindex`. L’ancienne preview reste démarrée pendant la transition et ne sert
plus l’Ingress staging ; aucune de ses ressources n’a été supprimée.

## Exploitation et contrôle

```bash
ssh penthouse 'sudo -n systemctl status site-saletesincere-delivery.timer --no-pager'
ssh penthouse 'sudo -n journalctl -u site-saletesincere-delivery.service -n 20 --no-pager'
ssh penthouse 'sudo -n cat /var/lib/site-saletesincere-delivery/production.json'
ssh penthouse 'sudo -n cat /var/lib/site-saletesincere-delivery/staging.json'
```

Ces deux fichiers d’état sont non sensibles. Ils enregistrent le commit évalué,
le commit image, le digest, la version précédente, la date, la durée et le résultat.
Ne pas afficher le fichier `kubeconfig` présent sous `/etc/site-saletesincere-delivery`.
Les sources installées sous `/opt/site-saletesincere-delivery` sont épinglées à une
révision connue dans `config.json` ; elles ne sont pas remplacées par les artefacts
applicatifs. Une évolution de cet outillage nécessite une installation revue via
[install.py](../scripts/delivery/install.py), puis la vérification du service.

Les [manifests staging](../k8s/staging/) sont distincts de
[l’amorçage production](../k8s/ovh/). Le placeholder `bootstrap-required` doit être
remplacé par un digest validé avant leur première application. Une publication
ordinaire ne réapplique aucun de ces ensembles : elle modifie uniquement l’image,
sa métadonnée de digest et les contrôles de readiness du Deployment concerné.

## Disponibilité, migrations et retour arrière

Les deux applications conservent `maxUnavailable: 0` et `maxSurge: 1`. La readiness
vérifie `normal/read_write/ready` ; `/health` reste une liveness HTTP en 200.
Le nouveau pod doit rester prêt 10 secondes et le hook `preStop` laisse 15 secondes
aux routes et connexions avant l’arrêt du processus.
Le quota du namespace couvre 5 CPU et 6 GiB de limites, 2 CPU et 3 GiB de demandes,
deux PVC et 8 GiB de stockage. Il laisse une marge pour les deux rollouts sans
arrêter staging. La publication vérifie cette marge avant mutation.

Le service compare l’empreinte des migrations à celle validée dans sa configuration.
Une migration nouvelle ou modifiée bloque avant activation. Il n’exécute aucune
migration de production. L’opérateur doit faire la recette PostgreSQL, vérifier
la compatibilité et le retour arrière, puis actualiser cette empreinte.

Le retour normal consiste à revert le changement applicatif et laisser la CI
livrer le nouvel état de `main`. Pour une urgence : arrêter le timer, attendre la
fin du service, puis utiliser le verrou commun
`/var/lib/site-saletesincere-delivery/activation.lock` avec `flock` avant d’activer
le digest précédent. Vérifier le schéma et refaire la recette. Ne réactiver le
timer qu’après avoir corrigé la version souhaitée, sinon il rétablirait `main`.
Ne pas supprimer un pod, volume ou Secret pour forcer un rollout.

## Recette de livraison

Le 11 septembre 2026 : 181 tests réussis, 12 intégrations externes ignorées,
build et rendu Kustomize réussis. Les 10 migrations ont été appliquées sur une
base CI jetable, puis réexécutées sans changement. Le staging a aussi reçu ces
10 migrations sur sa propre base et son propre PVC.

Le [run staging 34574005832](https://github.com/thedamfr/site-saletesincere/actions/runs/34574005832)
a publié le commit image `bf099cb0de9dc4dd412c3b195ab2dd7dfa57e2e8`, digest
`sha256:12fbabc9fc470ea916949d350e6587e1404a16f75ebd4047ade2a2d05b5b3262`.
Le service a activé et vérifié cette version automatiquement en 18 secondes,
le 11 septembre à 07:24:54 UTC.

Recette staging : santé normale, accès réseau PostgreSQL production bloqué,
job `resolve-episode` et job `op3-stats-refresh` terminés, cache d’épisode écrit,
formulaire newsletter reçu par l’API de test, pages et asset CSS vérifiés.
Le navigateur a confirmé le rendu podcast, l’ouverture de la description,
la jaquette d’épisode et les liens résolus Spotify/YouTube.

La [PR 31](https://github.com/thedamfr/site-saletesincere/pull/31) a été fusionnée
au commit évalué `e62bd3e044d6f8ed82d7fc874532cb4076de9291`.
Le [run main 34574712054](https://github.com/thedamfr/site-saletesincere/actions/runs/34574712054)
a réutilisé le digest staging sans nouveau build Docker. OVH l’a activé et vérifié
le 11 septembre à 07:33:22 UTC (12 secondes), et le
[contrôle GitHub distinct](https://github.com/thedamfr/site-saletesincere/actions/runs/34574871790)
a réussi. Les deux domaines étaient alors `normal/read_write/ready`.

La sonde publique a cependant enregistré un timeout de 8 secondes à 07:33:18 UTC,
pendant le retrait de l’ancien pod, puis des réponses normales. Ce premier
rollout ne constitue donc pas une preuve d’absence d’interruption. L’ancien
pod ne possédait pas de hook de drainage ; le lien causal est une hypothèse
cohérente avec la chronologie, sans trace réseau permettant de l’affirmer.
Le durcissement ajoute `minReadySeconds: 10`, conserve le nouveau pod avant le
retrait de l’ancien et porte le `preStop` des nouvelles versions à 15 secondes.
La recette GitHub est répétée après 30 secondes de stabilité et expose son
résultat dans le résumé du run. Une nouvelle mesure des deux domaines vérifie
ces rollouts avec [check-availability.mjs](../scripts/delivery/check-availability.mjs).

Le [run staging 34575412587](https://github.com/thedamfr/site-saletesincere/actions/runs/34575412587)
a livré le correctif `f06f1a4d56cdb4a3444247054fe2f160a95a1bf6`, digest
`sha256:687496f9de669c13effd0c82772c7f6fd18a4ab40e18065ffeee518c12449d92`,
automatiquement en 23 secondes, à 07:46:20 UTC. Un second remplacement du pod
staging, sous le verrou commun, a vérifié le retrait d'un pod possédant déjà
le nouveau hook. Les deux recettes HTTP espacées de 30 secondes ont réussi.
Entre 07:37:08 et 07:49:03 UTC, la sonde a enregistré 699 réponses normales
sur chacun des deux domaines, sans erreur, pendant ces deux rollouts staging.
La [PR 33](https://github.com/thedamfr/site-saletesincere/pull/33) consigne également
le résultat de l'activation et du contrôle de production après sa fusion.

La PR 33 a été fusionnée au commit évalué
`d8ee318fc96ef0a4e01b38fda230d82a0a2c5bf0`.
Le [run main 34576426165](https://github.com/thedamfr/site-saletesincere/actions/runs/34576426165)
a réutilisé le digest `sha256:687496f9de669c13effd0c82772c7f6fd18a4ab40e18065ffeee518c12449d92`
sans build Docker. OVH l'a activé et vérifié en 18 secondes, à 07:55:03 UTC.
La [double recette GitHub](https://github.com/thedamfr/site-saletesincere/actions/runs/34576546599)
a réussi ; les deux domaines et leurs pods exécutent cette image, avec base
`read_write`, worker `ready` et aucun redémarrage des pods applicatifs.
Le navigateur a également confirmé la page podcast publique.

Entre 07:37:08 et 07:56:06 UTC, la sonde a enregistré 1 112 réponses normales
sur chacun des deux domaines, soit 2 224 réponses sans erreur. Cette fenêtre
couvre les deux rollouts staging et le rollout de production renforcé, avec une
mesure chaque seconde. Elle ne supprime pas le timeout initial de 07:33:18 UTC,
ni ne garantit la disponibilité hors de la fenêtre mesurée.

Suivis non bloquants : la réception d'un véritable email DOI n'est pas testée
par la sandbox ; l'ancienne preview et ses ressources sont conservées. Toute
évolution de schéma exige une validation opérateur distincte avant activation.


<details>
<summary>Audit initial du 10 septembre 2026, conservé comme historique</summary>

Audit documentaire du **10 septembre 2026**. La cible décrite ci-dessous est
**direction décidée, non implémentée** : cette documentation n'active aucun workflow,
accès déployant ou déploiement. La procédure actuelle reste le
[guide d'hébergement et de déploiement](hebergement-deploiement.md).

## Fonctionnement vérifié

Le [workflow de publication](../.github/workflows/publish-image.yml) construit
l'image du site sur les pushes de `main`, les tags `image-*` et les lancements
manuels. Il publie sur GHCR un tag égal au SHA complet du commit, avec un cache
Docker et une cible `linux/amd64`. Il n'exécute ni tests applicatifs, ni sélection
par chemins, ni déploiement OVH, ni recette de production. Aucun workflow de
contrôle des pull requests ni playbook Ansible n'est versionné dans ce dépôt.
Les tests existent et sont exécutables via le [package.json](../package.json) ;
leur présence ne signifie pas qu'ils bloquent une publication en CI.

À la date de l'audit, le Deployment `site-saletesincere`, conteneur `web`, utilise
l'image `ghcr.io/thedamfr/site-saletesincere:f03a1be99bd48ae839f08e9cf310cf87aa1b99f3`.
Ce SHA correspond au `main` local observé et à une
[publication GHCR réussie](https://github.com/thedamfr/site-saletesincere/actions/runs/34466109980).
Cette concordance ponctuelle ne prouve ni une activation automatique, ni une
validation fonctionnelle exhaustive de cette version.

Le domaine public cible le Service `site-saletesincere`. Le staging cible
`site-saletesincere-preview`. Au relevé initial vers 15:54 UTC, cette
[prévisualisation partielle](hebergement-deploiement.md#prévisualisation-observée-sur-staging)
montait un ConfigMap de design, sans secrets métier ni base configurée, avec
le worker arrêté. Au contrôle actualisé vers 17:10 UTC, `/health` signale
`degraded/read_only/stopped` : la base n'est plus à décrire comme absente, mais
le fonctionnement normal et l'isolation d'une base staging dédiée ne sont
pas démontrés. Ce staging reste incomplet au regard de la demande explicite du
propriétaire ; cette observation ne constitue pas la cible à pérenniser.

Les [manifests Kustomize](../k8s/ovh/kustomization.yaml) restent un amorçage :
[app.yaml](../k8s/ovh/app.yaml) contient une ancienne image et
[ingress.yaml](../k8s/ovh/ingress.yaml) pointe encore le staging vers le Service
production. Les réappliquer pour publier annulerait des adaptations actuelles.
Le [Job de migration](../k8s/ovh/migration-job.yaml) a un nom et une image figés,
avec `imagePullPolicy: Never` ; il n'est pas une étape de release générique.
Les scripts [transfert de secrets](../scripts/deploy-ovh-secrets.mjs),
[restauration de base](../scripts/restore-ovh-database.mjs) et
[déploiement Clever historique](../scripts/deploy_secure.sh) ne doivent pas être
réutilisés comme pipeline de publication OVH.

## Direction à suivre

Chaque merge sur `main` doit produire un résultat traçable : changement sans
impact applicatif vérifié, ou image validée puis activée sur OVH et contrôlée sur
le domaine public. Un échec doit rester visible ; un succès de publication GHCR
ne doit pas être présenté comme un succès de déploiement.

La sélection et le build de l’image s’exécutent sur les runners hébergés de
GitHub Actions. GHCR reçoit les images validées ; Penthouse les télécharge
par digest et les active après réussite de la CI de `main`. Aucune compilation
applicative sur Penthouse ne fait partie du parcours courant. Le builder local
reste un recours de développement ou de reprise explicitement autorisé.

Le dépôt applicatif possède les tests, les entrées de build, le contrat de
migration et les contrôles HTTP. `infra-sincere` peut porter les prérequis,
les accès restreints, l'inventaire et le point d'entrée Ansible réutilisable pour
l'activation et la vérification. L'appel doit utiliser une révision connue de
l'outillage d'infrastructure et recevoir le digest exact de l'image. Les
workflows et scripts correspondants restent à écrire. Helm n'est pas nécessaire
pour ce Deployment ; l'automatisation doit d'abord séparer la publication
applicative de l'amorçage et des opérations sur les données.

## Staging complet pour présenter et tester le travail

Le propriétaire exige un [staging complet et isolé](hebergement-deploiement.md#staging-complet-exigé),
avec application, PostgreSQL, worker, stockage nécessaire et configuration propres.
Le pipeline staging doit livrer le commit candidat avec ses dépendances actives,
faire la recette métier et exposer son URL, son digest et ses résultats. Il ne
reçoit pas de droits d'écriture sur les données, queues ou services de production.
Les jeux de test ou clones contrôlés, éventuellement anonymisés, et les comptes
externes de test doivent permettre les parcours complets sans effets réels en
production. Cette documentation ne réalise aucune copie ni aucun déploiement.

Le staging et la production gardent chacun leur version souhaitée, leur verrou
de déploiement et leur preuve de recette ; une branche candidate peut donc être
montrée sans remplacer la production. Les vérifications de capacité tiennent
compte de leur hôte partagé. Réutiliser un digest déjà construit et validé lorsque
les sources et entrées correspondent évite un build inutile ; le SHA candidat
et celui finalement fusionné ne doivent pas être confondus. Après merge, la
production reste automatiquement réconciliée vers `main` validé, puis vérifiée
sur son domaine. La recette staging ne remplace pas ce dernier contrôle.

## Sélection des builds

Le site produit une seule image. Le cache Docker actuel accélère une construction
mais ne décide pas si elle est nécessaire. La classification suivante est un
contrat à implémenter et vérifier, avec reconstruction par défaut pour tout chemin
nouveau ou non classifié.

| Fichiers modifiés | Traitement recommandé |
| --- | --- |
| `server.js`, `server/**`, `public/**`, `style.css`, `package.json`, `package-lock.json`, configurations PostCSS/Tailwind, `Dockerfile`, `.dockerignore` | Tests adaptés, build de l'image, publication et déploiement |
| `sql/**`, `scripts/migrate.js` | Build, vérification des migrations sur PostgreSQL jetable, contrôle de compatibilité du schéma avant activation |
| `test/**` seulement | Tests concernés ; pas de nouvelle image si le contexte Docker reste inchangé |
| `k8s/**` seulement | Rendu et validation des manifests ; traitement de configuration distinct, sans réappliquer automatiquement toute l'infrastructure |
| `documentation/**`, `security/**`, `castopod/**` seulement | Contrôles adaptés aux fichiers ; pas de build de l'image du site, ces dossiers sont actuellement exclus du contexte |
| `.github/workflows/**` et scripts de livraison | Validation du pipeline ; build si les paramètres ou outils de construction changent |
| Autres fichiers, dont Markdown racine, `.gitignore` et scripts non classifiés | Build conservateur tant que leur absence d'effet n'est pas démontrée |

Cette matrice s'applique à l'ensemble des changements à livrer depuis le dernier
état validé, pas seulement au dernier commit. Renommages et suppressions doivent
être pris en compte. Des cas de test du sélecteur doivent couvrir les fichiers
partagés, les chemins nouveaux, les changements documentaires et les rattrapages
après échec ou annulation. Un lancement manuel doit conserver une option de
reconstruction complète contrôlée.

Le [Dockerfile](../Dockerfile) copie aujourd'hui tout le contexte dans le builder,
puis tout `/app` dans le runtime. Le [.dockerignore](../.dockerignore) exclut les
tests, la documentation technique et Kubernetes, mais pas `readme.md`, `AGENTS.md`,
les autres Markdown racine, `server/views/README.md` ou l'ensemble des scripts.
Ils peuvent donc modifier l'image. La compilation Tailwind utilise
[style.css](../style.css) et [PostCSS](../postcss.config.js) ; les différences de
contexte peuvent aussi affecter les classes détectées, comme le signale le guide
de déploiement.

Avant de généraliser « documentation seule = aucun build », borner explicitement
les fichiers copiés et les sources CSS, puis aligner la classification dessus.
Inclure toutes les ressources réellement lues au build ou au runtime, les assets,
les dépendances verrouillées et les outils de migration. Un simple filtre global
sur `*.md` serait prématuré avec le Dockerfile actuel.

## Ordre des contrôles et protection contre les anciennes versions

1. Exécuter la CI sur les PR et sur `main`, avec un statut final même lorsque les
   builds sont évités. Les tests doivent utiliser des dépendances isolées ; les
   dépendances RSS et l'instabilité mémoire signalées dans le guide doivent être
   traitées avant d'en faire un contrôle obligatoire fiable.
2. Construire exactement les sources validées. Publier le SHA source dans les
   métadonnées de l'image, résoudre le digest GHCR et activer ce digest. Conserver
   le tag de commit pour la navigation et le diagnostic.
3. Autoriser le déploiement automatique en production depuis `main` seulement. Les tags et
   lancements manuels ne doivent pas publier une ancienne branche en production
   par simple héritage du workflow actuel.
4. Annuler les builds dépassés si utile, mais sérialiser l'activation et sa recette.
   Un nouveau push ne doit pas interrompre un déploiement au milieu de ses
   mutations. Tous les chemins de déploiement doivent respecter le même verrou.
5. Avant chaque mutation, vérifier le serveur `game-prod-ovh-gra`, le contexte,
   le namespace et la version souhaitée. Si la tête de `main` a avancé, recalculer
   la livraison ou laisser sa réconciliation au run suivant ; un run ancien ne
   doit pas écraser une version plus récente. Vérifier à nouveau l'état souhaité
   après la recette si un merge est arrivé pendant le rollout.
6. Comparer les entrées de build de `main` à celles du dernier artefact validé en
   production. Exemple : le merge A modifie l'application, puis B ne modifie que
   la documentation. Si A échoue ou est annulé, B doit tout de même livrer le
   changement applicatif de A. Un filtre limité au diff du push B manquerait cette
   version. Le run le plus récent doit rattraper cet écart, même après une annulation.
7. Enregistrer séparément le SHA de `main` évalué, le SHA source de l'image, son
   digest et le résultat de la recette. Pour un merge documentaire sans effet sur
   les entrées de build, réutiliser l'image précédente et consigner cette
   équivalence ; ne pas prétendre avoir reconstruit le dernier SHA.

L'accès déployant doit se limiter aux ressources nécessaires du site. Aucun
changement DNS, Secret, volume, base ou autre application ne fait partie d'une
publication ordinaire. Les migrations doivent disposer d'une procédure explicite
et vérifiée ; en son absence, une migration requise bloque l'activation avec un
motif visible. Les migrations irréversibles et restaurations de données restent
soumises à une instruction spécifique. Revenir à l'image précédente n'annule pas
un changement de schéma.

## Prérequis de capacité production et staging complet

Au contrôle du 10 septembre 2026 vers 16:04 UTC, le quota du namespace du site
utilise la totalité de `limits.cpu` (2/2 CPU) et `limits.memory` (2/2 GiB).
La preview consomme la marge nécessaire au pod supplémentaire du rollout de
production. Les ressources libres sur le serveur ne suffisent donc pas à
garantir que Kubernetes admettra ce pod.

Ce constat est daté. Avant chaque activation, revérifier le quota et les
ressources nécessaires aux deux environnements et à leurs stratégies de rollout.
Dimensionner et versionner leur coexistence avant d'activer la CD : le staging
complet, sa base et son worker doivent rester disponibles pendant les publications
de production. Arrêter le staging ou ses dépendances à chaque push ne fait pas
partie du fonctionnement normal. Si la marge manque, bloquer avant mutation
avec une explication exploitable. Les changements de quota ou de stratégie
nécessitent une préparation et une validation explicites.

## Critères de réussite en production

La fin du rollout n'est qu'un premier contrôle. Les
[probes Kubernetes](../k8s/ovh/app.yaml) appellent toutes `/health`, alors que le
[serveur](../server.js) répond également en HTTP 200 en mode dégradé.
La recette automatique doit donc vérifier avec des délais bornés :

- Le digest attendu sur le Deployment et ses Pods, leur disponibilité et les
  événements bloquants récents.
- Le contenu JSON de `/health` sur le domaine public : `mode: normal`,
  `database.state: read_write` et `episodeWorker.state: ready`.
- Le contenu attendu de la home, de `/podcast`, d'un épisode réel et des routes
  modifiées, les redirections prévues et les assets effectivement servis.
- L'absence de régression pertinente sur les parcours concernés, sans soumettre
  de newsletter, de formulaire ou d'écriture métier comme simple test de santé.

Le staging complet doit réussir les mêmes critères de santé en mode normal
sur ses propres dépendances : `mode=normal`, `database.state=read_write` et
`episodeWorker.state=ready`. Sa recette comprend les écritures et jobs métier
sur des données isolées et les intégrations externes de test, selon le
[contrat du staging](hebergement-deploiement.md#staging-complet-exigé).
Les états dégradés des relevés de preview sont des écarts à corriger ; ils ne
valident pas ce staging. Un succès du staging ne prouve pas à lui seul la santé
de la production, qui conserve sa recette après activation.

Le résumé du run doit afficher version souhaitée, version active, digest, durée,
contrôles exécutés et échec éventuel, avec le lien du run. En cas d'échec après
activation, ne pas afficher un succès : conserver les éléments de diagnostic et
appliquer la procédure documentée de retour arrière seulement après contrôle de
compatibilité. Aucun de ces contrôles CI/CD supplémentaires n'est activé par le
présent document.

</details>
