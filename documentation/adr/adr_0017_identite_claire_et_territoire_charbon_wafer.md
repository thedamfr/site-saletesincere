# ADR-0017 : Identité claire de la landing et territoire Charbon & Wafer

**Date** : 9 septembre 2026  
**Statut** : Accepté  
**Contexte** : Refonte Saleté Sincère, PRD v3 et maquette blanche

---

## Contexte

La landing historique utilisait un fond sombre, une texture kintsugi et le jaune comme
accent transversal. La nouvelle identité replace la trace au centre de la marque :
cette trace évoque le charbon, elle ne doit donc pas être représentée comme une trace
peinte en jaune.

Le jaune `#FFC330` appartient au territoire visuel autonome du podcast Charbon &
Wafer. Plusieurs passages du PRD v3 décrivent encore l'ancien traitement sombre ou
un usage général du jaune. Ils sont contradictoires avec la maquette blanche, la
palette mise à jour et la clarification produit du 9 septembre 2026.

La refonte modifie aussi la hiérarchie publique de la page d'accueil : Saleté Sincère
présente d'abord les offres, les preuves et l'expérience, tandis que Charbon & Wafer
constitue un bloc éditorial distinct.

## Décision

1. La landing `/` utilise un fond ivoire clair et une identité Saleté Sincère en noir
   et gris.
2. L'accroche principale reste purement typographique. Aucun geste peint jaune ni
   décor kintsugi n'est utilisé.
3. Les titres, boutons et libellés structurants utilisent Oswald ; les textes courants
   utilisent Inter.
4. Le logo horizontal officiel noir sur fond transparent est utilisé dans l'en-tête
   et le pied de page.
5. Le jaune `#FFC330` est réservé au bloc Charbon & Wafer : jaquette, libellés et
   appel à l'action du podcast.
6. Les épisodes présentés sur la landing proviennent du flux RSS existant, dans la
   limite de trois. Une indisponibilité du flux ne doit pas empêcher le rendu de `/`.
7. Les points d'entrée visibles vers le Sale-wall sont retirés de la landing et de la
   navigation publique. La route `/wall` et ses API sont conservées tant qu'une
   suppression technique n'est pas explicitement décidée.

En cas d'écart avec les descriptions visuelles résiduelles du PRD v3, cette décision,
la maquette blanche et la palette mise à jour font foi.

## Conséquences

### Bénéfices

- Séparation nette entre la marque Saleté Sincère et le territoire du podcast.
- Meilleure lisibilité sur fond clair et hiérarchie plus éditoriale.
- Cohérence entre le sens de la trace, les assets officiels et l'interface publique.
- Landing disponible même lorsque le flux RSS est temporairement indisponible.

### Coûts et limites

- Les polices Google restent chargées depuis un service externe, avec une pile de
  repli locale.
- La route `/wall` subsiste sans lien depuis la landing ; son éventuelle dépréciation
  nécessite une décision distincte portant sur les données et les API associées.

## Vérifications attendues

- Rendu desktop, tablette et mobile sans débordement horizontal.
- Navigation clavier et focus visibles.
- Contraste lisible sur le fond clair et sur le bloc podcast sombre.
- Absence de jaune visible hors du bloc Charbon & Wafer.
- Rendu de `/` en HTTP 200 lorsque le flux RSS échoue.
