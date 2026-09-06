import 'dotenv/config'
import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyView from "@fastify/view";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyFormbody from "@fastify/formbody";
import fastifyRateLimit from "@fastify/rate-limit";
import handlebars from "handlebars";
import pg from "pg";
import { S3Client, PutObjectCommand, DeleteObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { uploadLimiter, voteLimiter, pageLimiter, apiLimiter, newsletterLimiter, newsletterActionLimiter } from "./server/middleware/rateLimiter.js";
import { validateAudio, audioValidationMiddleware } from "./server/validators/audioValidator.js";
import { setupSecurityHeaders, setupErrorHandler } from "./server/middleware/security.js";
import newsletterRoutes from "./server/newsletter/routes.js";
import {
  fetchEpisodeFromRSS,
  fetchPublishedEpisodesFromRSS
} from "./server/services/castopodRSS.js";
import {
  getOGImageS3Key,
  isExpectedOGImageUrl
} from "./server/services/ogImageLayout.js";
import {
  getEpisodeDownloadProof,
  getEpisodeStats,
  getEpisodeStatsForGuids,
  selectPopularEpisode
} from "./server/services/op3Service.js";
import { isYouTubeEpisodeResolutionConfigured } from "./server/services/platformAPIs.js";
import { getEpisodeVideoQuality } from "./server/services/podcastVideoAvailability.js";
import {
  EpisodeQueueReason,
  initializeEpisodeWorker,
  queueEpisodeResolution,
  setEpisodeQueueShuttingDown,
  stopQueue
} from "./server/queues/episodeQueue.js";
import { createEpisodeIntentBuffer } from "./server/queues/episodeIntentBuffer.js";
import {
  createEpisodeWorkerManager,
  EpisodeWorkerState
} from "./server/queues/episodeWorkerManager.js";
import {
  createDatabaseAvailability,
  DatabaseState,
  isDatabaseAvailabilityError,
  probeDatabaseState
} from "./server/resilience/databaseAvailability.js";
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

function createPostgresAdapter(options) {
  const pool = new Pool(options);
  return {
    connect: pool.connect.bind(pool),
    query: pool.query.bind(pool),
    pool,
    close: pool.end.bind(pool)
  };
}

export function getHealthPayload(
  workerManager,
  databaseConfigured,
  databaseAvailability,
  episodeIntentBuffer
) {
  const episodeWorker = workerManager?.getStatus() || {
    state: EpisodeWorkerState.STOPPED
  };
  const databaseState = databaseAvailability?.getState()
    || workerManager?.getDatabaseState()
    || (databaseConfigured ? DatabaseState.UNKNOWN : DatabaseState.UNAVAILABLE);
  const mode = databaseState === DatabaseState.READ_WRITE
    && episodeWorker.state === EpisodeWorkerState.READY
    ? 'normal'
    : 'degraded';

  return {
    ok: true,
    mode,
    database: {
      state: databaseState
    },
    episodeWorker: {
      state: episodeWorker.state
    },
    episodeIntents: {
      pending: episodeIntentBuffer?.size() || 0
    }
  };
}

function getEpisodeVideoAvailability(episodeData, platformLinks) {
  const hostedVideo = Boolean(episodeData?.hasVideo);
  const platforms = [];
  const spotifyVideoAvailable = Boolean(
    platformLinks?.spotify_url
    && platformLinks.spotify_video_available === true
  );
  const youtubeVideoAvailable = Boolean(platformLinks?.youtube_url);
  const spotifyQuality = spotifyVideoAvailable
    ? getEpisodeVideoQuality(episodeData?.season, episodeData?.episode, 'spotify')
    : null;
  const youtubeQuality = youtubeVideoAvailable
    ? getEpisodeVideoQuality(episodeData?.season, episodeData?.episode, 'youtube')
    : null;

  if (hostedVideo && episodeData.episodeLink) platforms.push('Site officiel');
  if (hostedVideo && episodeData.videoFormats?.hls && platformLinks?.apple_url) {
    platforms.push('Apple Podcasts');
  }
  if (spotifyVideoAvailable) {
    platforms.push(spotifyQuality ? `Spotify (${spotifyQuality})` : 'Spotify');
  }
  if (youtubeVideoAvailable) {
    platforms.push(youtubeQuality ? `YouTube (${youtubeQuality})` : 'YouTube');
  }

  return platforms.length > 0
    ? {
        platformsText: platforms.join(' · '),
        spotifyBadgeText: spotifyVideoAvailable
          ? `Vidéo${spotifyQuality ? ` ${spotifyQuality}` : ''}`
          : null,
        youtubeBadgeText: youtubeVideoAvailable
          ? `Vidéo${youtubeQuality ? ` ${youtubeQuality}` : ''}`
          : null
      }
    : null;
}

/**
 * Builds and configures the Fastify application instance.
 * 
 * This function is exported for testing purposes - it allows tests to import
 * and run the real server code without starting the HTTP listener.
 * 
 * @param {object} options - Startup overrides used by isolated tests
 * @returns {Promise<FastifyInstance>} Configured Fastify app ready to listen
 */
export async function buildApp({
  initializeStorage = true,
  databaseAdapterFactory = createPostgresAdapter,
  databaseUrl: databaseUrlOverride,
  databaseConfigured: databaseConfiguredOverride,
  databaseAdapter: databaseAdapterOverride,
  databaseAvailability: databaseAvailabilityOverride,
  episodeFetcher = fetchEpisodeFromRSS,
  podcastEpisodesFetcher = fetchPublishedEpisodesFromRSS,
  op3EpisodeStatsReader = getEpisodeStats,
  op3StatsListReader = getEpisodeStatsForGuids,
  op3PublicStatsEnabled = process.env.OP3_PUBLIC_STATS_ENABLED === 'true',
  youtubeChannelUrl = process.env.YOUTUBE_CHANNEL_URL || null,
  youtubeEpisodeResolutionEnabled = isYouTubeEpisodeResolutionConfigured(),
  now = () => new Date(),
  episodeQueuer = queueEpisodeResolution,
  episodeIntentBuffer: episodeIntentBufferOverride,
  episodeWorkerStarter,
  episodeWorkerStopper,
  workerManagerOptions = {},
  storageClient: storageClientOverride,
  audioValidator = validateAudio
} = {}) {
const app = Fastify({ logger: true });
let episodeWorkerManager = null;

// S3/Cellar configuration with performance optimizations
const s3Config = {
  endpoint: process.env.CELLAR_ADDON_HOST 
    ? `https://${process.env.CELLAR_ADDON_HOST}` 
    : process.env.S3_ENDPOINT || 'http://localhost:9000',
  credentials: {
    accessKeyId: process.env.CELLAR_ADDON_KEY_ID || process.env.S3_ACCESS_KEY || 'salete',
    secretAccessKey: process.env.CELLAR_ADDON_KEY_SECRET || process.env.S3_SECRET_KEY || 'salete123',
  },
  region: 'us-east-1', // Région par défaut pour Cellar
  forcePathStyle: true, // Important pour MinIO/Cellar
  // Performance optimizations for MinIO
  maxAttempts: 2, // Reduce retry attempts
  requestTimeout: 8000, // 8 second timeout
  connectTimeout: 3000, // 3 second connection timeout
  // Force signature v4 for MinIO compatibility
  signatureVersion: 'v4'
};

const s3Client = storageClientOverride || new S3Client(s3Config);
const bucketName = process.env.S3_BUCKET || 'salete-media';
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.CELLAR_ADDON_HOST;

// Ensure bucket exists
async function ensureBucketExists() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    if (!isProduction) {
      console.log(`✅ Bucket ${bucketName} already exists`);
    }
  } catch (error) {
    if (error.name === 'NotFound') {
      try {
        await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
        if (!isProduction) {
          console.log(`✅ Bucket ${bucketName} created successfully`);
        }
      } catch (createError) {
        console.error(`❌ Failed to create bucket ${bucketName}:`, createError);
      }
    } else {
      console.error(`❌ Error checking bucket ${bucketName}:`, error);
    }
  }
}

