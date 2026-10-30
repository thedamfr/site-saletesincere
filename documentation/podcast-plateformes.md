# Qualification des cartes podcast

## Summary (30 secondes)

Le CTA de `/podcast` présente le site du podcast et ses transcripts complets.
YouTube, Apple Podcasts et Spotify affichent « Vidéo selon les épisodes ».
La commande `npm run test:e2e:podcast` qualifie ces cartes et la séparation avec
les disponibilités propres aux épisodes. Aucun déploiement n'est inclus.

## Synthèse (3 minutes)

Les Golden Journeys vérifient le texte, les destinations, les trois badges,
les clics et l'activation clavier du CTA, ainsi que l'absence de débordement
à 320, 390 et 1440 pixels. La page générale est testée sans base disponible,
puis rechargée. Les pages épisode sont testées avec vidéo confirmée, sans vidéo,
pendant une indisponibilité de base et après reprise.

Le serveur local utilise des données RSS et un adaptateur de base simulés ;
aucune base réelle n'est contactée et le worker est désactivé. Les destinations
externes sont interceptées : les tests vérifient la navigation vers la bonne
URL, pas le contenu ou la disponibilité de ces services. Les ressources externes,
notamment les polices distantes, sont également simulées ; les captures utilisent
les polices de repli. Ce changement ne crée
ni donnée persistante ni droit utilisateur ; aucun test d'écriture n'est requis.

Node.js 24 ou plus récent et Chromium avec sandbox opérationnelle sont requis.
Exécuter `npm test`, `npm run build`, puis `npm run test:e2e:podcast` et
`git diff --check`. Les captures sont déposées dans `test-results/podcast/`,
ignoré par Git. Examiner les captures en complément des interactions.

## Annexes

### Environnement navigateur sur le serveur OVH

Utiliser le binaire déjà autorisé par AppArmor sans désactiver sa sandbox :

```sh
E2E_BROWSER_EXECUTABLE=/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run test:e2e:podcast
```

Si le bac à sable de l'agent interdit le port local, exécuter avec l'élévation
prévue par l'environnement. La suite ferme son propre navigateur et serveur.

### Références

- [PRD vidéo](prd_youtube_podcast.md)
- [Golden Journeys automatisés](../test/e2e/podcast.test.mjs)
- [Tests de rendu](../test/routes/podcast-availability.test.js)
