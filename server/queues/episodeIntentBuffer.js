function isValidUrl(value) {
  if (value === null || value === undefined || value === '') return true
  if (typeof value !== 'string' || value.length > 2048) return false

  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function isValidEpisodeIntent(payload) {
  return Number.isInteger(payload?.season)
    && payload.season >= 1
    && Number.isInteger(payload.episode)
    && payload.episode >= 0
    && typeof payload.episodeDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(payload.episodeDate)
    && typeof payload.title === 'string'
    && payload.title.length > 0
    && payload.title.length <= 500
    && isValidUrl(payload.imageUrl)
    && isValidUrl(payload.audioUrl)
    && (payload.itemGuid == null
      || (typeof payload.itemGuid === 'string' && payload.itemGuid.length <= 2048))
    && (payload.feedLastBuildDate === null
      || payload.feedLastBuildDate === undefined
      || (typeof payload.feedLastBuildDate === 'string'
        && payload.feedLastBuildDate.length <= 200))
}

export function createEpisodeIntentBuffer({
  maxSize = 100,
  ttlMs = 60 * 60 * 1000,
  now = Date.now,
  logger
} = {}) {
  const intents = new Map()

  function pruneExpired() {
    const currentTime = now()
    let expired = 0
    for (const [key, intent] of intents) {
      if (intent.expiresAt <= currentTime) {
        intents.delete(key)
        expired += 1
      }
    }
    return expired
  }

  function remember(payload) {
    if (!isValidEpisodeIntent(payload)) {
      return { remembered: false, reason: 'INVALID_PAYLOAD' }
    }

    pruneExpired()
    const key = `episode-${payload.season}-${payload.episode}`
    const existed = intents.has(key)
    if (existed) {
      intents.delete(key)
    } else if (intents.size >= maxSize) {
      const oldestKey = intents.keys().next().value
      if (oldestKey) intents.delete(oldestKey)
    }
    intents.set(key, {
      key,
      payload: { ...payload },
      expiresAt: now() + ttlMs
    })

    if (typeof logger?.info === 'function') {
      logger.info({
        event: 'episode_intent_remembered',
        key,
        deduplicated: existed,
        pending: intents.size
      }, 'episode_intent_remembered')
    }

    return {
      remembered: true,
      reason: existed ? 'UPDATED' : 'STORED',
      key
    }
  }

  function entries() {
    pruneExpired()
    return Array.from(intents.values()).map((intent) => ({
      ...intent,
      payload: { ...intent.payload }
    }))
  }

  async function drain(enqueue) {
    const expired = pruneExpired()
    let drained = 0
    let failed = 0

    for (const [key, intent] of intents) {
      try {
        const result = await enqueue({ ...intent.payload })
        if (result?.queued || result?.reason === 'ALREADY_QUEUED') {
          intents.delete(key)
          drained += 1
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }

    const result = {
      drained,
      failed,
      expired,
      pending: intents.size
    }

    if (typeof logger?.info === 'function') {
      logger.info({ event: 'episode_intents_drained', ...result }, 'episode_intents_drained')
    }

    return result
  }

  return {
    drain,
    entries,
    remember,
    size() {
      pruneExpired()
      return intents.size
    }
  }
}
