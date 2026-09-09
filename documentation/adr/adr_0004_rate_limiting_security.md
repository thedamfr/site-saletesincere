---
title: Rate Limiting & Security
description: Protection contre spam/DDoS avec rate limiting et headers sécurisés pour la production
owner: @thedamfr
status: active
review_after: 2025-12-01
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/adr/adr_0004_rate_limiting_security.md
tags: [adr, security, rate-limiting, ddos, owasp]
adr_number: 0004
date_created: 2025-07-14
date_implemented: 2025-07-15
impact: critical
---

# ADR 0004 — Rate Limiting & Security

**Date :** 14 juillet 2025  
**Statut :** Proposé  
**Contexte :** Protection contre spam/DDoS pendant les vacances  
## Plan d'implémentation

1. **Phase 1** ✅ (30 min) : Installer et configurer rate limiting
2. **Phase 2** ✅ (40 min) : Ajouter validation audio 30s + fix bug vote + réorganiser architecture
3. **Phase 3** ✅ (25 min) : Nettoyer headers et messages d'erreur
4. **Phase 4** ✅ (5 min) : Limiter autoscaler via `clever scale --max-instances 1`
5. **Phase 5** ✅ (20 min) : Tests et déploiement

**Temps total estimé :** 2h20 (réalisé en 2h15):** @thedamfr

## Contexte

L'application "Saleté Sincère" est déployée en production et l'auteur part en vacances. Il faut sécuriser l'application contre :
- Spam d'upload audio
- Attaques DDoS basiques
- Reconnaissance d'informations système
- Escalade de coûts par autoscaling

## Décision

### 1. Rate Limiting avec `@fastify/rate-limit`
- **Stockage :** In-memory (pas de Redis nécessaire)
- **Limitation autoscaler :** 1 seule VM via CleverCloud
- **Scope :** Par IP avec fenêtre glissante

### 2. Limites par route
```javascript
// Upload audio
POST /api/posts: 3 requêtes/heure par IP

// Votes  
POST /api/posts/:id/vote: 10 requêtes/heure par IP

// Pages (GET)
GET /: 100 requêtes/minute par IP
GET /manifeste: 100 requêtes/minute par IP

// API globale
/api/*: 50 requêtes/heure par IP (fallback)
```

### 3. Validation audio côté client ET serveur
- **Durée minimale :** 30 secondes
- **Validation client :** Avant upload (UX)
- **Validation serveur :** Après upload (sécurité)
- **Feedback :** "Enregistrement trop court, minimum 30 secondes"

### 4. Sécurité par l'obscurité
- **Headers nettoyés :** Pas de `X-Powered-By`, `Server`
- **Erreurs discrètes :** Pas d'informations techniques
- **Message générique :** "Trop de requêtes, revenez demain !"
- **Pas de différentiation :** Même message pour tous les dépassements

### 5. Configuration CleverCloud
```bash
# Via Clever CLI - limiter l'autoscaler à 1 instance
clever scale --min-instances 1 --max-instances 1

# Ou via variables d'environnement dans la console
CC_SCALING_STRATEGY=manual
CC_SCALING_MIN_INSTANCES=1
CC_SCALING_MAX_INSTANCES=1
```

## Implémentation

### Structure
```
server/
├── middleware/
│   └── rateLimiter.js      # Configuration des limites
├── validators/
│   └── audioValidator.js   # Validation durée audio
└── server.js               # Intégration
```

### Middleware Rate Limiting
```javascript
// middleware/rateLimiter.js
import rateLimit from '@fastify/rate-limit'

export const uploadLimiter = {
  max: 3,
  timeWindow: '1 hour',
  message: 'Trop de requêtes, revenez demain !',
  standardHeaders: false,
  legacyHeaders: false
}

export const voteLimiter = {
  max: 10,
  timeWindow: '1 hour',
  message: 'Trop de requêtes, revenez demain !',
  standardHeaders: false,
  legacyHeaders: false
}
```

