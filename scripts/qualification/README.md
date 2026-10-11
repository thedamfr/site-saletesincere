# VM de qualification de reprise — issue 56

## Summary

Ce banc possède une VM `site-issue56` isolée, ses données synthétiques et un
contrôleur extérieur. Il permet l’arrêt normal et la coupure brutale de cette
seule VM. Les commandes refusent une identité ou un processus étranger.
La qualification métier reste à exécuter sur l’image candidate exacte ; le
démarrage du banc ne constitue pas une preuve de résilience. La commande
versionnée est `npm run test:e2e:resilience` ; ses rapports privés distinguent
la préparation, les parcours exécutés et leurs délais observés.

## Synthèse

Ubuntu Noble, QEMU TCG, 2 vCPU, 6 Gio et un overlay de 30 Go hébergent K3s et
PostgreSQL 17.6. Le réseau utilisateur QEMU utilise `restrict=on`, sans bridge
hôte. SSH et HTTP sont accessibles uniquement depuis le loopback de l’hôte.
Le contrôle reste hors VM ; les opérations enregistrent temps Unix, temps
monotone, identité et boot ID dans le répertoire privé du banc.

La construction candidate fige les entrées runtime du Dockerfile, leur
manifeste SHA-256 et leur patch, y compris les fichiers nouveaux. Le commit
de base reste identifié séparément : une image issue de modifications locales
n’est pas présentée comme un commit inexistant. Les tests et leur harnais,
extérieurs à l’image, doivent conserver leurs propres preuves de révision.
Les archives conservent l’image éprouvée ; une nouvelle construction doit
être requalifiée même si ses sources sont identiques.

Le service PostgreSQL conserve ses données sur un volume de l’invité. Les
identifiants sont créés spécialement pour le banc ; aucun secret, volume ou
service de production ne doit être importé. Les fournisseurs simulés sont
extérieurs à la VM et accessibles par un tunnel SSH inverse. Après chaque
coupure, le contrôleur rétablit ce tunnel et distingue le temps de boot du
délai de reprise après disponibilité des dépendances.

`shutdown` demande un arrêt normal dans l’invité ; `crash` envoie SIGKILL au
seul processus QEMU possédé, via un pidfd après vérifications UUID/disque/PID
et hostname. `crash-when` arme cette coupure avant d’observer la reprise d’un
job durable ; la confirmation déclenche le signal sans nouvel aller-retour
SSH, avec un délai local mesuré. Un arrêt normal ne prouve pas la résistance
à une coupure brutale. TCG et K3s ne qualifient ni les performances MicroK8s
réelles, ni la restauration d’un hôte physique neuf. Après une coupure VM,
le budget de reprise HTTP/worker est de 300 secondes à partir du retour des
dépendances ; le boot est mesuré séparément. Les frontières applicatives
incluent l’armement de l’observateur dans leur budget de 300 secondes.
Les fournisseurs et
leurs réponses sont simulés, le contrôle navigateur utilise un vrai Chromium
avec sa sandbox. Conserver ces limites dans les preuves.

## Annexes

### Prérequis et état privé

Sur le contrôleur : Node.js 24 ou plus récent, les dépendances `npm ci` du
checkout, Python avec `os.pidfd_open` et `signal.pidfd_send_signal`, QEMU,
`qemu-img`, `cloud-localds`, Git, SSH/SCP et Docker Buildx accessibles selon les
droits existants. Chromium doit être déjà disponible avec sa sandbox ; choisir
le binaire via `E2E_BROWSER_EXECUTABLE` ou le canal via `E2E_BROWSER_CHANNEL`
si Playwright n’utilise pas son installation habituelle. Ne pas désactiver
la sandbox ni installer de dépendances système sur l’hôte de production au
titre de la recette.

Vérifier que `node --version` dans le terminal utilisé annonce au moins la
version 24 : ce même `PATH` doit servir à `npm ci` et aux commandes npm du banc.
Le compte doit pouvoir utiliser `sudo -n docker` sur le contrôleur et
`sudo -n` dans cette seule VM. Les ports du tableau ci-dessous doivent être
disponibles ; ne pas arrêter un service étranger pour les libérer. Le
contrôleur et les fournisseurs simulés restent actifs pendant les coupures.

