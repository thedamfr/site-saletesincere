import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllEpisodesFromRSS, fetchPublishedEpisodesFromRSS } from '../../server/services/castopodRSS.js'

test('recovery includes a supported episode zero without changing the public full-episode list', async () => {
  const rss = `<rss><channel><lastBuildDate>2026-01-01</lastBuildDate>
    <item><title>Bande annonce</title><pubDate>2025-01-01</pubDate><guid>trailer-guid</guid><itunes:season>1</itunes:season><itunes:episode>0</itunes:episode><itunes:episodeType>trailer</itunes:episodeType></item>
    <item><title>Épisode</title><pubDate>2025-01-02</pubDate><guid>episode-guid</guid><itunes:season>1</itunes:season><itunes:episode>1</itunes:episode></item>
  </channel></rss>`
  const feed = async () => new Response(rss)
  const recovered = await fetchAllEpisodesFromRSS(1000, feed)
  assert.deepEqual(recovered.map(item => [item.episode, item.itemGuid]), [[0, 'trailer-guid'], [1, 'episode-guid']])
  assert.deepEqual((await fetchPublishedEpisodesFromRSS(1000, feed)).map(item => item.episode), [1])
})
