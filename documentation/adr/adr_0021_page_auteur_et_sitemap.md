# ADR 0021 — Page auteur Markdown et sitemap public

## Summary

Accepté le 25 septembre 2026. Ajouter `/damien-cavailles`, son portrait original
à télécharger, `/robots.txt` et `/sitemap.xml`. Compiler le contenu Markdown au
build en JSON contenant du HTML sûr, rendu par Handlebars. Aucun stockage ni
migration. La décision répond à la demande de page auteur/bibliographie et de
contenu simple à entretenir, avec une mise en production autorisée.

## Synthèse

Une page dédiée au nom complet, liée depuis l’accueil et le podcast, rassemble la
biographie, le travail d’éditeur, les articles signés et les interventions. Le
portrait officiel au micro précède la photo de travail leboncoin. Le style reste
sobre et les photos en couleur. Les liens externes et leurs crédits sont gérés
dans un Markdown unique ; les métadonnées sont dérivées du nom et du rôle.

La compilation est intégrée à `npm run build:views`, au build Docker et au prétest.
Le parseur markdown-it reste une dépendance de développement. HTML brut désactivé,
protocole dangereux refusé, sorties de métadonnées échappées : les sources ne sont
pas du code exécutable. Le serveur charge une fois le JSON généré. Le build vérifie
le titre, le rôle, la biographie et les sections ; un artefact absent ne bloque pas
les autres routes et donne un 503 sur la page auteur.

Le sitemap associe les quatre pages publiques statiques aux épisodes du flux
Castopod existant. Un cache d’une heure par processus et une seule actualisation
simultanée limitent la charge externe. Une erreur conserve le cache précédent ;
sans cache, réponse temporaire 503 avec nouvelle tentative après cinq minutes.
Les dates non vérifiables et les routes techniques ne sont pas annoncées.

Les tests unitaires et HTTP couvrent compilation, contenu sans base, téléchargement
identique, canonical, sitemap et panne/reprise. Les Golden Journeys navigateur
vérifient navigation, lecture mobile sans JS et téléchargement. Les médias externes
restent des liens. Limites : disponibilité du RSS pour le premier sitemap et
délai d’indexation propre aux moteurs ; aucune promesse de positionnement.

## Annexes

- [Guide de contenu et commandes](../page-auteur.md).
- Retour arrière : revenir à l’image validée précédente via la procédure de
  livraison, sans modification de données. Les nouvelles routes disparaissent.
- Alternative écartée : parsing Markdown par requête ou cache runtime, inutile
  pour un contenu versionné publié avec l’application.
