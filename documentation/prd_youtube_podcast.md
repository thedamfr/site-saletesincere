# PRD — Disponibilité vidéo sur les pages podcast

**Version :** 1.6
**Date :** 2026-09-11
**Statut :** correctifs Apple et iframe YouTube implémentés localement, non déployés

## Problème

Un épisode peut être publié en vidéo chez l’hébergeur, sur Apple Podcasts, sur
Spotify ou sur YouTube sans que ces publications soient simultanées. L’existence
du flux RSS, d’une enclosure vidéo ou d’une chaîne ne prouve donc pas que cet
épisode existe en vidéo sur les autres plateformes.

Les pages podcast doivent rendre les disponibilités réellement vérifiées, avec
une présentation discrète inspirée des métadonnées Apple Podcasts.

## Expérience attendue

- `/podcast` n'affiche aucune métadonnée ou pastille de disponibilité vidéo.
- La chaîne YouTube reste proposée parmi les plateformes de diffusion de
  `/podcast`.
- `/podcast/:season/:episode` affiche la même métadonnée au niveau de l’épisode.
- Les cartes Apple, Spotify et YouTube reçoivent une micro-pastille vidéo seulement
  lorsque la vidéo de cet épisode est vérifiée sur la plateforme concernée.
- La carte YouTube n'existe sur une page épisode que lorsqu'un lien direct vers
  la vidéo de cet épisode a été réconcilié. Aucun lien générique de chaîne ne la
  remplace.
- S3E1 est marqué « Spotify (HD) ».
- S3E2 est marqué « Spotify (4K) · YouTube (4K) ».
- S3E2 ajoute « Apple Podcasts (Full HD) » et une pastille « Vidéo Full HD ».
- Une vidéo YouTube résolue est lisible dans une iframe responsive sur la page
  épisode, sous ses informations et avant les plateformes. Le lecteur audio et
  les liens de plateformes restent disponibles ; aucune lecture automatique.
- Lorsque YouTube fournit une miniature `maxres` 16/9, elle devient l’image Open
  Graph et Twitter de la page épisode. L’image OG existante reste le fallback.
- Aucun encart de disponibilité dédié n’est ajouté.

## Sources de vérité indépendantes

| Destination | Preuve exigée pour un épisode |
| --- | --- |
| Site officiel | enclosure principale vidéo ou `podcast:alternateEnclosure` MP4/HLS avec source HTTP(S) valide |
| Apple Podcasts | enclosure principale vidéo ou HLS alternatif, et lien Apple direct de ce même épisode |
| Spotify | lien Spotify direct et réponse vidéo de l’oEmbed officiel, mise en cache |
| YouTube | lien vidéo direct résolu depuis la description de la vidéo |

Une preuve ne vaut jamais pour une autre destination. En particulier :

- l’enclosure de l’hébergeur ne prouve ni Spotify ni YouTube ;
- le lien de chaîne YouTube ne prouve aucun épisode ;
- un lien Spotify direct ne suffit pas à affirmer que son lecteur propose la
  vidéo.

### Flux RSS vidéo

Le parseur accepte les enclosures principales vidéo ainsi que les
`podcast:alternateEnclosure` Podcasting 2.0 de type MP4
ou HLS et exige au moins un `podcast:source` HTTP(S). Il n’expose au rendu que
les capacités `mp4` et `hls` et le booléen `hasPrimaryVideo`, sans URL vidéo à
charger dans le lecteur audio. Si le fichier principal est vidéo, ce lecteur
utilise une source HTTP(S) audio alternative ; sans celle-ci, il n'est pas rendu.

Un MP4 alternatif seul reste la preuve du format vidéo sur le site officiel.
Le HLS alternatif ou la vidéo principale, combinés au lien Apple direct du même
épisode, qualifient Apple Podcasts. Lors du contrôle du 11 septembre, le lookup
Apple confirme également `episodeContentType=video` pour S3E2. L'association
utilise le GUID RSS ; la date seule n'est conservée que pour les anciens jobs
sans GUID et à condition qu'elle soit unique. Les réponses ambiguës, les autres
podcasts et les liens non conformes sont rejetés ; le lookup est borné à 5 s.