Préparer un répertoire d’état neuf en 0700, hors Git. Prévoir l’image cloud
Ubuntu Noble officielle et son `SHA256SUMS`, le
binaire K3s `v1.34.1+k3s1`, son archive airgap et l’image
`postgres:17.6-alpine` exportée en tar. Conserver leurs origines, versions et
SHA-256 dans les preuves ; transférer les images vers l’invité avant essais,
car il n’accède pas à Internet. La candidate est construite avec le script
décrit plus bas ; aucun tar, volume ou environnement de production n’entre
dans son contexte.

Créer `postgres-options.json` en 0600 dans l’état privé avec `host=127.0.0.1`,
`port=25456`, `database=site_qualification`, `user=site_qualification` et un
mot de passe aléatoire propre à ce banc. Le copier en 0600 dans
`/home/ubuntu/qualification/postgres-options.json` de l’invité. Le setup crée
ensuite son rôle applicatif distinct sans `SUPERUSER`, `CREATEDB` ou
`CREATEROLE`, et conserve ses options dans `application-options.json` privé.
Ne jamais recopier ces valeurs dans les commandes publiées ou les rapports.

### Asset WaveSurfer figé

Avant même la phase `setup`, placer `wavesurfer.esm.js` dans le répertoire
d’état. Le harnais sert ce vrai module local à la place de l’URL CDN utilisée
par le template, sans changer l’image applicative. L’asset de référence du
banc du 11 octobre 2026 compte 41 736 octets et porte le SHA-256
`1bca765cc75bc4af079ecd1b2edd659b155e5d1715e75a29d68272d9f141f951`.

Sa source est l’URL du template
`https://cdn.jsdelivr.net/npm/wavesurfer.js@7/dist/wavesurfer.esm.js`.
Cette URL de version majeure peut évoluer : conserver le fichier figé avec
les preuves et vérifier son empreinte avant réutilisation. Un autre fichier
exige une nouvelle qualification explicite ; ne pas remplacer silencieusement
l’asset pour faire passer un test. `environment.json` enregistre toujours
l’empreinte réellement utilisée.

### Contrats d’accès

| Usage | Adresse |
| --- | --- |
| SSH invité | `127.0.0.1:22856` sur l’hôte |
| HTTP applicatif | `127.0.0.1:31856` → NodePort invité `30080` |
| PostgreSQL par tunnel | `127.0.0.1:25456` → NodePort invité `30432` |
| Fournisseurs depuis les pods | `http://10.0.2.15:31857` → fixture hôte `127.0.0.1:31857` |
| Namespace invité | `site-issue56` |

Le répertoire d’état privé doit appartenir à l’opérateur et être en mode 0700.
Conserver les clés, options PostgreSQL et artefacts bruts hors Git. Les images
applicatives doivent être préparées depuis le contenu candidat identifié ;
requalifier après tout changement de contenu.

### Préparer et contrôler la VM

```sh
python3 scripts/qualification/recovery-vm.py prepare \
  --state /chemin/prive \
  --base-image /chemin/noble-server-cloudimg-amd64.img \
  --checksums /chemin/SHA256SUMS
python3 scripts/qualification/recovery-vm.py start --state /chemin/prive
python3 scripts/qualification/recovery-vm.py status --state /chemin/prive
python3 scripts/qualification/recovery-vm.py tunnel --state /chemin/prive
python3 scripts/qualification/recovery-vm.py shutdown --state /chemin/prive
python3 scripts/qualification/recovery-vm.py crash --state /chemin/prive
```

`start` et `tunnel` restent au premier plan dans des sessions contrôlables.
Après un arrêt, relancer `start`, attendre un boot ID différent, puis relancer
`tunnel`. Ne pas modifier les disques des autres bancs. L’image Ubuntu de base
est vérifiée contre son SHA-256 officiel et copiée avant création de l’overlay.