// Initialize bucket and public policy for audio folder
if (initializeStorage) {
  await ensureBucketExists();
}

// Configure public read policy for /audio/ and /og-images/ folders in development
async function ensurePublicAudioPolicy() {
  if (isProduction) return; // Don't modify production policies
  
  try {
    const { PutBucketPolicyCommand } = await import('@aws-sdk/client-s3');
    
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: [
          `arn:aws:s3:::${bucketName}/audio/*`,
          `arn:aws:s3:::${bucketName}/og-images/*`
        ]
      }]
    };

    await s3Client.send(new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy)
    }));

    console.log(`✅ Public read policy set for ${bucketName}/audio/ and ${bucketName}/og-images/`);
  } catch (error) {
    console.warn(`⚠️ Could not set public policy (normal in dev):`, error.message);
  }
}

if (initializeStorage) {
  await ensurePublicAudioPolicy();
}

// Phase 3: Logs détaillés uniquement en dev
if (!isProduction) {
  console.log('🪣 S3/Cellar Configuration:');
  console.log('  Endpoint:', s3Config.endpoint);
  console.log('  Bucket:', bucketName);
  console.log('  Production mode:', isProduction);
}

// Database
const databaseUrl = databaseUrlOverride
  || process.env.DATABASE_URL
  || process.env.POSTGRESQL_ADDON_URI
  || 'postgresql://salete:salete@localhost:5432/salete';
const hasDatabase = databaseConfiguredOverride
  ?? !!(process.env.DATABASE_URL || process.env.POSTGRESQL_ADDON_URI);

if (!isProduction) {
  console.log('🔗 Database configuration:', hasDatabase
    ? 'environment connection configured'
    : 'local fallback configured');
}

let database = databaseAdapterOverride || null;
let ownsDatabaseAdapter = false;

if (!database) {
  try {
    database = databaseAdapterFactory({
      connectionString: databaseUrl,
      max: 1, // Une seule connexion suffit (pas de requêtes longues)
      connectionTimeoutMillis: 1500,
      query_timeout: 2000
    });
    ownsDatabaseAdapter = true;
    console.log('✅ Database pool registered');
  } catch (error) {
    console.error(
      '❌ Database pool registration failed:',
      error?.code || error?.name || 'UNKNOWN'
    );

    if (isProduction) {
      console.warn('⚠️  Running without database adapter in production mode');
    } else {
      throw error;
    }
  }
}

if (ownsDatabaseAdapter) {
  app.addHook('onClose', async () => {
    await database.close();
  });
}
if (database) {
  app.decorate('pg', database);
}

const databaseAvailability = databaseAvailabilityOverride || createDatabaseAvailability({
  probe: () => database
    ? probeDatabaseState(database)
    : DatabaseState.UNAVAILABLE,
  logger: app.log,
  initialState: hasDatabase ? DatabaseState.UNKNOWN : DatabaseState.UNAVAILABLE
});
const episodeIntentBuffer = episodeIntentBufferOverride || createEpisodeIntentBuffer({
  logger: app.log
});

app.decorate('databaseAvailability', databaseAvailability);
app.decorate('episodeIntentBuffer', episodeIntentBuffer);

// Multipart forms
await app.register(fastifyMultipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  }
});

// Form body parser (for application/x-www-form-urlencoded)
await app.register(fastifyFormbody);

// Rate limiting
await app.register(fastifyRateLimit, {
  global: false, // Pas de limite globale, on configure par route
});

// Phase 3: Configuration de sécurité
setupSecurityHeaders(app);
setupErrorHandler(app);

// Custom 404 handler
app.setNotFoundHandler((request, reply) => {
  reply.status(404).send({
    success: false,
    message: 'Page non trouvée'
  });
});

