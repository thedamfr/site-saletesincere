# ADR 0020 — Livraison continue OVH et staging complet

Date : 2026-09-11. Statut : accepté, mise en œuvre autorisée par le propriétaire.

## Décision

GitHub Actions exécute les tests et les migrations sur PostgreSQL jetable, puis
construit l'image sur ses runners. Le Dockerfile copie explicitement les chemins
applicatifs ; Tailwind scanne explicitement les templates et JavaScript.
L'empreinte de l'arbre complet des entrées permet de réutiliser une image validée
malgré des commits documentaires et de rattraper un changement non encore livré.
Les chemins inconnus déclenchent une reconstruction conservatrice.

SSH est limité à Tailscale sur Penthouse. Un service systemd dédié récupère les
manifestes des runs GitHub réussis ; il ne construit pas le site et n'ouvre aucun
nouvel accès réseau entrant. Son code est installé à une révision revue et n'est
jamais remplacé par un fichier téléchargé depuis un artefact. Son identité
Kubernetes peut lire pods/quotas et modifier uniquement les deux Deployments du
site. Elle ne peut lire les Secrets ni toucher aux bases, volumes ou autres
applications. Le credential Kubernetes est fourni par systemd et ne peut être lu que par le
service. Aucun token GitHub n’est stocké sur OVH : les manifestes non sensibles
sont publiés sur la branche publique `codex/delivery-state`. Le service vérifie
ensuite la réussite et la provenance du run via l’API publique de GitHub. Les
requêtes de chaque minute lisent le contenu brut public ; l’API limitée en débit
n’est consultée que lorsqu’une livraison change. Le token GitHub reste sur les
runners et sert à publier GHCR, l’état attendu et les statuts de recette.

Un verrou local commun à toutes les activations empêche leur chevauchement. Le
service vérifie la tête de branche avant mutation et après recette. La production
accepte uniquement `main`. Le staging suit le dernier lancement manuel staging ;
un lancement plus récent échoué ou en cours ne fait pas réactiver un ancien run.
La mutation du Deployment utilise aussi sa resourceVersion. Une activation n'est
pas interrompue par l'annulation d'un build GitHub plus ancien.

Le rollout conserve `maxUnavailable: 0`, `maxSurge: 1`, avec 10 secondes de
stabilité avant disponibilité et un hook `preStop` de 15 secondes pour le retrait
des connexions. La vérification HTTP finale est répétée après 30 secondes. La readiness vérifie le
contenu de `/health`, sans changer sa liveness HTTP publique. La recette contrôle
le digest réellement exécuté, la santé, les pages et les assets sur le domaine.
Un statut GitHub distinct et le workflow `Verify OVH delivery` rapportent son
résultat ; une publication GHCR seule n'est pas une recette réussie.

Le propriétaire a autorisé les notifications Telegram de succès et d'échec.
Le service OVH envoie au destinataire privé déjà associé au bot, avec ses fichiers
de credentials fournis par systemd ; ils ne sont ni copiés vers GitHub ni placés
dans l'image applicative. Une réussite exige l'état de rollout vérifié et deux
recettes publiques espacées de 30 secondes. Les échecs de CI sont aussi lus via
l'API publique GitHub toutes les cinq minutes ; une publication réussie sans
activation constatée après quinze minutes est signalée.

La sévérité dépend de l'observation : avertissement pour un staging en échec ou
une production saine avec livraison bloquée ; élevée si la production répond en
mode dégradé ou si la version attendue échoue à sa recette ; critique si la
production est injoignable ou en erreur HTTP depuis OVH. Il s'agit de l'impact
observé, sans attribution automatique de l'incident au déploiement. Les reçus
Telegram sont persistés par run, résultat et sévérité ; une reprise ne réémet pas
un message déjà confirmé et une récupération peut envoyer le succès. Un refus
d'envoi reste journalisé et est retenté après cinq minutes. Le bot conversationnel
et l'observabilité partagée ne sont pas modifiés.

## Staging et données

Le staging dispose d'un PostgreSQL 17 et d'un PVC propres, d'identifiants neufs,
d'un worker actif et de règles réseau sans accès PostgreSQL de production.
Le mur et S3 restent désactivés comme en production ; aucun stockage objet n'est
nécessaire à ces parcours. Les credentials d'API podcast utilisés en lecture
peuvent être réutilisés, avec l'autorisation du propriétaire. Le secret Brevo de
production est exclu : une API de test interne sans sortie réseau simule l'ajout
de contacts et conserve seulement un compteur borné par la durée de vie du pod.
Elle ne simule pas la réception réelle d'un email DOI chez un fournisseur.

La base démarre vide, avec les migrations du dépôt, sans copie de données privées
ni import de jobs de production. Les visites des pages réelles alimentent les
caches staging via le worker. La recette vérifie ces écritures et la consommation
des jobs, ainsi que la newsletter avec un destinataire synthétique.

Le quota du namespace est dimensionné pour la coexistence des deux bases,
applications, de l'ancienne preview et des pods temporaires de rollout. L'ancienne
preview peut rester disponible pendant la bascule de l'Ingress staging.

## Migrations et retour arrière

Le service compare l'empreinte des migrations de l'image à celle vérifiée pour
chaque environnement, dans sa configuration administrée. Une divergence bloque
avant activation. Il ne lance aucune migration de production. L'opérateur doit
valider les migrations et leur compatibilité avant de mettre à jour l'empreinte.

Pour revenir à une image validée : arrêter le timer, attendre la fin du service
et utiliser le même verrou avant `kubectl set image`. Vérifier le schéma, le
rollout et le domaine. Un revert Git suivi d'une nouvelle CI est le retour normal
vers un état durable. Ne pas relancer la réconciliation de `main` tant qu'elle
redéploierait la version refusée. Aucune restauration de volume n'est impliquée.

## Limites

L'hôte reste un MicroK8s mono-nœud : ce mécanisme évite une indisponibilité causée
par une publication normale, sans garantir la disponibilité en cas de panne
matérielle ou d'incident du cluster. L'expiration ou la révocation d'un accès
bloque les nouvelles publications et fait échouer leur vérification GitHub ;
l'application déjà déployée continue à fonctionner.
