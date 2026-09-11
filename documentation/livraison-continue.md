# Livraison continue vers OVH

Mise en œuvre en cours le **11 septembre 2026**, autorisée par le propriétaire.
Voir [ADR 0020](adr/adr_0020_livraison_continue_et_staging.md).
La recette finale sera consignée après validation du staging puis de la production.

## État initial conservé — 10 septembre 2026

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
