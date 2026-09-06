# PRD — Disponibilité vidéo sur les pages podcast

**Version :** 1.5
**Date :** 2026-09-04
**Statut :** implémenté localement, activation production à réaliser

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
- Les cartes Spotify et YouTube reçoivent une micro-pastille vidéo seulement
  lorsque la vidéo de cet épisode est vérifiée sur la plateforme concernée.
- La carte YouTube n'existe sur une page épisode que lorsqu'un lien direct vers
  la vidéo de cet épisode a été réconcilié. Aucun lien générique de chaîne ne la
  remplace.
- S3E1 est marqué « Spotify (HD) ».
- S3E2 est marqué « Spotify (4K) · YouTube (4K) ».
- Lorsque YouTube fournit une miniature `maxres` 16/9, elle devient l’image Open
  Graph et Twitter de la page épisode. L’image OG existante reste le fallback.
- Aucun encart de disponibilité dédié n’est ajouté.

## Sources de vérité indépendantes

| Destination | Preuve exigée pour un épisode |
| --- | --- |
| Site officiel | `podcast:alternateEnclosure` MP4 ou HLS avec source HTTP(S) valide |
| Apple Podcasts | enclosure HLS et lien Apple direct de ce même épisode |
| Spotify | lien Spotify direct et réponse vidéo de l’oEmbed officiel, mise en cache |
| YouTube | lien vidéo direct résolu depuis la description de la vidéo |

Une preuve ne vaut jamais pour une autre destination. En particulier :

- l’enclosure de l’hébergeur ne prouve ni Spotify ni YouTube ;
- le lien de chaîne YouTube ne prouve aucun épisode ;
- un lien Spotify direct ne suffit pas à affirmer que son lecteur propose la
  vidéo.

### Flux RSS vidéo

Le parseur accepte les `podcast:alternateEnclosure` Podcasting 2.0 de type MP4
ou HLS et exige au moins un `podcast:source` HTTP(S). Il n’expose au rendu que
les capacités `mp4` et `hls`, jamais les URLs médias.

Le MP4 et le HLS ajoutés chez l’hébergeur restent donc la preuve du format vidéo
sur le site officiel. Le HLS, combiné au lien Apple direct du même épisode,
qualifie Apple Podcasts.

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
- S3E2 : Spotify 4K et YouTube 4K.

Une vidéo vérifiée sans qualité éditoriale reste indiquée simplement « Vidéo ».

## Fonctionnement

1. Le RSS fournit les métadonnées et les capacités vidéo hébergées.
2. La route lit les liens directs et les preuves de plateforme dans
   `episode_links`.
3. Si un lien Spotify n’a pas encore de verdict vidéo, ou si la miniature
   YouTube n’a pas encore été vérifiée, l’intention rejoint le job
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
