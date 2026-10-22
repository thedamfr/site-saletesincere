# Disponibilités vidéo — FISSURE S3E4

## Summary

Le propriétaire confirme le 21 octobre 2026 : YouTube en 4K, Spotify et Apple Podcasts en vidéo. La qualité éditoriale de S3E4 est donc « 4K » pour YouTube uniquement. Le lien direct reste nécessaire à l’affichage. Le Golden Journey `npm run test:e2e:podcast-video` vérifie les badges et les destinations dans un navigateur isolé.

## Synthèse

La table de qualités existante ajoute une seule entrée S3E4. Aucun schéma, accès externe ou mécanisme de cache ne change. Spotify et Apple conservent leur badge « Vidéo » sans résolution supposée ; leurs preuves de disponibilité restent indépendantes. La correction ne modifie pas les qualités déjà confirmées pour S3E2.

Les Golden Journeys couvrent la navigation depuis le catalogue, les badges et les clics vers les trois plateformes, le rechargement, les formats ordinateur/mobile, l’absence du lien YouTube puis son retour et les qualités de S3E2. La suite refuse les écritures de base et intercepte les destinations externes. Les fixtures RSS et cache sont en mémoire : ce contrôle ne valide ni la persistance PostgreSQL, ni la lecture réelle des vidéos, ni leur découverte automatique. Les métadonnées 4K sont la confirmation éditoriale du propriétaire.

La CI exécute cette commande et joint le rapport aux artefacts Golden Journeys. Le rapport indique SHA, modifications locales éventuelles, environnement et empreinte des fichiers testés. Les preuves de livraison et le résultat réellement observé en production sont consignés dans la PR.

## Annexes

### Commande de recette

Avec Node 24 et les dépendances verrouillées installées :

```bash
npm run test:e2e:podcast-video
```

Chromium conserve sa sandbox. `E2E_BROWSER_CHANNEL=chrome` ou `E2E_BROWSER_EXECUTABLE` sélectionne un navigateur existant. `E2E_OUTPUT` permet de choisir le dossier des preuves ; par défaut, elles restent dans `test-results/podcast-video`, hors Git.

### Références

- [Page S3E4](https://saletesincere.fr/podcast/3/4)
- [Vidéo YouTube](https://www.youtube.com/watch?v=WCInqunmc2A)
- [Table des qualités](../server/services/podcastVideoAvailability.js)
- [Golden Journeys](../test/e2e/podcast-video.test.mjs)
- [PRD de disponibilité vidéo](prd_youtube_podcast.md)

Le suivi de découverte automatique YouTube [#64](https://github.com/thedamfr/site-saletesincere/issues/64) reste distinct de cette correction d’affichage.