// Register Handlebars helpers
handlebars.registerHelper('eq', function(a, b) {
  return a === b;
});

// Register Handlebars partials manually
const headerPartial = fs.readFileSync(
  path.join(__dirname, "server/views/partials/header.hbs"),
  "utf-8"
);
handlebars.registerPartial('header', headerPartial);

// Views (Handlebars)
await app.register(fastifyView, {
  engine: { handlebars },
  root: path.join(__dirname, "server/views")
});

// Static files (CSS, JS, images)
app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/"
});

// Audio files (only in development - in production they're served from S3)
if (!isProduction) {
  app.register(fastifyStatic, {
    root: path.join(__dirname, "uploads"),
    prefix: "/audio/",
    decorateReply: false
  });
}

// Newsletter Routes
await app.register(newsletterRoutes, { prefix: '/newsletter' });

function reportDatabaseError(error, route) {
  if (!isDatabaseAvailabilityError(error)) return false;

  databaseAvailability.recordError(error, route);
  episodeWorkerManager?.reportDatabaseError(error);
  return true;
}

async function getFreshDatabaseState(options) {
  return databaseAvailability.check(options).catch((error) => {
    reportDatabaseError(error, 'database_probe');
    return databaseAvailability.getState();
  });
}

function canReadDatabase(state) {
  return state === DatabaseState.READ_ONLY || state === DatabaseState.READ_WRITE;
}

function sendDatabaseUnavailable(reply) {
  reply.header('Retry-After', '60');
  return reply.code(503).send({
    success: false,
    code: 'SERVICE_TEMPORARILY_UNAVAILABLE',
    retryable: true,
    message: 'Le Sale-wall est temporairement indisponible. Réessaie dans quelques minutes.'
  });
}

async function ensureWritableDatabase(route) {
  const state = await getFreshDatabaseState();
  if (state === DatabaseState.READ_WRITE) return true;

  app.log.warn({
    event: 'wall_write_rejected',
    route,
    databaseState: state
  }, 'wall_write_rejected');
  return false;
}

async function enqueueEpisodeIntent(intent) {
  const result = await episodeQueuer(
    intent.season,
    intent.episode,
    intent.episodeDate,
    intent.title,
    intent.imageUrl,
    intent.feedLastBuildDate,
    intent.audioUrl
  );

  if (result.reason === EpisodeQueueReason.QUEUE_ERROR && result.error) {
    reportDatabaseError(result.error, 'episode_queue_send');
  }

  return result;
}

