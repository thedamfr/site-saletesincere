import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPodcastFromRSS } from '../../server/services/castopodRSS.js'

test('reads channel description without requiring an episode or another request', async () => {
  let requests = 0
  const podcast = await fetchPodcastFromRSS(5000, async () => {
    requests++
    return { ok: true, text: async () => '<rss><channel><description><![CDATA[<p>La description du <b>podcast</b> &amp; ses récits.</p>]]></description></channel></rss>' }
  })
  assert.equal(requests, 1)
  assert.equal(podcast.description, 'La description du podcast & ses récits.')
  assert.deepEqual(podcast.episodes, [])
})
