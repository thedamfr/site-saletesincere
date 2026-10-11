# Reprise des inscriptions newsletter

## Summary

Une inscription est enregistrée durablement avant tout effet Brevo. Après une
coupure, une demande encore `ready` reprend automatiquement ; une demande dont
l’effet est incertain est vérifiée en lecture sans nouvel envoi. Une preuve
d’ajout à la liste ne garantit pas la réception de l’email DOI. Le journal privé
est conservé lors d’un retour arrière. La qualification utilise uniquement des
contacts synthétiques et un Brevo simulé, sans message réel.

## Synthèse

Le formulaire et les routes `/newsletter` restent identiques. Le POST valide
l’adresse puis enregistre une identité unique : email normalisé et liste DOI.
Sans PostgreSQL inscriptible, il répond 503 avant tout appel Brevo. La première
tentative reste synchrone, avec un budget de dix secondes pour les appels
externes. Un résultat confirmé retourne 200 ; une demande durable en attente ou
incertaine retourne 202 avec un message adapté, sans promettre un email envoyé.

La barrière `sending` et une entrée immuable de `newsletter_attempts` sont
commitées atomiquement avant chaque mutation externe. Chaque tentative conserve
son identifiant, sa phase et son horodatage, y compris après un refus suivi d’un
retry ; l’historique ne recopie ni adresse ni réponse distante. Un crash ou
une réponse perdue rend le résultat `uncertain`. La reprise effectue alors
uniquement des lectures : la présence dans la liste temporaire ou finale permet
de conclure, mais un 404 ou une liste absente ne démontre pas l’absence d’effet.
La trace atteste une tentative autorisée durablement, pas le départ effectif de
la requête HTTP : un crash entre le commit et l’appel reste donc incertain.
Les demandes `ready` reprennent au démarrage et toutes les trente secondes,
par lots de vingt. Le délai cible de cinq minutes se mesure sur le lot de
qualification après le retour des dépendances ; il ne constitue pas une garantie
pour un volume arbitraire. L’incertitude doit être identifiée, pas déclarée résolue.

Une nouvelle soumission de la même identité retrouve son état durable. Un contact
bloqué n’est jamais réactivé. Un ancien résultat confirmé ne déclenche aucun
renvoi ; une véritable réinscription après désabonnement demande un contrat
produit distinct. Les effets connus sont dédupliqués, sans garantie « exactement
une fois » sur l’automation DOI externe.

La migration 011 est additive et réapplicable. Le journal contient l’adresse
nécessaire aux lectures de reprise, n’a aucune route publique ni droit `PUBLIC`,
et n’est pas purgé automatiquement. Les logs exposent seulement un identifiant
opaque, un état et un code borné ; aucun payload ou détail Brevo n’est journalisé.
Les tests unitaires, HTTP et PostgreSQL couvrent ces invariants ; les Golden
Journeys ajoutent l’arrêt réel du processus et le compteur externe d’effets.

## Annexes

### États persistants

| État | Signification | Reprise autorisée |
| --- | --- | --- |
| `ready` | Demande durable, aucune mutation possible non résolue | Lecture puis mutation après acquisition atomique |
| `sending` | Barrière commitée avant une tentative | Après interruption, passage à `uncertain` puis lectures |
| `submitted` | Preuve distante persistée | Restituer le résultat ; aucun renvoi |
| `uncertain` | Effet externe possible, preuve insuffisante | Lectures uniquement ; un résultat absent reste incertain |
| `rejected` | Refus explicite ou contact bloqué | Restituer un refus sans divulguer le motif privé |

Une erreur 429 ou un refus explicite de création pour contact existant démontre
l’absence d’effet de cette tentative et permet un retour à `ready`. Une erreur
5xx, une réponse inexploitable ou une rupture réseau reste incertaine. L’ajout à
une liste n’est confirmé que si la réponse identifie l’adresse dans les succès,
sans l’identifier dans les échecs, ou si une lecture confirme la liste.

### Migration et retour arrière

- Appliquer `npm run migrate` uniquement sur la base de qualification autorisée ;
  la migration de production demande son autorisation propre.
- Conserver `newsletter_requests` et `newsletter_attempts`, leurs états et
  leur historique lors d’un rollback.
  Rejouer la migration ne remet pas les demandes à zéro.
- Les tentatives sont ajoutées par la même instruction SQL que la barrière.
  Un échec d’insertion annule la barrière et interdit l’appel Brevo. PostgreSQL
  refuse UPDATE, DELETE et TRUNCATE sur cet historique ; aucune purge n’est faite.
- Une version antérieure qui ignore le journal ne constitue pas un rollback sûr
  pour les écritures newsletter. Conserver la protection du nouveau handler ou
  suspendre le POST avant ce retour ; ne jamais réactiver l’ancien envoi aveugle.
- Un changement de liste DOI crée une autre identité ; la reprise automatique
  ne traite que la liste actuellement configurée et conserve les anciens états.

### Vérifications reproductibles

La suite habituelle `npm test` inclut les tests newsletter. Le test PostgreSQL
supplémentaire lit un fichier privé d’options `pg` désigné par
`NEWSLETTER_TEST_DATABASE_OPTIONS`. Il exige une connexion locale de
qualification, utilise son propre schéma aléatoire et le supprime à sa clôture.
Ne jamais pointer ce test vers une base contenant des données de production.

```bash
NEWSLETTER_TEST_DATABASE_OPTIONS=/chemin/prive/options-qualification.json \
  node --test test/newsletter/postgres.test.js
```

Les Golden Journeys newsletter vérifient la double soumission concurrente,
le refus d’un contact bloqué, une demande différée, une réponse perdue après
effet, une interruption avant effet, un second crash, un résultat individuel
en échec dans un HTTP 201 et une base en lecture seule puis restaurée. Le compteur
d’effets du simulateur demeure hors du processus interrompu. La réception d’un
email et la configuration réelle de l’automation Brevo ne sont pas simulées
comme des validations de production.

Le banc complet s’exécute avec `npm run test:e2e:resilience` selon sa procédure
de qualification ; il exige la VM dédiée déjà préparée et ne cible jamais la
production. Les scénarios comparent le compteur d’effets et, pour les reprises
confirmées ou incertaines, le nombre de mutations tentées.

### Références

- [Client Brevo](../server/newsletter/brevoClient.js),
  [journal et reprise](../server/newsletter/newsletterService.js),
  [migration 011](../sql/011_newsletter_requests.sql).
- [API contact](https://developers.brevo.com/reference/get-contact-info) et
  [ajout à une liste](https://developers.brevo.com/reference/add-contact-to-list).
- [Automation DOI externe](https://help.brevo.com/hc/en-us/articles/27353832123026-Set-up-a-double-opt-in-process-for-a-sign-up-form-created-outside-of-Brevo).