// API Routes
// Create new post (avec rate limiting)
app.post("/api/posts", {
  config: {
    rateLimit: uploadLimiter
  }
}, async (req, reply) => {
  if (!await ensureWritableDatabase('create_post')) {
    return sendDatabaseUnavailable(reply);
  }

  let uploadedS3Key = null;

  if (!isProduction) {
    console.log('📥 POST /api/posts - Starting request processing');
  }
  
  try {
    if (!isProduction) {
      console.log('📋 Parsing multipart form data...');
    }
    
    const parts = req.parts();
    const data = {};
    let audioFile = null;
    
    try {
      if (!isProduction) {
        console.log('⏳ Starting multipart parsing...');
      }
      
      let partCount = 0;
      const maxParts = 10; // Safety limit
      
      for await (const part of parts) {
        partCount++;
        
        if (!isProduction) {
          console.log(`🔍 Processing part ${partCount}:`, part.fieldname, 'type:', part.type);
        }
        
        if (part.type === 'file') {
          // Handle audio file
          if (part.fieldname === 'audio') {
            if (!isProduction) {
              console.log('🎵 Audio file found:', part.filename, 'mimetype:', part.mimetype);
            }
            // Convert to buffer immediately to consume the stream and allow parsing to continue
            if (!isProduction) {
              console.log('🔄 Converting audio to buffer to consume stream...');
            }
            const audioBuffer = await part.toBuffer();
            // Store both the buffer and metadata
            audioFile = {
              buffer: audioBuffer,
              filename: part.filename,
              mimetype: part.mimetype
            };
            if (!isProduction) {
              console.log('✅ Audio stream consumed, buffer size:', audioBuffer.length);
            }
          }
        } else {
          // Handle text fields
          data[part.fieldname] = part.value;
          if (!isProduction) {
            console.log(`📝 Form field ${part.fieldname}:`, part.value);
          }
        }
        
        if (!isProduction) {
          console.log('✅ Part processed:', part.fieldname);
          console.log('📊 Current data so far:', Object.keys(data));
        }
        
        // Safety break to avoid infinite loops
        if (partCount >= maxParts) {
          if (!isProduction) {
            console.log('⚠️ Reached maximum parts limit, breaking');
          }
          break;
        }
      }
      
      if (!isProduction) {
        console.log('🎊 Finished processing multipart data');
        console.log('📋 Final data fields:', Object.keys(data));
        console.log('📋 Final data values:', data);
        console.log('📁 Audio file present:', !!audioFile);
      }
    } catch (parsingError) {
      if (!isProduction) {
        console.error('❌ Error during multipart parsing:', parsingError);
        console.error('  Error message:', parsingError.message);
        console.error('  Error stack:', parsingError.stack);
      }
      throw parsingError;
    }
    
    if (!isProduction) {
      console.log('✅ Form parsing completed');
    }
    
    // Validate required fields
    if (!isProduction) {
      console.log('🔍 Validating required fields...');
    }
    
    if (!data.title || !data.transcription || !data.badge || !audioFile) {
      if (!isProduction) {
        console.log('❌ Missing fields:', { 
          title: !!data.title, 
          transcription: !!data.transcription, 
          badge: !!data.badge, 
          audioFile: !!audioFile 
        });
      }
      return reply.code(400).send({
        success: false,
        message: 'Informations manquantes'
      });
    }
    
    if (!isProduction) {
      console.log('✅ All required fields present');
    }
    
    // Validate badge value
    if (!['wafer', 'charbon'].includes(data.badge)) {
      return reply.code(400).send({
        success: false,
        message: 'Données invalides'
      });
    }
    
    // Generate unique filename
    if (!isProduction) {
      console.log('🏷️ Generating filename...');
    }
    
    const timestamp = Date.now();
    const filename = `audio_${timestamp}.webm`;
    
    if (!isProduction) {
      console.log('📁 Generated filename:', filename);
    }
    
    const buffer = audioFile.buffer;
    
    if (!isProduction) {
      console.log('✅ Using pre-converted buffer, size:', buffer.length, 'bytes');
    }
    
    // Phase 2: Validate audio with new validator
    if (!isProduction) {
      console.log('🎧 Starting audio validation...');
    }
    
    const recordingDuration = data.duration ? parseInt(data.duration) : null;
    
    if (!isProduction) {
      console.log('⏱️ Recording duration from form:', recordingDuration);
    }
    
    const validation = audioValidator(buffer, audioFile.mimetype, recordingDuration);
    
    if (!validation.isValid) {
      if (!isProduction) {
        console.log('❌ Audio validation failed:', validation);
      }
      return reply.code(400).send({
        success: false,
        message: 'Enregistrement audio invalide'
      });
    }
    
    // Phase 3: Supprimer les logs détaillés en production
    if (!isProduction) {
      console.log(`✅ Audio validation passed: ${validation.validatedData.duration}ms, ${validation.validatedData.size} bytes`);
    }
    
    let audioUrl = null;
    
    // Always use MinIO/S3 storage (both dev and production)
    if (!isProduction) {
      console.log('🚀 Starting MinIO upload process...');
    }
    
    try {
      const s3Key = `audio/${filename}`;
      
      if (!isProduction) {
        console.log('🔄 Starting MinIO upload...');
        console.log('  S3 Key:', s3Key);
        console.log('  Buffer size:', buffer.length);
        console.log('  Endpoint:', s3Config.endpoint);
        console.log('  Bucket:', bucketName);
        console.log('📦 Creating PutObjectCommand...');
      }
      
      const uploadCommand = new PutObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
        Body: buffer,
        ContentType: 'audio/webm'
        // Removed ACL for better performance and MinIO compatibility
      });
      
      if (!isProduction) {
        console.log('✅ PutObjectCommand created successfully');
        console.log('⏳ Sending command to S3 client...');
      }
      
      // Performance optimization: upload with timeout
      const uploadPromise = s3Client.send(uploadCommand);
      let uploadTimeout;
      const timeoutPromise = new Promise((_, reject) => {
        uploadTimeout = setTimeout(() => reject(new Error('Upload timeout')), 10000);
      });
      
      if (!isProduction) {
        console.log('🔄 Waiting for upload or timeout (10s)...');
      }
      
      try {
        await Promise.race([uploadPromise, timeoutPromise]);
      } finally {
        clearTimeout(uploadTimeout);
      }
      uploadedS3Key = s3Key;
      
      if (!isProduction) {
        console.log('🎉 Upload completed successfully!');
      }
      
      // Generate public URL for MinIO
      if (!isProduction) {
        console.log('🔗 Generating public URL...');
      }
      
      if (isProduction) {
        audioUrl = `${s3Config.endpoint}/${bucketName}/${s3Key}`;
      } else {
        // In development, use localhost MinIO URL
        audioUrl = `http://localhost:9000/${bucketName}/${s3Key}`;
      }
      
      if (!isProduction) {
        console.log('✅ Audio uploaded to MinIO:', audioUrl);
      }
      
    } catch (s3Error) {
      console.error('❌ MinIO upload failed:', s3Error);
      if (!isProduction) {
        console.error('  Error details:', s3Error.message);
        console.error('  Error name:', s3Error.name);
        console.error('  Error code:', s3Error.code);
        console.error('  Error stack:', s3Error.stack);
        console.error('  Full error object:', JSON.stringify(s3Error, null, 2));
      }
      return reply.code(500).send({
        success: false,
        message: 'Erreur lors de l\'upload vers MinIO'
      });
    }
    
    // Save to database
    if (!isProduction) {
      console.log('💾 Starting database save...');
    }
    const client = await database.connect();
    try {
      if (!isProduction) {
        console.log('📝 Inserting post into database...');
      }
      
      const result = await client.query(
        `INSERT INTO posts (title, transcription, badge, audio_filename, audio_url, duration_seconds, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
         RETURNING id, created_at`,
        [data.title, data.transcription, data.badge, filename, audioUrl, Math.floor(validation.validatedData.duration / 1000)]
      );
      
      if (!isProduction) {
        console.log('✅ Post saved to database with ID:', result.rows[0].id);
      }
      
      reply.send({
        success: true,
        message: 'Post créé avec succès',
        data: {
          id: result.rows[0].id,
          created_at: result.rows[0].created_at
        }
      });
      
      if (!isProduction) {
        console.log('🎉 POST /api/posts completed successfully!');
      }
    } finally {
      client.release();
    }
    
  } catch (error) {
    if (reportDatabaseError(error, 'create_post')) {
      if (uploadedS3Key) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: uploadedS3Key
          }));
        } catch (cleanupError) {
          app.log.warn({
            event: 'wall_upload_compensation_failed',
            errorCode: cleanupError?.code || cleanupError?.name || 'UNKNOWN'
          }, 'wall_upload_compensation_failed');
        }
      }
      return sendDatabaseUnavailable(reply);
    }

    app.log.error({
      event: 'wall_post_failed',
      errorCode: error?.code || error?.name || 'UNKNOWN'
    }, 'wall_post_failed');
    return reply.code(500).send({
      success: false,
      message: 'Erreur serveur lors de la création du post'
    });
  }
});

