---
title: Voice Posting MVP
description: Architecture décision pour implémenter l'enregistrement vocal avec transcription manuelle
owner: @thedamfr
status: implemented
review_after: 2025-12-01
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/adr/adr_0001_voice_posting_mvp.md
tags: [adr, audio, mvp, frontend, ui]
adr_number: 0001
date_created: 2025-07
date_implemented: 2025-07
impact: core
---

# ADR 0001 — Voice Posting MVP

## Plan d'implémentation

1. **Formulaire inline dans le hero (views/index.pug)**  
   - Modifier le hero pour inclure un formulaire qui se déplie au clic sur "+ Enregistrer votre histoire"
   - Conteneur collapse/expand avec :
     - Bouton Enregistrer / Arrêter avec feedback visuel
     - Champ `input` pour le **titre**  
     - Aperçu audio (`<audio>`) avec contrôles
     - Textarea pour la **transcription** obligatoire
     - Sélecteur de badge (Wafer/Charbon/Tous)
     - Bouton d'envoi avec loader
2. **Vanilla JS (public/js/record.js)** (MVP) Feature : Création de ## Plan d'implémentation

1. **Formulaire inline dans le hero (views/index.pug)**  
   - Modifier le hero pour inclure un formulaire qui se déplie au clic sur "+ Enregistrer votre histoire"
   - Conteneur collapse/expand avec :
     - Bouton Enregistrer / Arrêter avec feedback visuel
     - Champ `input` pour le **titre**  
     - Aperçu audio (`<audio>`) avec contrôles
     - Textarea pour la **transcription** obligatoire
     - Sélecteur de badge (Wafer/Charbon/Tous)
     - Bouton d'envoi avec loader
2. **Vanilla JS (public/js/record.js)** (MVP)

## Contexte

Saleté Sincère doit permettre aux utilisateur•rices de publier une anecdote vocale (max 90 s) avec une transcription obligatoire pour l’accessibilité. Le MVP vise à lancer cette fonctionnalité rapidement, sans lourde intégration ASR, tout en offrant une expérience fluide et conforme à la charte.


## Décision

Nous allons implémenter un **flow simplifié** pour le prototype :
1. **Enregistrement audio** (MediaRecorder) et saisie d’un **titre**.
2. **Transcription manuelle** obligatoire (textarea) pour garantir une base fiable.
3. **Envoi** du blob audio, du titre et du texte au serveur pour stockage en S3 et modération ultérieure.

La transcription ASR sera déplacée en phase 2, côté serveur, pour alimenter la modération automatique.

## Alternatives considérées

| Option                               | Avantages                                 | Inconvénients                         |
|--------------------------------------|-------------------------------------------|---------------------------------------|
| **ASR full (Whisper-Base)**          | Transcription automatique & rapide        | Modèle lourd (+600 Mo), latence élevée|
| **ASR in-browser (Tiny/Small)**      | Option rapide, client-side                | Qualité FR médiocre, déceptif         |
| **Manuel uniquement (MVP)**          | Pas de dépendance, meilleure qualité finale| Friction de saisie, risque d’abandon  |
| **API cloud ASR**                    | Qualité top, faible latence               | Dépendance réseau & coût              |


## Conséquences

+ **Simple à développer** : aucune gestion complexe de modèle ASR en MVP.  
+ **UX maîtrisée** : l’utilisateur contrôle toujours la transcription.  
+ **Extensible** : on pourra ajouter plus tard un pipeline ASR (Whisper-Base ou HF) en fallback ou en option.    
+ **Transcription server-side**: possibilité de faire tourner des modèles lourds (Whisper-Base, wav2vec2-french) côté serveur pour une qualité ASR optimale sans impacter le client.
+ **Accessibilité** : transcription validée, compatible screen-readers via `aria-live`.


## Plan d’implémentation

1. **Template Pug & layout**  
   - Créer `views/record.pug` avec :
     - Bouton Enregistrer / Arrêter 
     - Champ `input` pour le **titre**  
     - Aperçu audio (`<audio>`)  
     - Textarea pour la **transcription**  
     - Formulaire POST `/api/posts` (multipart/form-data)
2. **Vanilla JS (public/js/record.js)**  
   - Implémenter MediaRecorder setup/start/stop  
   - Générer Blob et afficher la preview audio  
   - Préremplir #audioBlob et #title et #transcript dans FormData
3. **Route POST `/api/posts`**  
   - Fastify + `@fastify/multipart` pour lire :
     - `audio` (file), `title` (string), `transcript` (string), `type` (Wafer/Charbon)
   - Sauvegarder le fichier audio dans Cellar S3 via URL signée  
   - Enregistrer en base Postgres : durée, titre, transcript, badge
4. **Feedback & navigation**  
   - Toast « Merci ! Votre histoire est envoyée pour modération. »  
   - Redirection vers le mur ou reset du formulaire
5. **Tests & accessibilité**  
   - Tests unitaires du JS (simulateur MediaRecorder)  
   - Vérification ARIA : labels, `aria-live` pour la preview audio

## Évolutions futures

- Ajouter Whisper-Base ou wav2vec2-french en option avancée.  
- Implémenter transcription streaming/chunking pour long formats.  
- Extraire en Web Component ou framework léger (Alpine.js) après stabilisation du flow.  
- Proposer résumé auto + enrichment GPT (ponctuation, chapitrage).