Transférer le binaire K3s et son archive airgap dans
`/home/ubuntu/qualification/imports` de l’invité, après création de ce
répertoire. Les noms attendus sont `k3s` et
`k3s-airgap-images-amd64.tar.zst`. Y copier aussi `postgres.tar` et les deux
scripts du checkout `bootstrap-guest.sh` et `postgres-guest.py`. Exécuter
les commandes suivantes **dans l’invité**, une fois l’identité vérifiée :

```sh
bash /home/ubuntu/qualification/imports/bootstrap-guest.sh \
  /home/ubuntu/qualification/imports
sudo -n k3s kubectl get nodes
```

Attendre que le nœud soit `Ready` avant de poursuivre :

```sh
sudo -n k3s ctr images import /home/ubuntu/qualification/imports/postgres.tar
python3 /home/ubuntu/qualification/imports/postgres-guest.py
sudo -n k3s kubectl -n site-issue56 rollout status statefulset/postgres --timeout=180s
```

Le script de bootstrap refuse un autre hostname. Le banc courant utilise
`v1.34.1+k3s1`; l’interface Flannel est explicitement déterminée à partir de
l’adresse invitée `10.0.2.15`, car le réseau restreint n’a pas de route Internet.

Importer chaque archive image séparément avec `sudo -n k3s ctr images import`.
Le script `postgres-guest.py` lit le fichier privé
`/home/ubuntu/qualification/postgres-options.json` et crée uniquement le
namespace, le Secret synthétique, le volume et le StatefulSet du banc.
La base et le rôle doivent être nommés `site_qualification`.

### Vérifications du contrôleur

```sh
python3 scripts/qualification/test_recovery_vm_safety.py
python3 -B -m unittest scripts/qualification/test_observe_boundary.py -v
bash -n scripts/qualification/bootstrap-guest.sh
git diff --check
```

Le test de sécurité vérifie les refus pour identité, PID et permissions de
répertoire incorrects, avec et sans optimisation Python. Il ne réalise aucune
coupure et ne remplace pas les Golden Journeys métier. Il vérifie également
que la coupure conditionnelle refuse un délai dépassé, une confirmation
étrangère, un disque remplacé ou une identité locale modifiée, et que la
confirmation est lue sans attendre la fin du processus observateur.
Une régression dédiée vérifie aussi que le contrôle d’identité SSH ne
consomme pas le JSON privé destiné à `crash-when` : ce contrôle reçoit un
stdin fermé, alors que l’observateur reçoit explicitement sa spécification.

### Coupure pendant une reprise précisément observée

Le harnais peut armer le contrôleur avant la condition SQL attendue :

```sh
python3 scripts/qualification/recovery-vm.py crash-when \
  --state /chemin/prive < /chemin/prive/boundary.json
```

Le fichier d’entrée, privé et en 0600, contient uniquement `containerId`,
`podName`, `imageDigest`, `dbOptions` et la condition
`{kind: "job-active", jobId, minRetryCount}`. Les identifiants PostgreSQL
passent par stdin ; aucune option de commande ni journal ne les contient.
La base doit appartenir au banc `site_qualification` et le pod au Deployment
`web` de qualification. Aucune commande ou requête SQL arbitraire n’est acceptée.

Après vérification de la VM et de son boot ID, le contrôleur ouvre un pidfd
QEMU et journalise l’armement avec fsync. Il appelle exclusivement
`sudo -n python3 /home/ubuntu/qualification/observe-boundary.py --mode vm`
dans l’invité, en ajoutant `expectedBootId` à l’entrée. Cet observateur doit
être installé par le harnais ; son mode VM ne signale aucun processus.
Il confirme sur une ligne JSON `conditionConfirmed: true`, `bootId`,
`containerId`, `podName` et `imageDigest`. L’événement intermédiaire
`{event: "armed"}` est facultatif.