// Vote for a post (avec rate limiting)
app.post("/api/posts/:id/vote", {
  config: {
    rateLimit: voteLimiter
  }
}, async (req, reply) => {
  if (!await ensureWritableDatabase('vote')) {
    return sendDatabaseUnavailable(reply);
  }

  try {
    const postId = req.params.id;
    const voterHash = req.headers['x-forwarded-for'] || req.ip || 'anonymous';
    
    const client = await database.connect();
    try {
      // Check if user already voted
      const existingVote = await client.query(
        'SELECT id FROM votes WHERE post_id = $1 AND voter_hash = $2',
        [postId, voterHash]
      );
      
      if (existingVote.rows.length > 0) {
        return reply.code(400).send({
          success: false,
          message: 'Déjà voté'
        });
      }
      
      // Add vote
      await client.query(
        'INSERT INTO votes (post_id, voter_hash, created_at) VALUES ($1, $2, NOW())',
        [postId, voterHash]
      );
      
      // Get updated vote count
      const voteResult = await client.query(
        'SELECT COUNT(*) as vote_count FROM votes WHERE post_id = $1',
        [postId]
      );
      
      reply.send({
        success: true,
        message: 'Vote ajouté',
        data: {
          votes: parseInt(voteResult.rows[0].vote_count)
        }
      });
    } finally {
      client.release();
    }
    
  } catch (error) {
    if (reportDatabaseError(error, 'vote')) {
      return sendDatabaseUnavailable(reply);
    }
    throw error;
  }
});

// Route landing homepage (PRD v3.1)
app.get("/", {
  config: {
    rateLimit: pageLimiter
  }
}, async (req, reply) => {
  return reply.view("landing.hbs", { 
    title: "Saleté Sincère"
  });
});

// Route Sale-wall (ancien home)
app.get("/wall", {
  config: {
    rateLimit: pageLimiter
  }
}, async (req, reply) => {
  const databaseState = await getFreshDatabaseState();
  if (databaseState !== DatabaseState.READ_WRITE) {
    return reply.view("index.hbs", {
      title: "Sale-wall",
      isPodcastBanner: true,
      wallUnavailable: true
    });
  }

  try {
    const client = await database.connect();
    try {
      // Get posts with vote counts
      const result = await client.query(`
        SELECT 
          p.id,
          p.title,
          p.transcription,
          p.badge,
          p.audio_filename,
          p.audio_url,
          p.duration_seconds,
          p.created_at,
          COALESCE(v.vote_count, 0) as votes,
          EXTRACT(EPOCH FROM (NOW() - p.created_at)) as age_seconds
        FROM posts p
        LEFT JOIN (
          SELECT post_id, COUNT(*) as vote_count
          FROM votes
          GROUP BY post_id
        ) v ON p.id = v.post_id
        WHERE p.status = 'published'
        ORDER BY p.created_at DESC
        LIMIT 20
      `);
      
      const posts = result.rows.map(post => ({
        ...post,
        // Use real duration from database
        duration: formatDuration(post.duration_seconds),
        // Format creation time
        timeAgo: formatTimeAgo(post.age_seconds)
      }));
      
      // Calculate total stats
      const statsResult = await client.query(`
        SELECT 
          COUNT(*) as total_posts,
          SUM(COALESCE(v.vote_count, 0)) as total_listens
        FROM posts p
        LEFT JOIN (
          SELECT post_id, COUNT(*) as vote_count
          FROM votes
          GROUP BY post_id
        ) v ON p.id = v.post_id
        WHERE p.status = 'published'
      `);
      
      const stats = statsResult.rows[0];
      
      return reply.view("index.hbs", { 
        title: "Sale-wall",
        isPodcastBanner: true,
        posts,
        stats: {
          total_posts: stats.total_posts || 0,
          total_listens: stats.total_listens || 0
        }
      });
      
    } finally {
      client.release();
    }
  } catch (error) {
    if (reportDatabaseError(error, 'wall_read')) {
      return reply.view("index.hbs", {
        title: "Sale-wall",
        isPodcastBanner: true,
        wallUnavailable: true
      });
    }
    throw error;
  }
});

