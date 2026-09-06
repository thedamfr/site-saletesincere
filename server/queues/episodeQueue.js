/**
 * Episode Queue - pg-boss pour résolution épisodes en background
 * Phase 3 TDD + Phase 3 OG Images
 */

import PgBoss from 'pg-boss'
import { 
  searchSpotifyEpisode, 
  searchAppleEpisode, 
  searchDeezerEpisode,
  searchYouTubeEpisodeMedia,
  isYouTubeEpisodeResolutionConfigured
} from '../services/platformAPIs.js'
import {
  getOGImageS3Key,
  isExpectedOGImageUrl
} from '../services/ogImageLayout.js'
import { generateOGImage } from '../services/ogImageGenerator.js'
import { uploadToS3, deleteFromS3 } from '../services/s3Service.js'
import { registerOp3StatsQueue } from './op3StatsQueue.js'
import { inspectSpotifyEpisodeVideo } from '../services/podcastVideoAvailability.js'

let boss = null
let queueShuttingDown = false

export const EpisodeQueueReason = Object.freeze({
  QUEUED: 'QUEUED',
  ALREADY_QUEUED: 'ALREADY_QUEUED',
  WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE',
  SHUTTING_DOWN: 'SHUTTING_DOWN',
  QUEUE_ERROR: 'QUEUE_ERROR'
})

export function isEpisodeCacheComplete(cached, {
  expectedOgImageS3Key,
  feedLastBuildDate,
  youtubeResolutionEnabled = false,
  now = Date.now()
}) {
  const cachedFeedDate = cached?.feed_last_build
    ? new Date(cached.feed_last_build).getTime()
    : Number.NEGATIVE_INFINITY
  const requestedFeedDate = feedLastBuildDate
    ? new Date(feedLastBuildDate).getTime()
    : Number.NEGATIVE_INFINITY
  const generatedAt = cached?.generated_at
    ? new Date(cached.generated_at).getTime()
    : Number.NEGATIVE_INFINITY
  const imageIsFresh = now - generatedAt <= 7 * 24 * 60 * 60 * 1000
  const feedIsFresh = cachedFeedDate >= requestedFeedDate

  return Boolean(
    cached?.spotify_url
    && typeof cached?.spotify_video_available === 'boolean'
    && cached?.apple_url
    && cached?.deezer_url
    && (
      !youtubeResolutionEnabled
      || (cached?.youtube_url && cached?.youtube_thumbnail_checked === true)
    )
    && cached?.og_image_url
    && imageIsFresh
    && feedIsFresh
    && isExpectedOGImageUrl(cached?.og_image_url, expectedOgImageS3Key)
  )
}

function getConnectionString() {
  return process.env.DATABASE_URL
    || process.env.POSTGRESQL_ADDON_URI
    || 'postgresql://salete:salete@localhost:5432/salete'
}

async function stopCandidate(candidate) {
  if (!candidate) return

  try {
    await candidate.stop({ graceful: false })
  } catch {
    // Best effort: a failed start can leave pg-boss only partially initialized.
  }
}

async function createStartedQueue(options = {}) {
  const {
    bossFactory = (config) => new PgBoss(config),
    ...bossOptions
  } = options

  const isTest = process.env.NODE_ENV === 'test' || process.env.DISABLE_WORKER === 'true'
  const candidate = bossFactory({
    connectionString: getConnectionString(),
    schema: 'pgboss',
    max: isTest ? 3 : 1,
    newJobCheckInterval: isTest ? 200 : 2000,
    ...bossOptions
  })

  try {
    await candidate.start()
    await candidate.createQueue('resolve-episode')
    return candidate
  } catch (error) {
    await stopCandidate(candidate)
    throw error
  }
}

/**
 * Initialise pg-boss avec PostgreSQL
 * Utilisé directement par les tests de queue. En production, le démarrage
 * atomique passe par initializeEpisodeWorker().
 * @param {object} options - Options pg-boss
 * @returns {Promise<PgBoss>} Instance pg-boss active
 */
export async function initQueue(options = {}) {
  const candidate = await createStartedQueue(options)
  boss = candidate
  queueShuttingDown = false
  return candidate
}

/**
 * Récupère l'instance pg-boss (pour cleanup tests)
 * @returns {PgBoss|null}
 */
export function getBoss() {
  return boss
}