Pour `job-active`, l’attente est limitée à 185 secondes et la réponse à
16 Kio. Ce budget laisse expirer une ancienne tentative active avant de
constater sa reprise ; il ne réduit aucun délai applicatif. Le harnais borne
la commande complète à 205 secondes ; l’attente de cette frontière, le boot
et la reprise métier gardent des chronométrages distincts. Une confirmation
incomplète ou discordante interdit toute coupure. Avant SIGKILL, le contrôleur
vérifie de nouveau localement le pidfd vivant, le PID, l’UUID, le propriétaire,
l’identité et l’inode du disque. Aucun second SSH ni fsync ne retarde le signal
après ce contrôle ; le journal fsync enregistre ensuite les instants monotones
de confirmation et de signal, ainsi que leur écart en millisecondes.

### Frontières applicatives et signaux

Les `SIGTERM` et `SIGKILL` applicatifs simples passent par containerd dans le namespace
PID ancêtre de l’invité. Envoyer `SIGKILL` depuis un autre processus du même
conteneur à son PID 1 ne suffit pas : le banc exige une sortie observée
(0 pour l’arrêt gracieux, 137 pour la destruction) et un nouveau processus.
Il conserve le code dès le remplacement, avant que Kubernetes puisse effacer
`lastState` pendant la reprise HTTP.

Pour les frontières SQL courtes, `observe-boundary.py --mode app` vérifie
l’identité CRI, le digest, le cgroup et le namespace PID, puis préarme un pidfd.
Il consulte PostgreSQL en lecture seule toutes les 20 ms, depuis le pod de
base, et signale immédiatement l’application lorsque le verrou attendu apparaît.
Les timeouts SQL applicatifs ne sont pas augmentés pour élargir cette fenêtre.
Après SIGKILL, l’observateur attend au plus 10 secondes la lisibilité du pidfd,
preuve de terminaison effective, avant d’émettre `processExited: true`.
Le contrôleur exige ensuite un nouvel identifiant de conteneur dans le même
pod. Un code Kubernetes présent doit être 137 ; s’il manque, la preuve indique
explicitement sa source noyau et conserve un code nul. Elle n’invente pas 137.
Le mode VM ne signale pas l’application : il transmet la confirmation au
contrôleur extérieur. Une reprise observée exige une tentative commencée
après armement, avec une tolérance initiale d’une seconde ; un ancien état
`active` abandonné ne constitue pas une preuve de traitement en cours.

### Construction candidate après gel runtime

```sh
python3 scripts/qualification/build-candidate.py --state /chemin/prive
```

Le script exige la VM possédée active, copie les sources runtime dans un
contexte figé, conserve un tar source et un patch complet de ce périmètre,
puis construit et exporte l’image avec les métadonnées Buildx. Les empreintes
sont vérifiées avant et après construction/import ; une modification runtime
invalide l’opération. Les corrections des tests ou documents extérieurs à
l’image ne modifient pas son empreinte runtime.

L’archive OCI transférée pointe directement vers le manifest `linux/amd64`.
L’alias `docker.io/library/site-issue56@sha256:…` correspond donc au contenu
plateforme réel, distinct de l’éventuel index multi-plateforme Buildx. Le
fichier privé `candidate.json` conserve ces deux digests, le commit de base,
les empreintes source/patch et l’emplacement des preuves de construction.
Il n’est publié qu’après import réussi et dernière vérification des sources.
Le Dockerfile utilise le tag mutable `node:24-slim` : les métadonnées Buildx
conservent le digest réellement utilisé. Pour rejouer la même candidate,
conserver et réimporter son archive `candidate-platform.tar`, puis vérifier
son digest. Une nouvelle construction peut produire une autre image ; les
empreintes de sources seules ne garantissent pas un résultat binaire identique.

### Commande npm et preuves des Golden Journeys

Après démarrage de la VM, PostgreSQL et du tunnel, construire/importer la
candidate puis exécuter depuis la racine du checkout :

```sh
RESILIENCE_VM_STATE=/chemin/prive \
RESILIENCE_DATABASE=site_qualification_preparation1 \
RESILIENCE_PHASE=setup \
npm run test:e2e:resilience
```