// Helper function to format time ago
function formatTimeAgo(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `il y a ${days} jour${days > 1 ? 's' : ''}`;
  if (hours > 0) return `il y a ${hours} heure${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `il y a ${minutes} minute${minutes > 1 ? 's' : ''}`;
  return 'à l\'instant';
}

// Helper function to format duration
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Route podcast générale (liens show)
app.get("/podcast/", {
  config: {
    rateLimit: pageLimiter
  }
}, async (req, reply) => {
  const { season, episode, ...otherQuery } = req.query;
  const remainingQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(otherQuery)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) remainingQuery.append(key, String(item));
    }
  }
  const suffix = remainingQuery.size > 0 ? `?${remainingQuery}` : '';
  if (season && episode) {
    return reply.code(301).redirect(
      `/podcast/${encodeURIComponent(season)}/${encodeURIComponent(episode)}${suffix}`
    );
  }

  const originalQuery = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) originalQuery.append(key, String(item));
    }
  }
  return reply.code(301).redirect(
    originalQuery.size > 0 ? `/podcast?${originalQuery}` : '/podcast'
  );
});

app.get("/podcast", {
  config: {
    rateLimit: pageLimiter
  }
}, async (req, reply) => {
  // Redirect old query params to new path-based route
  const { season, episode } = req.query;
  if (season && episode) {
    return reply.code(301).redirect(`/podcast/${season}/${episode}`);
  }
  
  let episodes = [];
  let latestImageNeedsRegeneration = false;
  let latestEpisode = null;
  let popularEpisode = null;
  let databaseState = databaseAvailability.getState();

  try {
    const publishedEpisodes = await podcastEpisodesFetcher(5000);
    episodes = Array.isArray(publishedEpisodes) ? publishedEpisodes : [];
    latestEpisode = episodes[0] || null;
  } catch (error) {
    app.log.warn({
      event: 'podcast_latest_episode_unavailable',
      errorCode: error?.code || error?.name || 'UNKNOWN'
    }, 'podcast_latest_episode_unavailable');
  }

  let podcastSocialImage = latestEpisode?.image
    ? {
        url: latestEpisode.image,
        alt: `Jaquette de l'épisode ${latestEpisode.title}`
      }
    : null;

  if (latestEpisode && database && canReadDatabase(databaseState)) {
    try {
      const imageResult = await database.pool.query(
        `SELECT og_image_url
         FROM episode_links
         WHERE season = $1 AND episode = $2`,
        [latestEpisode.season, latestEpisode.episode]
      );
      const generatedImageUrl = imageResult.rows[0]?.og_image_url;
      const expectedOgImageS3Key = getOGImageS3Key({
        season: latestEpisode.season,
        episode: latestEpisode.episode,
        imageUrl: latestEpisode.image,
        feedLastBuildDate: latestEpisode.feedLastBuildDate
      });
      latestImageNeedsRegeneration = !isExpectedOGImageUrl(generatedImageUrl, expectedOgImageS3Key);
      if (generatedImageUrl) {
        podcastSocialImage = {
          url: generatedImageUrl,
          alt: `Jaquette de l'épisode ${latestEpisode.title}`,
          width: 1200,
          height: 630
        };
      }
    } catch (error) {
      if (reportDatabaseError(error, 'podcast_latest_episode_image')) {
        databaseState = databaseAvailability.getState();
      } else {
        app.log.warn({
          event: 'podcast_latest_episode_image_unavailable',
          errorCode: error?.code || error?.name || 'UNKNOWN'
        }, 'podcast_latest_episode_image_unavailable');
      }
    }
  }

  if (latestEpisode && latestImageNeedsRegeneration) {
    const intent = {
      season: latestEpisode.season,
      episode: latestEpisode.episode,
      episodeDate: latestEpisode.rawPubDate,
      title: latestEpisode.title,
      imageUrl: latestEpisode.image,
      feedLastBuildDate: latestEpisode.feedLastBuildDate,
      audioUrl: latestEpisode.audioUrl
    };
    const workerReady = episodeWorkerManager?.getStatus().state === EpisodeWorkerState.READY;
    const queueResult = workerReady
      ? await enqueueEpisodeIntent(intent)
      : { queued: false, reason: EpisodeQueueReason.WORKER_UNAVAILABLE };

    if (!queueResult.queued && queueResult.reason !== EpisodeQueueReason.ALREADY_QUEUED) {
      episodeIntentBuffer.remember(intent);
    }
  }

  if (
    op3PublicStatsEnabled
    && database
    && canReadDatabase(databaseState)
    && episodes.length > 0
  ) {
    try {
      const itemGuids = episodes.map(({ itemGuid }) => itemGuid).filter(Boolean);
      const stats = await op3StatsListReader(database.pool, itemGuids);
      popularEpisode = selectPopularEpisode({ episodes, stats, now: now() });
    } catch (error) {
      if (!reportDatabaseError(error, 'podcast_traction_cache')) {
        app.log.warn({
          event: 'podcast_traction_unavailable',
          errorCode: error?.code || error?.name || 'UNKNOWN'
        }, 'podcast_traction_unavailable');
      }
    }
  }

  reply.header('Cache-Control', 'public, max-age=3600');
  return reply.view("podcast.hbs", {
    episodeData: null,
    popularEpisode,
    podcastSocialImage,
    youtubeUrl: youtubeChannelUrl
  });
});

/**
 * Vérifie si l'OG Image doit être régénérée (ADR-0012)
 * 
 * @param {string|null} ogImageUrl - URL actuelle de l'OG Image
 * @param {string|null} cachedFeedLastBuild - feed_last_build en BDD
 * @param {string|null} generatedAt - Timestamp génération OG Image
 * @param {string|Date} rssFeedLastBuildDate - lastBuildDate du RSS
 * @param {string} expectedS3Key - Clé correspondant aux données et au layout actuels
 * @returns {boolean} true si OG Image doit être régénérée
 */
function checkOGImageNeeds(ogImageUrl, cachedFeedLastBuild, generatedAt, rssFeedLastBuildDate, expectedS3Key) {
  // Condition 1: Pas d'OG Image → doit générer
  if (!ogImageUrl) return true;
  
  // Condition 2: La clé ne correspond plus aux données ou au layout actuels
  if (!isExpectedOGImageUrl(ogImageUrl, expectedS3Key)) return true;

  // Condition 3: RSS lastBuildDate a changé → doit régénérer
  if (cachedFeedLastBuild && rssFeedLastBuildDate) {
    const cachedDate = new Date(cachedFeedLastBuild);
    const rssDate = new Date(rssFeedLastBuildDate);
    
    if (rssDate > cachedDate) {
      return true; // RSS plus récent que cache
    }
  }
  
  // Condition 4: OG Image > 7 jours (fallback staleness)
  if (generatedAt) {
    const daysSinceGeneration = (Date.now() - new Date(generatedAt)) / (1000 * 60 * 60 * 24);
    if (daysSinceGeneration > 7) {
      return true; // Image trop ancienne
    }
  }
  
  // Sinon, OG Image up-to-date
  return false;
}

app.get('/podcast/:season/:episode/', {
  config: {
    rateLimit: pageLimiter
  }
}, async (req, reply) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) query.append(key, String(item));
    }
  }
  const suffix = query.size > 0 ? `?${query}` : '';
  return reply.code(301).redirect(
    `/podcast/${encodeURIComponent(req.params.season)}/${encodeURIComponent(req.params.episode)}${suffix}`
  );
});