export function setEpisodeQueueShuttingDown(shuttingDown) {
  queueShuttingDown = Boolean(shuttingDown)
}

export async function stopQueue(instance = boss) {
  if (!instance) return
  if (boss === instance) boss = null
  await stopCandidate(instance)
}

/**
 * Enqueue job résolution épisode (avec déduplication)
 * @param {number} season - Numéro saison
 * @param {number} episode - Numéro épisode
 * @param {string} episodeDate - Date publication ISO (YYYY-MM-DD)
 * @param {string} title - Titre épisode  
 * @param {string} imageUrl - URL image cover
 * @returns {Promise<object>} Résultat explicite de mise en queue
 */
export async function queueEpisodeResolution(season, episode, episodeDate, title, imageUrl, feedLastBuildDate = null, audioUrl = null) {
  if (queueShuttingDown) {
    return {
      queued: false,
      reason: EpisodeQueueReason.SHUTTING_DOWN
    };
  }

  // Safe guard: le rendu HTTP reste disponible tant que le worker est absent.
  if (!boss) {
    return {
      queued: false,
      reason: EpisodeQueueReason.WORKER_UNAVAILABLE
    };
  }
  
  try {
    const jobId = await boss.send('resolve-episode',
      { season, episode, episodeDate, title, imageUrl, feedLastBuildDate, audioUrl },
      {
        singletonKey: `episode-${season}-${episode}`,  // Idempotency key (throttling)
        singletonSeconds: 300  // Throttle 5 min : 1 job max par slot temporel
        // Note: Pas de retryLimit (pas de retry auto, worker doit être idempotent)
      }
    )

    if (!jobId) {
      return {
        queued: false,
        reason: EpisodeQueueReason.ALREADY_QUEUED
      }
    }

    return {
      queued: true,
      reason: EpisodeQueueReason.QUEUED,
      jobId
    }
  } catch (error) {
    return {
      queued: false,
      reason: EpisodeQueueReason.QUEUE_ERROR,
      error
    }
  }
}

/**
 * Démarre le worker pour traiter les jobs resolve-episode
 * Worker DOIT être idempotent (vérifier si travail déjà fait avant d'appeler APIs)
 * @param {object} fastify - Instance Fastify avec pool pg
 * @param {object} options - Worker options (teamSize pour tests parallèles)
 * @param {PgBoss} queue - Instance explicite pendant l'initialisation atomique
 */