Références : [Podcast Namespace — alternate enclosure](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md#alternate-enclosure) et
[Apple Podcasts — publier une vidéo](https://podcasters.apple.com/support/5593-how-to-publish-video).

### Spotify

Le worker interroge l’endpoint oEmbed public avec une URL strictement limitée à
`https://open.spotify.com/episode/{id}`. Une réponse oEmbed de type `video`, ou
un iframe d’épisode terminé par `/video`, confirme la disponibilité. Le booléen
est conservé dans `episode_links.spotify_video_available` afin de ne pas ajouter
d’appel externe au rendu HTTP.

Une erreur réseau, une réponse non valide ou une URL non conforme produit un
état inconnu et peut être réessayée. Une réponse oEmbed valide mais audio-only
est conservée comme `false`.

Référence : [Spotify oEmbed](https://developer.spotify.com/documentation/embeds/reference/oembed).

### YouTube

Chaque description YouTube contient l’URL canonique exacte :

```text
https://saletesincere.fr/podcast/{saison}/{episode}
```

Le worker parcourt la playlist d’uploads avec `playlistItems.list`, sans
association par titre ou par date. Le `videoId` validé devient le lien direct de
l’épisode. La miniature `snippet.thumbnails.maxres` est conservée uniquement si
elle provient de `i.ytimg.com`, correspond au même identifiant et annonce un
format 16/9 d’au moins 1200 × 675 pixels.

Une vérification terminée sans miniature `maxres` est mémorisée séparément afin
d’éviter une boucle de résolution permanente. Le rendu garde alors l’image OG
générée à partir de la jaquette RSS.

Références : [YouTube Data API — PlaylistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list) et
[YouTube Data API — thumbnails](https://developers.google.com/youtube/v3/docs/thumbnails).

### Qualité affichée

Les API publiques utilisées confirment la présence de vidéo, mais ne constituent
pas une source fiable pour afficher une résolution exacte sur toutes les
plateformes. Les labels sont donc des métadonnées éditoriales explicites et
limitées aux faits confirmés :

- S3E1 : Spotify HD ;
- S3E2 : Apple Full HD, Spotify 4K et YouTube 4K.

Une vidéo vérifiée sans qualité éditoriale reste indiquée simplement « Vidéo ».

### Lecteur YouTube intégré

Seul un lien `https://www.youtube.com/watch?v={id}` résolu par le worker peut
produire une iframe. L'identifiant doit comporter 11 caractères autorisés ; le
serveur construit une URL `https://www.youtube-nocookie.com/embed/{id}` sans
recopier les autres paramètres du cache. Le lecteur conserve les contrôles
YouTube, le clavier et le plein écran, avec un titre français, un chargement
différé et `referrerpolicy="strict-origin-when-cross-origin"`. Il ne se lance pas
automatiquement et respecte une hauteur minimale de 200 px sur mobile.

La présence d'un lien ne garantit pas que YouTube autorise encore l'intégration
(restriction ultérieure, vidéo privée ou retirée). Le lien de la carte YouTube
reste disponible. Aucun appel à l'API YouTube n'est ajouté au rendu serveur.
Référence : [lecteurs intégrés YouTube](https://developers.google.com/youtube/player_parameters).

## Fonctionnement

1. Le RSS fournit les métadonnées et les capacités vidéo hébergées.
2. La route lit les liens directs et les preuves de plateforme dans
   `episode_links`.
3. Si un lien Apple/Spotify/Deezer manque, si Spotify n’a pas encore de verdict
   vidéo, si la miniature YouTube n’a pas encore été vérifiée ou si le RSS a
   changé, l’intention portant le GUID rejoint le job
   `resolve-episode` existant.
4. Le worker résout les liens, vérifie l’oEmbed Spotify et récupère la miniature
   YouTube en parallèle avec les enrichissements existants.
5. La visite suivante reçoit les preuves en cache et génère les libellés sans
   requête réseau externe.

## Données et retour arrière

- La migration 009 ajoute `episode_links.youtube_url`.
- La migration 010 ajoute les colonnes nullable
  `spotify_video_available`, `youtube_thumbnail_url` et
  `youtube_thumbnail_checked`.
- La migration 010 initialise Spotify à `true` pour S3E1 et S3E2, faits
  éditorialement confirmés, lorsque les lignes existent déjà.
- Les migrations sont additives et préservent les smartlinks et images OG
  existants.

Le retour arrière applicatif consiste à revenir au code antérieur. La suppression
optionnelle des nouvelles colonnes perd uniquement ce cache dérivé.

## Sécurité, résilience et accessibilité

- L’oEmbed Spotify n’accepte qu’un hôte, un schéma et un chemin d’épisode
  explicitement autorisés, ce qui évite une requête serveur vers une URL libre.
- Les appels Spotify et YouTube sont bornés à cinq secondes.
- Les IDs YouTube sont validés avant de construire les liens publics.
- Seules les miniatures YouTube `maxres` HTTPS du domaine attendu sont rendues.
- Les échecs d’enrichissement laissent les pages et leurs fallbacks disponibles.
- Les pastilles restent du texte HTML normal et ne remplacent pas le nom
  accessible de la plateforme.

## Critères d’acceptation

- Le lien de chaîne YouTube seul ne déclenche aucune disponibilité vidéo.
- `/podcast` n'affiche aucune métadonnée vidéo et conserve la carte de la chaîne
  YouTube parmi les plateformes de diffusion.
- Une enclosure RSS ne déclenche jamais Spotify ou YouTube.
- Un épisode Spotify vidéo vérifié est indiqué même sans enclosure RSS.
- S3E2 affiche Spotify 4K et YouTube 4K, avec une micro-pastille sur chacune des
  deux cartes.
- S3E1 affiche Spotify HD et n’affiche pas YouTube sans lien direct.
- Une page épisode sans lien YouTube direct n'affiche aucune carte YouTube.
- Une réponse Spotify audio-only interdit la pastille Spotify.
- Une vidéo YouTube avec miniature `maxres` valide utilise cette image dans
  `og:image` et `twitter:image` en 1280 × 720.
- L’absence de PostgreSQL, de worker ou d’API externe ne bloque pas le rendu.

## Activation production à réaliser

Cette liste conserve le plan initial de la version 1.5. Le relevé public du
11 septembre ci-dessous distingue l'état actuellement servi des correctifs
locaux 1.6 ; aucune nouvelle migration n'est nécessaire pour ces correctifs.

1. Appliquer les migrations 009 puis 010.
2. Vérifier la configuration YouTube existante sans révéler la clé.
3. Déployer et visiter S3E1 puis S3E2 pour déclencher l’enrichissement.
4. Vérifier en lecture seule les liens, le verdict Spotify et la miniature.
5. Contrôler les métadonnées sociales de S3E2 avec un validateur de partage.

## Historique de validation

Les versions 1.0 à 1.2 ont validé le parsing MP4/HLS, la résolution YouTube, le
rendu compact, le build et le mode dégradé. Leur essai avec les données réelles
a révélé l’erreur corrigée en 1.3 : l’enclosure RSS avait été utilisée à tort
comme preuve Spotify et la chaîne comme preuve YouTube.

Validation de la version 1.3 :

- 55 tests ciblés exécutés : 43 réussis et 12 intégrations externes ignorées ;
- suite complète de 150 tests : 137 réussis, 12 ignorés et seul le test mémoire
  Jimp fluctuant échoue à 47,47 Mo après warmup ; ses deux cas réussissent
  isolément avec GC explicite (-0,30 Mo et -0,04 Mo) ;
- `npm run build` réussi ; l’artefact CSS produit localement par Tailwind 4.1.11
  n’est pas conservé face à la version 4.3.3 du dépôt, et les classes utilisées
  existent dans l’artefact versionné ;
- migration 010 appliquée avec succès à la base PostgreSQL locale après 001–009,
  puis reconnue comme appliquée ;
- contrôle Tailscale avec les données publiques réelles : S3E2 affiche Spotify
  4K et YouTube 4K, les deux liens directs, les deux micro-pastilles et la
  miniature YouTube 1280 × 720 dans `og:image` et `twitter:image` ;
- `/podcast/3/2/` redirige vers l’URL canonique sans slash final.

La version 1.4 resserre le rendu après revue visuelle : la page principale ne
mentionne plus YouTube et une page épisode ne propose plus de lien générique vers
la chaîne lorsqu'aucune vidéo directe n'a été réconciliée. Les 28 tests ciblés de
routes podcast, mode dégradé et traction réussissent.

La version 1.5 clarifie la revue visuelle : la métadonnée vidéo agrégée disparaît
entièrement de `/podcast`, tandis que la carte générique YouTube revient dans la
liste des plateformes de diffusion. Elle ne revient jamais comme fallback sur une
page épisode. La pastille YouTube vidéo utilise un fond rouge et un texte blanc
pour assurer un contraste lisible.

Aucun changement de production, de variable Clever Cloud ou de base distante
n’est inclus dans cette activation locale.

### Contrôle du 11 septembre 2026 — version 1.6

- OVH : Deployment et pod applicatif prêts, santé `normal/read_write/ready`,
  aucune intention en attente. Image active
  `sha256:687496f9de669c13effd0c82772c7f6fd18a4ab40e18065ffeee518c12449d92`,
  commit source `f06f1a4d56cdb4a3444247054fe2f160a95a1bf6`.
- La page publique S3E2 pointe déjà vers le bon épisode Apple
  `1000787798745`, mais n'affiche pas Apple vidéo ni l'iframe YouTube.
- Le lookup public Apple annonce S3E2 en `video/mp4` ; son URL média correspond
  à l'enclosure principale RSS. `ffprobe` confirme **1920 × 1080**. S3E1 est
  encore annoncé audio par Apple, sans vidéo dans le RSS.
- La comparaison hors ligne des réponses publiques Apple et RSS retrouve les
  **27 épisodes par GUID**. La méthode historique par date confond S1E2, S1E3
  et S1E4 avec un autre épisode publié le même jour ; leurs anciens caches de
  production n'ont pas été modifiés par ce contrôle.
- Les tests de régression couvrent le MP4 principal et l'audio alternatif, les
  identités Apple, le trajet GUID → job → lien sauvegardé, la reprise de cache
  sans stockage et les conditions de rendu Apple/YouTube.
- Validation locale : 43 tests ciblés réussis ; suite `npm test` de 205 tests,
  **193 réussis, 12 intégrations ignorées, aucun échec** ; `npm run build` et
  `git diff --check` réussis.
- Contrôle visuel à 390 px et sur ordinateur : métadonnées Apple Full HD et
  iframe sans débordement. Le chargement et la lecture réelle de S3E2 dans
  l'iframe sont vérifiés dans Chrome, puis mis en pause. Le navigateur intégré
  à l'outil de développement conservait cette iframe vide ; ce résultat ne
  reproduit pas le fonctionnement constaté dans Chrome. Les téléchargements
  audio OP3 ont été neutralisés uniquement dans le serveur d'aperçu temporaire.

Les correctifs restent locaux. Après publication autorisée, vérifier sur le
domaine S3E2 (iframe, MP3 et badge Apple Full HD), S3E1 (sans badge Apple vidéo),
ainsi que les anciens liens de saison 1 après leur prochaine résolution.