// Route smartlink multiplateforme /podcast/:season/:episode (ADR-0011)
app.get("/podcast/:season/:episode", {
  config: {
    rateLimit: pageLimiter
  }
}, async (req, reply) => {
  const season = parseInt(req.params.season, 10);
  const episode = parseInt(req.params.episode, 10);
  
  // Validation (episode=0 autorisé pour trailers sans numéro)
  if (isNaN(season) || isNaN(episode) || season < 1 || episode < 0) {
    return reply.redirect('/podcast');
  }
  
  // 1. Fetch episode metadata from RSS
  const episodeData = await episodeFetcher(season, episode, 5000).catch(() => null);
  
  if (!episodeData) {
    return reply.redirect('/podcast'); // Épisode introuvable
  }
  
  // 2. Check cache BDD (episode_links) pour liens plateformes + OG Image.
  // Le probe est borné par la configuration du pool et distingue read-only/read-write.
  let databaseState = await getFreshDatabaseState();
  let platformLinks = null;
  let shouldQueueJob = true;

  if (canReadDatabase(databaseState)) {
    let client = null;
    try {
      client = await database.connect();
      const cacheResult = await client.query(
        `SELECT spotify_url, spotify_video_available, apple_url, deezer_url,
                podcast_addict_url, youtube_url, youtube_thumbnail_url,
                youtube_thumbnail_checked,
                og_image_url, feed_last_build, generated_at
         FROM episode_links WHERE season = $1 AND episode = $2`,
        [season, episode]
      );

      if (cacheResult.rows.length > 0) {
        const expectedOgImageS3Key = getOGImageS3Key({
          season,
          episode,
          imageUrl: episodeData.image,
          feedLastBuildDate: episodeData.feedLastBuildDate
        });
        platformLinks = cacheResult.rows[0];
        const needsOGRegeneration = checkOGImageNeeds(
          platformLinks.og_image_url,
          platformLinks.feed_last_build,
          platformLinks.generated_at,
          episodeData.feedLastBuildDate,
          expectedOgImageS3Key
        );
        shouldQueueJob = !platformLinks.spotify_url
          || platformLinks.spotify_video_available == null
          || (
            youtubeEpisodeResolutionEnabled
            && (!platformLinks.youtube_url || platformLinks.youtube_thumbnail_checked !== true)
          )
          || needsOGRegeneration;
      }
    } catch (error) {
      if (!reportDatabaseError(error, 'podcast_episode_cache')) throw error;
      databaseState = databaseAvailability.getState();
      platformLinks = null;
      shouldQueueJob = true;
    } finally {
      client?.release();
    }
  }

  // 3. Si pas en cache OU OG Image obsolète, queue job pour résolution asynchrone
  if (shouldQueueJob) {
    const intent = {
      season,
      episode,
      episodeDate: episodeData.rawPubDate,
      title: episodeData.title,
      imageUrl: episodeData.image,
      feedLastBuildDate: episodeData.feedLastBuildDate,
      audioUrl: episodeData.audioUrl
    };
    const workerReady = episodeWorkerManager?.getStatus().state === EpisodeWorkerState.READY;
    const queueResult = workerReady
      ? await enqueueEpisodeIntent(intent)
      : { queued: false, reason: EpisodeQueueReason.WORKER_UNAVAILABLE };

    if (!queueResult.queued && queueResult.reason !== EpisodeQueueReason.ALREADY_QUEUED) {
      episodeIntentBuffer.remember(intent);
    }
  }

  // 4. Fetch OP3 stats from cache (ADR-0015)
  let episodeStats = null;
  if (op3PublicStatsEnabled && canReadDatabase(databaseState) && episodeData.itemGuid) {
    try {
      const stats = await op3EpisodeStatsReader(database.pool, episodeData.itemGuid);
      episodeStats = getEpisodeDownloadProof(stats, now());
    } catch (error) {
      if (reportDatabaseError(error, 'podcast_episode_stats')) {
        databaseState = databaseAvailability.getState();
      } else {
        app.log.warn({
          event: 'op3_stats_fetch_failed',
          errorCode: error?.code || error?.name || 'UNKNOWN'
        }, 'op3_stats_fetch_failed');
      }
    }
  }

  const episodeContentPartial = !platformLinks?.spotify_url
    || platformLinks?.spotify_video_available == null
    || !platformLinks?.apple_url
    || !platformLinks?.deezer_url
    || (
      youtubeEpisodeResolutionEnabled
      && (!platformLinks?.youtube_url || platformLinks?.youtube_thumbnail_checked !== true)
    )
    || databaseState === DatabaseState.UNAVAILABLE
    || databaseState === DatabaseState.UNKNOWN;

  // 5. Render page avec données épisode + liens plateformes (ou null si pas encore résolus)
  reply.header('Cache-Control', episodeContentPartial
    ? 'public, max-age=60'
    : 'public, max-age=3600');
  reply.header('Vary', 'User-Agent'); // CDN cache per User-Agent (bots vs users)
  return reply.view("podcast.hbs", { 
    episodeData: {
      ...episodeData,
      season,
      episode
    },
    platformLinks,
    episodeVideoAvailability: getEpisodeVideoAvailability(episodeData, platformLinks),
    youtubeUrl: platformLinks?.youtube_url || null,
    ogImageUrl: platformLinks?.og_image_url || null, // Pass OG image for player cover
    episodeStats, // OP3 badge data (ADR-0015)
  });
});

// Health: liveness HTTP stays 200 even when PostgreSQL or pg-boss is unavailable.
app.decorate('episodeWorkerManager', null);
app.get("/health", () => getHealthPayload(
  episodeWorkerManager,
  hasDatabase,
  databaseAvailability,
  episodeIntentBuffer
));

// Audio Proxy for CORS (ADR-0014)
const ALLOWED_AUDIO_DOMAINS = [
  'op3.dev',
  'podcasts.saletesincere.fr',
  'media.saletesincere.fr'
];

function isAllowedAudioUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_AUDIO_DOMAINS.some(domain => 
      parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function isPrivateIP(hostname) {
  const privateRanges = [
    /^127\./,           // localhost
    /^10\./,            // private class A
    /^192\.168\./,      // private class C
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./ // private class B
  ];
  return privateRanges.some(range => range.test(hostname));
}

// OPTIONS preflight pour CORS
app.options('/api/audio/proxy', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Range, Content-Type');
  reply.code(204).send();
});

