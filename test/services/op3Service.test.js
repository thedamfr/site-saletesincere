import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatDownloadsForDisplay,
  getEpisodeDownloadProof,
  refreshOp3StatsCache,
  selectPopularEpisode
} from '../../server/services/op3Service.js'
import { DatabaseState } from '../../server/resilience/databaseAvailability.js'

const NOW = new Date('2026-08-20T12:00:00.000Z')

function episode(overrides = {}) {
  return {
    season: 2,
    episode: 1,
    title: 'Épisode test',
    description: 'Une description courte.',
    duration: '42:00',
    image: 'https://media.example/episode.jpg',
    itemGuid: 'guid-1',
    rawPubDate: '2026-08-01',
    ...overrides
  }
}

function stat(overrides = {}) {
  return {
    itemGuid: 'guid-1',
    downloads7: 12,
    downloads30: 20,
    downloadsAll: 40,
    fetchedAt: new Date('2026-08-20T06:00:00.000Z'),
    ...overrides
  }
}

describe('selectPopularEpisode', () => {
  test('selects the strongest rolling seven-day signal', () => {
    const episodes = [
      episode({ itemGuid: 'guid-1', episode: 1, rawPubDate: '2026-08-01' }),
      episode({ itemGuid: 'guid-2', episode: 2, rawPubDate: '2026-08-08' }),
      episode({ itemGuid: 'guid-3', episode: 3, rawPubDate: '2026-08-15' })
    ]
    const stats = [
      stat({ itemGuid: 'guid-1', downloads7: 12 }),
      stat({ itemGuid: 'guid-2', downloads7: 31, downloadsAll: 86 }),
      stat({ itemGuid: 'guid-3', downloads7: 18 })
    ]

    const selected = selectPopularEpisode({ episodes, stats, now: NOW })

    assert.equal(selected.kind, 'weekly')
    assert.equal(selected.episode.itemGuid, 'guid-2')
    assert.equal(selected.downloads, 86)
    assert.equal(selected.weeklyDownloads, 31)
    assert.equal(
      selected.displayText,
      'Déjà 86 téléchargements depuis sa sortie, mesurés par OP3'
    )
    assert.equal(selected.label, 'Le plus populaire cette semaine')
  })

  test('falls back to all-time popularity when weekly traction is below threshold', () => {
    const episodes = [
      episode({ itemGuid: 'guid-1', episode: 1 }),
      episode({ itemGuid: 'guid-2', episode: 2 }),
      episode({ itemGuid: 'guid-3', episode: 3 })
    ]
    const stats = [
      stat({ itemGuid: 'guid-1', downloads7: 9, downloadsAll: 60 }),
      stat({ itemGuid: 'guid-2', downloads7: 4, downloadsAll: 95 }),
      stat({ itemGuid: 'guid-3', downloads7: 0, downloadsAll: 70 })
    ]

    const selected = selectPopularEpisode({ episodes, stats, now: NOW })

    assert.equal(selected.kind, 'allTime')
    assert.equal(selected.episode.itemGuid, 'guid-2')
    assert.equal(selected.downloads, 95)
    assert.equal(
      selected.displayText,
      'Déjà 95 téléchargements depuis sa sortie, mesurés par OP3'
    )
    assert.equal(selected.label, "L'épisode le plus populaire")
  })

  test('breaks ties with the most recently published episode', () => {
    const episodes = [
      episode({ itemGuid: 'guid-1', episode: 1, rawPubDate: '2026-08-01' }),
      episode({ itemGuid: 'guid-2', episode: 2, rawPubDate: '2026-08-15' }),
      episode({ itemGuid: 'guid-3', episode: 3, rawPubDate: '2026-08-10' })
    ]
    const stats = episodes.map(({ itemGuid }) => stat({ itemGuid, downloads7: 20 }))

    const selected = selectPopularEpisode({ episodes, stats, now: NOW })

    assert.equal(selected.episode.itemGuid, 'guid-2')
  })

  test('hides weak social proof and requires at least three published episodes', () => {
    const twoEpisodes = [episode(), episode({ itemGuid: 'guid-2', episode: 2 })]
    const weakStats = [
      stat({ downloads7: 9, downloadsAll: 9 }),
      stat({ itemGuid: 'guid-2', downloads7: 9, downloadsAll: 9 })
    ]

    assert.equal(selectPopularEpisode({ episodes: twoEpisodes, stats: weakStats, now: NOW }), null)
    assert.equal(selectPopularEpisode({
      episodes: [...twoEpisodes, episode({ itemGuid: 'guid-3', episode: 3 })],
      stats: [...weakStats, stat({ itemGuid: 'guid-3', downloads7: 9, downloadsAll: 9 })],
      now: NOW
    }), null)
  })

  test('uses only historical proof for slightly stale snapshots and rejects older ones', () => {
    const episodes = [
      episode({ itemGuid: 'guid-1', episode: 1 }),
      episode({ itemGuid: 'guid-2', episode: 2 }),
      episode({ itemGuid: 'guid-3', episode: 3 })
    ]
    const slightlyStale = new Date('2026-08-17T12:00:00.000Z')
    const tooOld = new Date('2026-08-10T12:00:00.000Z')
    const stats = episodes.map(({ itemGuid }) => stat({
      itemGuid,
      downloads7: 50,
      downloadsAll: itemGuid === 'guid-2' ? 90 : 40,
      fetchedAt: slightlyStale
    }))

    const historical = selectPopularEpisode({ episodes, stats, now: NOW })

    assert.equal(historical.kind, 'allTime')
    assert.equal(historical.episode.itemGuid, 'guid-2')
    assert.equal(selectPopularEpisode({
      episodes,
      stats: stats.map((row) => ({ ...row, fetchedAt: tooOld })),
      now: NOW
    }), null)
  })
})