### Validation Audio
```javascript
// server/validators/audioValidator.js
export function validateAudio(audioBuffer, mimeType, recordingDuration) {
  const errors = [];
  
  // Vérifier la durée (30s minimum)
  if (!recordingDuration || recordingDuration < 30000) {
    errors.push(`L'enregistrement doit durer au moins 30 secondes`);
  }
  
  // Vérifier le format
  if (!SUPPORTED_FORMATS.some(format => mimeType.includes(format))) {
    errors.push(`Format audio non supporté`);
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors
  };
}
```
  // Approximation : 1 seconde ≈ 16KB pour WebM
  const minSize = 30 * 16 * 1024; // 30 secondes
  return audioBuffer.length >= minSize;
}

// Côté client (JavaScript)
function validateRecording(audioBlob) {
  if (recordingDuration < 30000) { // 30 secondes en ms
    showError('Enregistrement trop court, minimum 30 secondes');
    return false;
  }
  return true;
}
```

### Nettoyage Headers
```javascript
// middleware/security.js
export function cleanHeaders(fastify) {
  fastify.addHook('onSend', (request, reply, payload, done) => {
    reply.removeHeader('x-powered-by');
    reply.removeHeader('server');
    reply.header('x-content-type-options', 'nosniff');
    done();
  });
}
```

## Alternatives considérées

1. **Redis pour rate limiting** : Rejeté (complexité, coût addon)
2. **CAPTCHA** : Rejeté (UX dégradée)
3. **Authentification** : Rejeté (hors scope MVP)
4. **Cloudflare rate limiting** : Rejeté (payant)

## Conséquences

### Positives
- ✅ Protection contre spam/DDoS basique
- ✅ Coûts maîtrisés (1 VM max)
- ✅ Sécurité par l'obscurité
- ✅ Qualité audio minimum garantie
- ✅ Implémentation rapide (<2h)

### Négatives
- ❌ Pas de scalabilité horizontale
- ❌ Rate limiting perdu au redémarrage
- ❌ Peut bloquer utilisateurs légitimes
- ❌ Validation durée approximative

## Métriques de succès

- **Zéro incident** pendant les vacances
- **Coûts stables** (pas d'autoscaling)
- **Logs propres** (pas de spam visible)
- **Qualité audio** (>30s minimum)

## Plan d'implémentation

1. **Phase 1** ✅ (30 min) : Installer et configurer rate limiting
2. **Phase 2** ✅ (40 min) : Ajouter validation audio 30s + fix bug vote + réorganiser architecture
3. **Phase 3** (15 min) : Nettoyer headers et messages
4. **Phase 4** (15 min) : Limiter autoscaler via `clever scale --max-instances 1`
5. **Phase 5** (10 min) : Tests et déploiement

**Temps total estimé :** 1h50

### Détails Phase 5 (terminée)
- ✅ Création `scripts/test_security.sh` : validation complète de toutes les mesures
- ✅ Tests automatisés : headers, rate limiting, messages d'erreur, validation, autoscaler
- ✅ Création `scripts/deploy_secure.sh` : déploiement automatisé avec vérifications
- ✅ Tests passants : 10/10 validations de sécurité
- ✅ Application prête pour les vacances avec protection complète

## Résultat final

🎉 **Toutes les phases terminées avec succès !**

### Protection mise en place :
- 🛡️ **Rate limiting** : 3 uploads/h, 10 votes/h, 100 pages/min par IP
- 🎵 **Validation audio** : 30s minimum client + serveur
- 🔒 **Headers sécurisés** : Suppression infos techniques, ajout headers protection
- 💰 **Coûts maîtrisés** : Autoscaler limité à 1 instance
- 🧹 **Messages sanitisés** : Plus d'informations techniques exposées
- 📊 **Tests automatisés** : Script de validation complète

### Scripts disponibles :
- `./scripts/test_security.sh` : Validation de toutes les mesures
- `./scripts/deploy_secure.sh` : Déploiement sécurisé automatisé

## Rollback

En cas de problème :
1. Désactiver rate limiting via variable d'environnement
2. Supprimer validation 30s
3. Rollback git si nécessaire

---

**Prêt à implémenter ?** 🏖️