Cette phase applique la candidate par digest, rejoue les migrations deux
fois dans la base synthétique, vérifie les droits applicatifs et les premiers
résultats RSS/liens/OP3. Elle n’effectue aucune coupure. Pour la campagne
complète avec interruptions réelles :

```sh
RESILIENCE_VM_STATE=/chemin/prive \
RESILIENCE_DATABASE=site_qualification_campagne1 \
RESILIENCE_PHASE=all \
npm run test:e2e:resilience
```

Choisir pour chaque campagne complète un suffixe encore inutilisé ;
`RESILIENCE_DATABASE` crée la base seulement si elle n’existe pas, après
vérification de l’identité de la VM. Le suffixe accepte de 1 à 24 lettres
minuscules ou chiffres après `site_qualification_`. Les bases précédentes
et les identifiants privés restent inchangés. L’événement
`qualification database selected` doit indiquer `created: true` pour une
preuve de démarrage sur base neuve. Sans cette option, le banc réutilise
`site_qualification`.

La phase `setup` est facultative et remplit déjà les caches : utiliser une
autre base pour la campagne `all` qui doit démontrer leur reconstruction
depuis un état vide. Une base déjà peuplée ne prouve pas ce scénario.

Avant chaque scénario indépendant, le harnais recrée seulement le pod
applicatif pour isoler le backoff Kubernetes, en conservant toutes les données.
Il ne le fait jamais entre les deux interruptions d’un scénario. Les durées
de ces préconditions figurent séparément dans les événements du rapport.

Le harnais démarre les fournisseurs synthétiques sur le contrôleur, conserve
leur journal hors VM et refuse le repli vers les vrais fournisseurs. Les
parcours navigateur vérifient navigation, lecture audio réelle et destination
des liens. Les essais applicatifs couvrent acceptation/persistance,
dépendances absentes ou tardives, doublons, effets incertains, reprise
concurrente, SIGKILL, shutdown et doubles coupures de la VM.

Chaque exécution utilise par défaut un nouveau répertoire privé
`results-<timestamp>` ; `RESILIENCE_OUTPUT` permet d’en choisir un explicitement
neuf. Conserver `environment.json`, `results.json`, `candidate.json`, les
captures, `operations.jsonl`, les journaux de migrations et les preuves de
construction. Le rapport donne le SHA de base, les empreintes runtime/patch
et celles des fichiers du harnais, les versions, les scénarios, les délais
et les limites des simulations. Ouvrir les captures avant de les interpréter.
Un échec ou un scénario non exécuté reste tel quel ; un succès de `setup`
ne constitue pas un succès de campagne.

Pour la seule requalification du sélecteur navigateur de l’issue 56,
`npm run test:e2e:resilience -- --navigation-only` exige
`RESILIENCE_PREVIOUS_OUTPUT` pointant sur une campagne avec 19 réussites et
l’échec final de navigation, la même `RESILIENCE_DATABASE`, la même candidate,
et un `RESILIENCE_OUTPUT` neuf. Redémarrer la VM et son tunnel avant cet appel.
Le runner vérifie le catalogue persisté 0 à 7, reconstitue uniquement le flux
synthétique en mémoire, puis suit le dernier épisode. Il vérifie aussi que
journal newsletter et compteurs d’effets restent inchangés. Il n’exécute ni
migration, ni déploiement, ni coupure et produit `navigation-proof.json`.
Cette preuve séparée ne transforme pas l’exécution précédente en campagne
intégrale réussie. Arrêter ensuite normalement la VM via le contrôleur.

Le nettoyage ferme les ressources du harnais et demande l’arrêt normal de
la VM lorsqu’il l’a lui-même redémarrée. Il conserve le disque, les images,
les données synthétiques et les preuves. Ne pas les supprimer pour rendre
une nouvelle exécution verte. Compléter avec `npm test`, `npm run build` et
`npm run test:e2e` pour les parcours existants affectés.