describe('formatDownloadsForDisplay', () => {
  test('uses exact download wording', () => {
    assert.equal(formatDownloadsForDisplay(42), '42 téléchargements mesurés par OP3')
    assert.equal(formatDownloadsForDisplay(1), null)
    assert.equal(formatDownloadsForDisplay(9), null)
  })
})

describe('getEpisodeDownloadProof', () => {
  test('uses fresh all-time downloads and hides weak or old snapshots', () => {
    assert.deepEqual(getEpisodeDownloadProof(stat({ downloadsAll: 42 }), NOW), {
      downloadsAll: 42,
      displayText: '42 téléchargements mesurés par OP3'
    })
    assert.equal(getEpisodeDownloadProof(stat({ downloadsAll: 9 }), NOW), null)
    assert.equal(getEpisodeDownloadProof(stat({
      downloadsAll: 42,
      fetchedAt: new Date('2026-08-10T12:00:00.000Z')
    }), NOW), null)
  })
})

function createFetchMock({ missingAllTimeMetric = false, failAggregate = false, paginated = false } = {}) {
  const showUuid = 'a'.repeat(32)
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/shows/')) {
      return Response.json({
        showUuid,
        episodes: [
          { id: 'episode-id-1', title: 'Épisode 1', pubdate: '2026-08-01T08:00:00.000Z' },
          { id: 'episode-id-2', title: 'Épisode 2', pubdate: '2026-08-10T08:00:00.000Z' }
        ]
      })
    }
    if (String(url).includes('/queries/episode-download-counts')) {
      if (failAggregate) return new Response(null, { status: 503 })
      return Response.json({
        showUuid,
        episodes: [
          {
            itemGuid: 'guid-1',
            title: 'Épisode 1',
            pubdate: '2026-08-01T08:00:00.000Z',
            downloads7: 999,
            downloads30: 999,
            ...(missingAllTimeMetric ? {} : { downloadsAll: 42 })
          },
          {
            itemGuid: 'guid-2',
            title: 'Épisode 2',
            pubdate: '2026-08-10T08:00:00.000Z',
            downloadsAll: 27
          }
        ]
      })
    }
    if (String(url).includes('/downloads/show/')) {
      if (paginated && !String(url).includes('continuationToken=')) {
        return Response.json({
          rows: [
            { episodeId: 'episode-id-1', time: '2026-08-19T10:00:00.000Z' }
          ],
          count: 1,
          continuationToken: 'next-page'
        })
      }
      return Response.json({
        rows: [
          ...(!paginated ? [{ episodeId: 'episode-id-1', time: '2026-08-19T10:00:00.000Z' }] : []),
          { episodeId: 'episode-id-1', time: '2026-08-10T10:00:00.000Z' },
          { episodeId: 'episode-id-2', time: '2026-08-18T10:00:00.000Z' }
        ],
        count: 3
      })
    }
    return new Response(null, { status: 404 })
  }
  return { fetchImpl, calls }
}

function createPool() {
  const queries = []
  let connectCalls = 0
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params })
      return { rowCount: 1, rows: [] }
    },
    release() {}
  }
  return {
    queries,
    get connectCalls() { return connectCalls },
    pool: {
      async connect() {
        connectCalls += 1
        return client
      }
    }
  }
}