export async function startWorker(fastify, options = {}, queue = boss) {
  if (!queue) {
    throw new Error('Cannot start episode worker before pg-boss is ready')
  }

  const {
    spotifyVideoInspector = inspectSpotifyEpisodeVideo,
    ...pgBossWorkerOptions
  } = options
  const workerOptions = {
    teamSize: pgBossWorkerOptions.teamSize || 1, // Nombre de jobs en parallèle (2+ pour tests)
    ...pgBossWorkerOptions
  }
  const youtubeResolutionEnabled = isYouTubeEpisodeResolutionConfigured()
  
  await queue.work('resolve-episode', workerOptions, async (jobs) => {
    // pg-boss v9 passe un array de jobs (batch mode par défaut)
    const job = jobs[0]
    
    const { season, episode, episodeDate, title, imageUrl, feedLastBuildDate, audioUrl } = job.data
    
    console.log(`[Worker ${job.id}] Resolving S${season}E${episode}: ${title}`)
    console.log(`[Worker ${job.id}] imageUrl:`, imageUrl, '| feedLastBuildDate:', feedLastBuildDate)

    // Idempotency check before image generation and platform API calls. The route
    // may enqueue again after a retry window even though another visit completed
    // the cache in the meantime.
    const expectedOgImageS3Key = getOGImageS3Key({
      season,
      episode,
      imageUrl,
      feedLastBuildDate
    })
    let cachedEpisodeLinks = null
    const cacheClient = await fastify.pg.connect()
    try {
      const cacheResult = await cacheClient.query(
        `SELECT spotify_url, spotify_video_available, apple_url, deezer_url,
                youtube_url, youtube_thumbnail_url, youtube_thumbnail_checked,
                og_image_url,
                feed_last_build, generated_at
         FROM episode_links
         WHERE season = $1 AND episode = $2`,
        [season, episode]
      )
      cachedEpisodeLinks = cacheResult.rows[0] || null
      const cacheIsComplete = isEpisodeCacheComplete(cachedEpisodeLinks, {
        expectedOgImageS3Key,
        feedLastBuildDate,
        youtubeResolutionEnabled
      })

      if (cacheIsComplete) {
        console.log(`[Worker ${job.id}] Cache already complete, skipping enrichment`)
        return { skipped: true, reason: 'CACHE_COMPLETE' }
      }
    } finally {
      cacheClient.release()
    }
    
    // Use episode date from RSS for platform API lookups
    
    // Phase 3: Générer OG Image (ADR-0012)
    let ogImageUrl = null;
    let ogImageS3Key = null;
    
    try {
      console.log(`[Worker ${job.id}] Generating OG Image from ${imageUrl}`)
      
      // 1. Générer PNG buffer avec blur effect
      const ogImageBuffer = await generateOGImage(imageUrl);
      
      // 2. Deterministic key derived from episode data and the layout version
      ogImageS3Key = expectedOgImageS3Key;
      
      // 3. Upload PNG vers S3 (cleanup de l'ancienne sera fait dans le bloc DB)
      ogImageUrl = await uploadToS3(ogImageBuffer, ogImageS3Key, 'image/png');
      console.log(`[Worker ${job.id}] ✅ OG Image uploaded: ${ogImageUrl}`);
      
    } catch (ogError) {
      console.error(`[Worker ${job.id}] ⚠️ OG Image generation failed:`, ogError.message);
      console.error(`[Worker ${job.id}] Full error:`, ogError);
      // Continue sans bloquer la résolution des liens plateformes
    }
    
    // Appeler les APIs en parallèle
    const [spotifyResult, appleResult, deezerResult, youtubeResult] = await Promise.allSettled([
      searchSpotifyEpisode(episodeDate),
      searchAppleEpisode(episodeDate),
      searchDeezerEpisode(episodeDate),
      youtubeResolutionEnabled ? searchYouTubeEpisodeMedia(season, episode) : Promise.resolve(null)
    ])
    
    // Podcast Addict: Pas d'API publique connue
    // Fallback vers le show au lieu de l'épisode spécifique
    // Format épisode serait : http://podcastaddict.com/{slug}/episode/{episodeId}
    // Mais on n'a pas d'API pour résoudre episodeId
    const podcastAddictId = process.env.PODCASTADDICT_PODCAST_ID;
    const podcastAddictLink = podcastAddictId 
      ? `https://podcastaddict.com/podcast/${podcastAddictId}`
      : null;
    
    const links = {
      spotify: spotifyResult.status === 'fulfilled' ? spotifyResult.value : null,
      apple: appleResult.status === 'fulfilled' ? appleResult.value : null,
      deezer: deezerResult.status === 'fulfilled' ? deezerResult.value : null,
      youtube: youtubeResult.status === 'fulfilled' ? youtubeResult.value?.url || null : null,
      youtubeThumbnail: youtubeResult.status === 'fulfilled'
        ? youtubeResult.value?.thumbnailUrl || null
        : null,
      youtubeThumbnailChecked: youtubeResolutionEnabled
        && youtubeResult.status === 'fulfilled'
        && youtubeResult.value
        ? true
        : null,
      podcastAddict: podcastAddictLink
    }

    const resolvedSpotifyUrl = links.spotify || cachedEpisodeLinks?.spotify_url || null
    let spotifyVideoAvailable = (
      resolvedSpotifyUrl === cachedEpisodeLinks?.spotify_url
      && typeof cachedEpisodeLinks?.spotify_video_available === 'boolean'
    )
      ? cachedEpisodeLinks.spotify_video_available
      : null

    if (resolvedSpotifyUrl && spotifyVideoAvailable == null) {
      try {
        spotifyVideoAvailable = await spotifyVideoInspector(resolvedSpotifyUrl)
      } catch {
        spotifyVideoAvailable = null
      }
    }

    links.spotifyVideoAvailable = spotifyVideoAvailable
    
    console.log(`[Worker ${job.id}] Resolved:`, links)
    
    // Phase 5: Sauvegarder en BDD (réutilise pool Fastify pour éviter too many connections)
    try {
      const client = await fastify.pg.connect()
      
      try {
        // Phase 3.1: Cleanup - SELECT ancienne OG Image si existe, puis DELETE de S3
        if (ogImageUrl) { // Si on a généré une nouvelle OG Image
          const existingResult = await client.query(
            'SELECT og_image_s3_key FROM episode_links WHERE season = $1 AND episode = $2',
            [season, episode]
          );
          
          if (existingResult.rows.length > 0 && existingResult.rows[0].og_image_s3_key) {
            const oldKey = existingResult.rows[0].og_image_s3_key;
            // Ne pas delete si c'est la même clé (idempotence)
            if (oldKey !== ogImageS3Key) {
              console.log(`[Worker ${job.id}] Deleting old OG Image: ${oldKey}`);
              await deleteFromS3(oldKey);
            }
          }
        }
        
        // Phase 3.2: Sauvegarder platform links + OG Image
        await client.query(`
          INSERT INTO episode_links (
            season, episode, 
            spotify_url, spotify_video_available, apple_url, deezer_url,
            podcast_addict_url, youtube_url, youtube_thumbnail_url,
            youtube_thumbnail_checked,
            og_image_url, og_image_s3_key, feed_last_build, generated_at,
            resolved_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
          ON CONFLICT (season, episode) 
          DO UPDATE SET
            spotify_url = COALESCE(EXCLUDED.spotify_url, episode_links.spotify_url),
            spotify_video_available = COALESCE(EXCLUDED.spotify_video_available, episode_links.spotify_video_available),
            apple_url = COALESCE(EXCLUDED.apple_url, episode_links.apple_url),
            deezer_url = COALESCE(EXCLUDED.deezer_url, episode_links.deezer_url),
            podcast_addict_url = COALESCE(EXCLUDED.podcast_addict_url, episode_links.podcast_addict_url),
            youtube_url = COALESCE(EXCLUDED.youtube_url, episode_links.youtube_url),
            youtube_thumbnail_url = COALESCE(EXCLUDED.youtube_thumbnail_url, episode_links.youtube_thumbnail_url),
            youtube_thumbnail_checked = COALESCE(EXCLUDED.youtube_thumbnail_checked, episode_links.youtube_thumbnail_checked),
            og_image_url = COALESCE(EXCLUDED.og_image_url, episode_links.og_image_url),
            og_image_s3_key = COALESCE(EXCLUDED.og_image_s3_key, episode_links.og_image_s3_key),
            feed_last_build = COALESCE(EXCLUDED.feed_last_build, episode_links.feed_last_build),
            generated_at = CASE 
              WHEN EXCLUDED.og_image_url IS NOT NULL THEN NOW() 
              ELSE episode_links.generated_at 
            END,
            resolved_at = NOW()
        `, [
          season, 
          episode, 
          links.spotify, 
          links.spotifyVideoAvailable,
          links.apple, 
          links.deezer,
          links.podcastAddict,
          links.youtube,
          links.youtubeThumbnail,
          links.youtubeThumbnailChecked,
          ogImageUrl,
          ogImageS3Key,
          feedLastBuildDate
        ])
        
        console.log(`[Worker ${job.id}] ✅ Saved to database (OG Image: ${ogImageUrl ? 'YES' : 'NO'})`)
      } finally {
        client.release()
      }
    } catch (dbError) {
      console.error(`[Worker ${job.id}] ❌ Failed to save to database:`, dbError.message)
      // Ne pas throw : le job est marqué completed même si save échoue
      // Les liens seront re-résolus au prochain appel
    }
    
    // IMPORTANT: pg-boss attend un return pour marquer le job comme completed
    return { links, ogImageUrl }
  })
}

/**
 * Démarre la queue et enregistre le worker avant de publier l'instance globale.
 * Une tentative échouée ne peut donc jamais être utilisée par send().
 */
export async function initializeEpisodeWorker(fastify, {
  queueOptions = {},
  workerOptions = {},
  op3Options = {}
} = {}) {
  let candidate = null

  try {
    candidate = await createStartedQueue(queueOptions)
    await startWorker(fastify, workerOptions, candidate)
    await registerOp3StatsQueue(candidate, fastify, op3Options)
    boss = candidate
    queueShuttingDown = false
    return candidate
  } catch (error) {
    if (boss === candidate) boss = null
    await stopCandidate(candidate)
    throw error
  }
}

// Note : Worker DOIT être idempotent (vérifier si travail déjà fait avant d'appeler APIs)
// OK de rejouer un job après expiration du slot (300s) si nécessaire
