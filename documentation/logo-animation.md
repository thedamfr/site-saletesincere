# Animation du logo et laboratoire du geste

Le SVG autonome `public/images/logo-noname-web.svg` est utilisé sur la home et dans
le laboratoire public `/laboratoire-du-geste`. Il ne nécessite pas de JavaScript
sur la home ; les commandes interactives du laboratoire en utilisent.

## Une page de marque permanente

Le laboratoire est accessible dans tous les environnements, y compris en
production, sans dépendance à PostgreSQL ni au worker. Un lien dans le pied de
page de la home permet de le retrouver ; le logo d’en-tête et un lien de retour
ramènent à l’accueil. L’ancienne adresse `/__logo-lab` redirige en HTTP 301 vers
`/laboratoire-du-geste`.

La page possède une description et une URL canonique publiques, sans directive
`noindex`. Elle présente le geste comme une composante de l’identité et crédite
la créatrice du logo. Elle démarre en pause : le visiteur choisit de lire,
ralentir ou parcourir l’animation et d’afficher ou masquer les trajectoires.

Voir la décision complémentaire dans
[l’ADR 0017](adr/adr_0017_identite_claire_et_territoire_charbon_wafer.md).

## Surfaces et ordre de dessin

La silhouette originale du logo est le contour de découpe extérieur. Deux masques
intérieurs suivent les bords de cette silhouette et représentent les passages de
la main :

- **Rouge** : sommet, descente, croisillon, puis bord inférieur de la petite boucle.
- **Bleu** : bord supérieur de la petite boucle, second passage au croisillon,
  puis retour autour de la grande boucle.

Les deux surfaces se recouvrent dans le croisillon. Elles se rejoignent aussi au
sommet et à gauche de la petite boucle, avec un recouvrement d'un pixel SVG pour
éviter une couture d'anticrénelage. La découpe extérieure conserve les bords et les
évidements exacts du logo. Une séparation arbitraire en deux demi-plans ne convient
pas : elle laisserait le trait rouge peindre une portion du retour bleu.

Les trois traits sont normalisés avec `pathLength="1"`. Le passage rouge utilise
un trait principal, puis un trait plus étroit dans la petite boucle ; tous deux
sont contraints au masque rouge. Le retour utilise uniquement le masque bleu.
Les extrémités plates suivent la progression sans gros embout circulaire.
L'intervalle des tirets et le décalage initial incluent une marge pour ne pas
afficher de segment résiduel au démarrage.

Sur les 3,6 secondes de l'animation :

| Progression | Partie dessinée |
| --- | --- |
| 0–36 % | Descente et premier passage au croisillon |
| 36–52 % | Bas de la petite boucle |
| 52–96 % | Haut de la petite boucle et retour bleu |
| 96–100 % | Point final |

À 96 %, les traits eux-mêmes ont rempli tout le logo. Aucun logo plein n'est ajouté
pour masquer des manques à la fin. Avec `prefers-reduced-motion`, le SVG affiche
directement les traits terminés et le point.

Le laboratoire met en pause les animations CSS du SVG et modifie leur `currentTime`.
Les repères colorés sont copiés depuis les trajectoires réellement utilisées. La
position du curseur est calculée depuis le décalage du trait actif : il n'existe
pas de seconde animation approximative propre au laboratoire. La lecture manuelle
reste disponible dans le labo lorsque la réduction des animations est activée.

## Vérification visuelle automatisée

Le contrôle utilise Playwright, installé parmi les dépendances de développement,
et un navigateur Chromium. Pour installer le navigateur de test :

```bash
npm exec playwright install chromium
npm run check:logo-animation
```

Avec Google Chrome déjà installé, le téléchargement est inutile :

```bash
LOGO_BROWSER_CHANNEL=chrome npm run check:logo-animation
```

Le contrôle exécute les vraies animations CSS dans le navigateur et capture 101
étapes. Il vérifie l'absence d'encre à zéro, de remplissage prématuré de la surface
bleue, de fragments détachés et d'effacement du trait. À 96 %, il compare les
pixels intérieurs à la silhouette originale et recherche les débordements. Il
vérifie également le rendu sans animation, les commandes du laboratoire et la
synchronisation de son curseur, ainsi que l’absence de débordement horizontal de
320 à 1 400 pixels. Aucun serveur ni accès externe n'est nécessaire.

Les PNG et la planche de contrôle sont écrits dans le répertoire temporaire
`salete-logo-browser-check`, dont le chemin est affiché par la commande.