describe('refreshOp3StatsCache', () => {
  for (const rollbackFails of [false, true]) {
    test(`discards a failed transaction client when rollback ${rollbackFails ? 'also fails' : 'succeeds'}`, async () => {
      const { fetchImpl } = createFetchMock()
      const failure = Object.assign(new Error('Query read timeout'), { code: 'ETIMEDOUT' })
      const rollbackFailure = new Error('Rollback could not reach PostgreSQL')
      const queries = []
      const releases = []
      let connections = 0
      const pool = { connect: async () => {
        const isFailedClient = ++connections === 1
        return {
          query: async sql => {
            queries.push(sql)
            if (isFailedClient && sql.includes('INSERT INTO op3_stats')) throw failure
            if (isFailedClient && rollbackFails && sql === 'ROLLBACK') throw rollbackFailure
            return { rows: [], rowCount: 1 }
          },
          release: error => releases.push(error)
        }
      } }
      const options = { pool, databaseState: DatabaseState.READ_WRITE,
        fetchImpl, token: 'test-token', podcastGuid: 'podcast-guid', now: NOW }

      await assert.rejects(refreshOp3StatsCache(options), error => error === failure)
      assert.equal(queries.at(-1), 'ROLLBACK')
      assert.equal(queries.includes('COMMIT'), false)
      assert.equal(releases[0], failure, 'No uncertain transaction may return to the pool')

      assert.deepEqual(await refreshOp3StatsCache(options), { status: 'updated', updatedCount: 2 })
      assert.equal(connections, 2)
      assert.equal(releases[1], undefined)
      assert.equal(queries.at(-1), 'COMMIT')
    })
  }

  test('writes rolling 7/30-day counts and all-time counts in one transaction', async () => {
    const { fetchImpl, calls } = createFetchMock()
    const database = createPool()

    const result = await refreshOp3StatsCache({
      pool: database.pool,
      databaseState: DatabaseState.READ_WRITE,
      fetchImpl,
      token: 'test-token',
      podcastGuid: 'podcast-guid',
      now: NOW
    })

    assert.deepEqual(result, { status: 'updated', updatedCount: 2 })
    assert.equal(database.connectCalls, 1)
    assert.match(database.queries[0].sql, /BEGIN/)
    assert.match(database.queries.at(-1).sql, /COMMIT/)
    const upserts = database.queries.filter(({ sql }) => sql.includes('INSERT INTO op3_stats'))
    assert.equal(upserts.length, 2)
    assert.deepEqual(upserts[0].params.slice(0, 4), ['guid-1', 1, 2, 42])
    assert.deepEqual(upserts[1].params.slice(0, 4), ['guid-2', 1, 1, 27])
    assert.equal(calls.length, 3)
    assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer test-token'))
    assert.ok(calls.every(({ url }) => !url.includes('test-token')))
    assert.match(calls.find(({ url }) => url.includes('/downloads/show/')).url, /bots=exclude/)
  })

  test('preserves the previous cache when OP3 fails', async () => {
    const { fetchImpl } = createFetchMock({ failAggregate: true })
    const database = createPool()

    await assert.rejects(() => refreshOp3StatsCache({
      pool: database.pool,
      databaseState: DatabaseState.READ_WRITE,
      fetchImpl,
      token: 'test-token',
      podcastGuid: 'podcast-guid',
      now: NOW
    }), /OP3/)

    assert.equal(database.connectCalls, 0)
    assert.equal(database.queries.length, 0)
  })

  test('follows the documented continuation token before committing a snapshot', async () => {
    const { fetchImpl, calls } = createFetchMock({ paginated: true })
    const database = createPool()

    const result = await refreshOp3StatsCache({
      pool: database.pool,
      databaseState: DatabaseState.READ_WRITE,
      fetchImpl,
      token: 'test-token',
      podcastGuid: 'podcast-guid',
      now: NOW
    })

    assert.deepEqual(result, { status: 'updated', updatedCount: 2 })
    const downloadCalls = calls.filter(({ url }) => url.includes('/downloads/show/'))
    assert.equal(downloadCalls.length, 2)
    assert.match(downloadCalls[1].url, /continuationToken=next-page/)
    const upserts = database.queries.filter(({ sql }) => sql.includes('INSERT INTO op3_stats'))
    assert.deepEqual(upserts[0].params.slice(0, 4), ['guid-1', 1, 2, 42])
  })

  test('skips an aggregate episode with missing metrics instead of writing zeros', async () => {
    const { fetchImpl } = createFetchMock({ missingAllTimeMetric: true })
    const database = createPool()

    const result = await refreshOp3StatsCache({
      pool: database.pool,
      databaseState: DatabaseState.READ_WRITE,
      fetchImpl,
      token: 'test-token',
      podcastGuid: 'podcast-guid',
      now: NOW
    })

    assert.deepEqual(result, { status: 'updated', updatedCount: 1 })
    const upserts = database.queries.filter(({ sql }) => sql.includes('INSERT INTO op3_stats'))
    assert.equal(upserts.length, 1)
    assert.deepEqual(upserts[0].params.slice(0, 4), ['guid-2', 1, 1, 27])
  })

  test('never fetches or writes while PostgreSQL is read-only', async () => {
    const { fetchImpl, calls } = createFetchMock()
    const database = createPool()

    const result = await refreshOp3StatsCache({
      pool: database.pool,
      databaseState: DatabaseState.READ_ONLY,
      fetchImpl,
      token: 'test-token',
      podcastGuid: 'podcast-guid',
      now: NOW
    })

    assert.deepEqual(result, { status: 'skipped', reason: 'database_not_writable' })
    assert.equal(calls.length, 0)
    assert.equal(database.connectCalls, 0)
  })

  test('treats missing configuration as disabled without warnings or calls', async () => {
    const { fetchImpl, calls } = createFetchMock()
    const database = createPool()

    const result = await refreshOp3StatsCache({
      pool: database.pool,
      databaseState: DatabaseState.READ_WRITE,
      fetchImpl,
      token: '',
      podcastGuid: '',
      now: NOW
    })

    assert.deepEqual(result, { status: 'disabled' })
    assert.equal(calls.length, 0)
    assert.equal(database.connectCalls, 0)
  })
})