// Proxy audio avec streaming
app.get('/api/audio/proxy', {
  config: { rateLimit: apiLimiter }
}, async (request, reply) => {
  const { url } = request.query;
  
  if (!url) {
    return reply.code(400).send({ error: 'Missing url parameter' });
  }

  try {
    const decodedUrl = decodeURIComponent(url);
    
    // Validation domaine
    if (!isAllowedAudioUrl(decodedUrl)) {
      app.log.warn('❌ Audio proxy: Domain not allowed', { url: decodedUrl });
      return reply.code(403).send({ error: 'Domain not allowed' });
    }

    // Protection SSRF
    const parsed = new URL(decodedUrl);
    if (isPrivateIP(parsed.hostname)) {
      app.log.warn('❌ Audio proxy: Private IP blocked', { hostname: parsed.hostname });
      return reply.code(403).send({ error: 'Private IP not allowed' });
    }
    
    app.log.info('🔊 Audio proxy request', { url: decodedUrl });
    
    // Fetch audio depuis OP3 (suit redirects)
    const response = await fetch(decodedUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'SaleteSincere/1.0 (Audio Proxy)',
        'X-Forwarded-For': request.ip,
        'X-Real-IP': request.ip,
        'Range': request.headers.range || ''
      }
    });

    if (!response.ok) {
      app.log.error('❌ Audio proxy: Fetch failed', { 
        status: response.status, 
        statusText: response.statusText,
        url: decodedUrl 
      });
      return reply.code(response.status).send({ error: 'Failed to fetch audio' });
    }

    // Headers CORS pour Web Audio API
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Range, Content-Type');
    reply.header('Content-Type', response.headers.get('Content-Type') || 'audio/mpeg');
    reply.header('Accept-Ranges', 'bytes');

    // Support Range requests (seek audio)
    const contentLength = response.headers.get('Content-Length');
    const contentRange = response.headers.get('Content-Range');
    
    if (contentLength) {
      reply.header('Content-Length', contentLength);
    }
    
    if (contentRange) {
      reply.header('Content-Range', contentRange);
      reply.code(206); // Partial Content
    } else {
      reply.code(200);
    }

    // Stream audio (pas de buffer en mémoire)
    return reply.send(response.body);
    
  } catch (error) {
    app.log.error('❌ Audio proxy error:', error);
    return reply.code(500).send({ error: 'Proxy failed' });
  }
});

// Initialize pg-boss independently from HTTP startup.
// The manager owns the single retry loop and never publishes a partial instance.
const WORKER_ENABLED = process.env.DISABLE_WORKER !== 'true'
  && hasDatabase
  && database !== null;

if (WORKER_ENABLED) {
  const startEpisodeWorker = episodeWorkerStarter
    || (() => initializeEpisodeWorker(app));
  const stopEpisodeWorker = episodeWorkerStopper
    || ((instance) => stopQueue(instance));
  const {
    onReady: configuredOnReady,
    ...managerOptions
  } = workerManagerOptions;

  episodeWorkerManager = createEpisodeWorkerManager({
    ...managerOptions,
    start: startEpisodeWorker,
    stop: stopEpisodeWorker,
    logger: workerManagerOptions.logger || app.log,
    databaseAvailability,
    async onReady(instance) {
      await episodeIntentBuffer.drain(enqueueEpisodeIntent);
      if (typeof configuredOnReady === 'function') {
        await configuredOnReady(instance);
      }
    }
  });
  app.episodeWorkerManager = episodeWorkerManager;

  let applicationMode = null;
  const logApplicationMode = (reason) => {
    const nextMode = databaseAvailability.getState() === DatabaseState.READ_WRITE
      && episodeWorkerManager.getStatus().state === EpisodeWorkerState.READY
      ? 'normal'
      : 'degraded';
    if (nextMode === applicationMode) return;
    const previousMode = applicationMode;
    applicationMode = nextMode;
    app.log.info({
      event: 'application_mode_changed',
      previousMode,
      mode: nextMode,
      reason,
      databaseState: databaseAvailability.getState(),
      episodeWorkerState: episodeWorkerManager.getStatus().state
    }, 'application_mode_changed');
  };
  const unsubscribeDatabase = databaseAvailability.subscribe(() => {
    logApplicationMode('database_state_changed');
  });
  const unsubscribeWorker = episodeWorkerManager.subscribe(() => {
    logApplicationMode('episode_worker_state_changed');
  });
  logApplicationMode('startup');
  setEpisodeQueueShuttingDown(false);

  app.addHook('onClose', async () => {
    setEpisodeQueueShuttingDown(true);
    await episodeWorkerManager.stop();
    unsubscribeDatabase();
    unsubscribeWorker();
  });

  // Intentionally not awaited: Fastify can listen while pg-boss connects/retries.
  void episodeWorkerManager.ensureStarted();
} else {
  const reason = process.env.DISABLE_WORKER === 'true'
    ? 'DISABLE_WORKER=true'
    : !hasDatabase
      ? 'No database connection (DATABASE_URL or POSTGRESQL_ADDON_URI missing)'
      : 'Database adapter unavailable';
  console.log(`⚠️  Worker disabled (${reason})`);
  console.log('   Episode resolution jobs will remain unavailable');
}

  return app;
}

// ============================================================================
// SERVER STARTUP - Only runs when executed directly (not imported by tests)
// ============================================================================

const isMainModule = import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: process.env.PORT || 3000 });

  // Graceful shutdown pour déploiements CleverCloud
  // Libère les connexions DB rapidement quand SIGTERM reçu
  const gracefulShutdown = async (signal) => {
    console.log(`\n📡 ${signal} received, closing gracefully...`);
    
    try {
      // onClose stops the worker manager before Fastify releases its plugins.
      await app.close();
      console.log('✅ HTTP server closed');
      console.log('✅ Database connections released');
      
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
