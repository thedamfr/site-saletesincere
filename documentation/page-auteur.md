# Page auteur et référencement

## Summary

La page `/damien-cavailles` présente Damien, ses références éditoriales et ses
interventions. Modifier `content/damien-cavailles.md`, puis lancer `npm run build`.
Le Markdown est compilé une seule fois au build et le HTML est rendu côté serveur.
Le portrait officiel se télécharge sans transformation. `/robots.txt` annonce
`/sitemap.xml`. La publication suit la livraison continue habituelle.

## Synthèse

Le premier titre `#` contient le nom, le premier paragraphe le rôle. Les paragraphes
suivants constituent la biographie ; chaque titre `##` ouvre une rubrique.
Les listes contiennent des liens Markdown, les crédits, les dates connues et le
rôle de Damien. Un antislash en fin de ligne conserve un retour à la ligne.
Le HTML brut est désactivé et les URL dangereuses sont refusées par markdown-it.
Le contenu éditorial reste un fichier texte sans front matter ni composants.

La première rubrique accompagne la photo de discussion chez leboncoin. Les textes
Medium sont présentés comme travail d’éditeur sur instruction du propriétaire,
avec crédit aux auteurs. La sélection WeLoveDevs reste limitée à trois articles
au maximum, complétée par un lien d’archive. Les webinars et invitations en podcast
occupent des rubriques distinctes. Les liens pointent vers les sources, sans
recopier les articles ni télécharger les vidéos.

`npm run build:views` produit `server/generated/author.json`, exclu de Git.
`npm run build` le régénère aussi dans Docker, avant suppression des dépendances
de développement. Redémarrer le serveur après un build modifié. La page fonctionne
sans base ni flux RSS ; un build absent donne une erreur temporaire 503 sur cette
seule page. Les métadonnées incluent canonical, Open Graph et ProfilePage/Person.

Le sitemap utilise le flux public des épisodes, sans requête PostgreSQL. Il garde
un cache d’une heure par processus, mutualise les requêtes simultanées, et conserve
le dernier résultat lors d’une panne. Sans cache, il répond 503 avec Retry-After
300 ; la reprise est retentée après cinq minutes. Seuls les chemins publics
canoniques et les numéros d’épisode valides sont listés, sans date inventée.
Le sitemap facilite la découverte ; il ne garantit pas un classement dans Google.

## Annexes

### Vérification reproductible

Avec Node.js 24 et les dépendances installées :

```sh
npm test
npm run build
npm run test:e2e:install
npm run test:e2e
git diff --check
```

Les Golden Journeys ouvrent le vrai serveur et Chromium avec sa sandbox :
accueil/podcast → auteur → téléchargement exact du portrait → référence éditoriale
→ contact ; puis lecture sans JavaScript à 320, 390 et 1440 px, redirection
canonique, JSON-LD, robots et sitemap. Le flux local est une fixture vide et la
destination Medium est simulée : ils ne valident pas la disponibilité des éditeurs
externes. Aucun formulaire n’est envoyé. Les tests de service vérifient panne,
cache et reprise. Aucune persistance ou permission d’écriture n’est ajoutée.
Les captures sont écrites dans `/tmp/site-author-e2e` ou `E2E_OUTPUT` et conservées
par la CI. `E2E_BASE_URL` permet une recette publique en lecture seule ;
`E2E_BROWSER_EXECUTABLE` permet un Chromium déjà installé. La CI utilise
`E2E_BROWSER_CHANNEL=chrome`, le Chrome préinstallé du runner compatible avec
AppArmor ; la sandbox Chromium reste active.

### Sources et assets

Les URL des publications sont conservées directement dans le Markdown. Les rôles
éditoriaux leboncoin et le choix du portrait ont été confirmés par le propriétaire.
Le portrait existant `public/images/damien-podcast.jpg` (2304 × 1536) est servi
à l’identique avec Content-Disposition attachment. La photo de discussion fournie
par le propriétaire est disponible en 800 × 600. Aucune licence supplémentaire ni
signature photographique n’est inventée. La date Insitoo reste omise faute de date
exacte attestée. Le lien Free-Work est la page de l’événement LinkedIn.

Décision : [ADR 0021](adr/adr_0021_page_auteur_et_sitemap.md).
Livraison : [procédure existante](livraison-continue.md).
