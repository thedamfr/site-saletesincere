/**
 * Routes Newsletter Saleté Sincère - Integration Brevo
 * Formulaire, inscription double opt-in, confirmation, désinscription
 */

import { createNewsletterService } from './newsletterService.js';
import { newsletterLimiter, newsletterActionLimiter, pageLimiter } from '../middleware/rateLimiter.js';

const TAGLINE = "Passe en cuisine. Rejoins Saleté Sincère.";

/**
 * Validation email stricte (sécurité A03)
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email requis' };
  }

  const cleanEmail = email.trim().toLowerCase();
  
  if (!cleanEmail) {
    return { valid: false, error: 'Email vide' };
  }

  // Regex RFC 5322 simplifiée mais stricte
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  
  if (!emailRegex.test(cleanEmail)) {
    return { valid: false, error: 'Format email invalide' };
  }

  if (cleanEmail.length > 254) {
    return { valid: false, error: 'Email trop long' };
  }

  return { valid: true, email: cleanEmail };
}

/**
 * Routes Plugin Fastify
 */
export default async function newsletterRoutes(fastify, options) {
  const service = options.service || createNewsletterService({ database: fastify.pg, logger: fastify.log });
  const recoveryEnabled = options.recoveryEnabled ?? process.env.DISABLE_WORKER !== 'true';
  if (recoveryEnabled) fastify.addHook('onReady', async () => { service.start(); });
  fastify.addHook('onClose', async () => { await service.stop(); });
  
  // GET /newsletter - Page formulaire d'inscription
  fastify.get('/', {
    config: {
      rateLimit: pageLimiter
    }
  }, async (request, reply) => {
    return reply.view('newsletter/subscribe', {
      title: 'Newsletter Saleté Sincère',
      tagline: TAGLINE,
      description: 'Recevez nos nouveautés audio et les épisodes longs avant tout le monde.'
    });
  });

  // POST /newsletter/subscribe - Traitement inscription
  fastify.post('/subscribe', {
    config: {
      rateLimit: newsletterLimiter
    }
  }, async (request, reply) => {
    try {
      // Validation email
      const { email } = request.body || {};
      const validation = validateEmail(email);
      
      if (!validation.valid) {
        return reply.status(400).view('newsletter/error', {
          title: 'Erreur d\'inscription',
          error: validation.error,
          backLink: '/newsletter'
        });
      }

      const result = await service.subscribe(validation.email);
      
      if (result.state === 'submitted') {
        return reply.view('newsletter/pending', {
          title: 'Demande prise en compte',
          email: validation.email,
          tagline: TAGLINE,
          message: 'Votre demande a été prise en compte. Si une confirmation est nécessaire, consultez votre boîte mail.',
          submitted: true
        });
      }
      if (['ready', 'sending', 'uncertain'].includes(result.state)) {
        const uncertain = result.state !== 'ready';
        return reply.status(202).view('newsletter/pending', {
          title: uncertain ? 'Demande en cours de vérification' : 'Demande enregistrée',
          email: validation.email,
          tagline: TAGLINE,
          message: uncertain
            ? 'Votre demande est enregistrée. Nous vérifions son traitement ; aucun nouvel envoi ne sera déclenché sans vérification.'
            : 'Votre demande est enregistrée. Son traitement reprendra automatiquement dès le retour du service.',
          submitted: false
        });
      }
      return reply.status(result.state === 'rejected' ? 422 : 503).view('newsletter/error', {
          title: 'Erreur d\'inscription',
          error: result.state === 'rejected'
            ? 'Cette demande ne peut pas être traitée. Aucun nouvel envoi n’a été déclenché.'
            : 'Service temporairement indisponible. Votre demande n’a pas pu être enregistrée, réessayez plus tard.',
          backLink: '/newsletter'
        });
      
    } catch {
      fastify.log.error({ event: 'newsletter_request_failed' }, 'newsletter_request_failed');
      
      return reply.status(500).view('newsletter/error', {
        title: 'Erreur d\'inscription',
        error: 'Une erreur inattendue s\'est produite.',
        backLink: '/newsletter'
      });
    }
  });

  // GET /newsletter/confirmed - Page après confirmation email
  fastify.get('/confirmed', {
    config: {
      rateLimit: newsletterActionLimiter
    }
  }, async (request, reply) => {
    return reply.view('newsletter/confirmed', {
      title: 'Inscription confirmée !',
      tagline: TAGLINE,
      homeLink: '/'
    });
  });



}
