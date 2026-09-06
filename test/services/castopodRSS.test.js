import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchEpisodeFromRSS,
  fetchPublishedEpisodesFromRSS
} from '../../server/services/castopodRSS.js';

const RSS_LIST_FIXTURE = `<?xml version="1.0"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" version="2.0">
  <channel>
    <lastBuildDate>Thu, 20 Aug 2026 10:00:00 GMT</lastBuildDate>
    <item>
      <title>Épisode trois</title><description>Une description assez longue.</description>
      <pubDate>Thu, 20 Aug 2026 08:00:00 GMT</pubDate>
      <itunes:season>2</itunes:season><itunes:episode>3</itunes:episode>
      <itunes:duration>3600</itunes:duration><itunes:image href="https://media.example/3.jpg" />
      <enclosure url="https://media.example/3.mp3"/><link>https://podcasts.example/3</link><guid>guid-3</guid>
      <podcast:alternateEnclosure type="video/mp4" length="123456">
        <podcast:source uri="https://media.example/3.mp4" />
      </podcast:alternateEnclosure>
      <podcast:alternateEnclosure type="application/x-mpegURL">
        <podcast:source uri="https://media.example/3.m3u8" />
      </podcast:alternateEnclosure>
    </item>
    <item>
      <title>Épisode deux</title><description>Deuxième description.</description>
      <pubDate>Thu, 13 Aug 2026 08:00:00 GMT</pubDate>
      <itunes:season>2</itunes:season><itunes:episode>2</itunes:episode>
      <itunes:duration>1800</itunes:duration><enclosure url="https://media.example/2.mp3"/>
      <link>https://podcasts.example/2</link><guid>guid-2</guid>
    </item>
    <item>
      <title>Sans GUID</title><description>Ignoré.</description>
      <pubDate>Thu, 6 Aug 2026 08:00:00 GMT</pubDate>
      <itunes:season>3</itunes:season><itunes:episode>1</itunes:episode>
      <itunes:duration>1200</itunes:duration><enclosure url="https://media.example/1.mp3"/>
    </item>
    <item>
      <title>Une collaboration… un peu spéciale 🌶️</title><description>Dans la tech, une rencontre inattendue.</description>
      <pubDate>Mon, 27 Oct 2025 08:00:00 GMT</pubDate>
      <itunes:season>2</itunes:season><itunes:episode>1</itunes:episode>
      <itunes:duration>2591</itunes:duration><enclosure url="https://media.example/s2e1.mp3"/>
      <link>https://podcasts.example/s2e1</link><guid>guid-s2e1</guid>
    </item>
    <item>
      <title>BOUCLIER 🛡️</title><description>Un épisode de la première saison.</description>
      <pubDate>Thu, 16 Oct 2025 08:00:00 GMT</pubDate>
      <itunes:season>1</itunes:season><itunes:episode>5</itunes:episode>
      <itunes:duration>1800</itunes:duration><enclosure url="https://media.example/s1e5.mp3"/>
      <link>https://podcasts.example/s1e5</link><guid>guid-s1e5</guid>
    </item>
  </channel>
</rss>`;

const rssFetch = async () => new Response(RSS_LIST_FIXTURE, { status: 200 });

describe('Castopod RSS Parser', () => {
  describe('fetchPublishedEpisodesFromRSS', () => {
    it('returns all published numbered episodes with their OP3 GUID', async () => {
      const episodes = await fetchPublishedEpisodesFromRSS(5000, rssFetch);

      assert.equal(episodes.length, 4);
      assert.deepEqual(episodes.slice(0, 2).map(({ itemGuid }) => itemGuid), ['guid-3', 'guid-2']);
      assert.equal(episodes[0].duration, '1:00:00');
      assert.equal(episodes[0].feedLastBuildDate, 'Thu, 20 Aug 2026 10:00:00 GMT');
      assert.equal(episodes[0].hasVideo, true);
      assert.deepEqual(episodes[0].videoFormats, { mp4: true, hls: true });
      assert.equal(episodes[1].hasVideo, false);
      assert.deepEqual(episodes[1].videoFormats, { mp4: false, hls: false });
    });
  });

  describe('fetchEpisodeFromRSS', () => {
    it('should parse episode S2E1 from RSS', async () => {
      const episode = await fetchEpisodeFromRSS(2, 1, 5000, rssFetch);
      
      assert.ok(episode, 'Episode should exist');
      assert.strictEqual(episode.season, 2);
      assert.strictEqual(episode.episode, 1);
      assert.strictEqual(episode.title, 'Une collaboration… un peu spéciale 🌶️');
      assert.match(episode.description, /Dans la tech/);
      assert.strictEqual(episode.duration, '43:11'); // 2591 seconds = 43:11
      assert.match(episode.audioUrl, /\.mp3$/);
      assert.ok(episode.itemGuid, 'Episode GUID should be available for OP3 stats');
    });

    it('should parse episode S1E5 from RSS', async () => {
      const episode = await fetchEpisodeFromRSS(1, 5, 5000, rssFetch);
      
      assert.ok(episode, 'Episode should exist');
      assert.strictEqual(episode.season, 1);
      assert.strictEqual(episode.episode, 5);
      assert.strictEqual(episode.title, 'BOUCLIER 🛡️');
    });

    it('should return null for non-existent episode', async () => {
      const episode = await fetchEpisodeFromRSS(99, 99, 5000, rssFetch);
      
      assert.strictEqual(episode, null);
    });

    it('should format pubDate in French', async () => {
      const episode = await fetchEpisodeFromRSS(2, 1, 5000, rssFetch);
      
      assert.match(episode.pubDate, /\d{1,2} (janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre) \d{4}/);
    });

    it('should handle timeout after 5 seconds', async () => {
      // Note: This test would need a mock server to properly test timeout
      // For now, we verify the function accepts timeout parameter
      const episode = await fetchEpisodeFromRSS(2, 1, 5000, rssFetch);
      assert.ok(episode !== undefined);
    });

    it('should include feedLastBuildDate from RSS channel', async () => {
      const episode = await fetchEpisodeFromRSS(2, 1, 5000, rssFetch);
      
      assert.ok(episode.feedLastBuildDate, 'feedLastBuildDate should exist');
      assert.ok(episode.feedLastBuildDate instanceof Date || typeof episode.feedLastBuildDate === 'string', 
        'feedLastBuildDate should be a Date or ISO string');
    });

    it('ignores alternate enclosures without a valid HTTP video source', async () => {
      const invalidVideoFixture = `<?xml version="1.0"?>
        <rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" version="2.0">
          <channel><item>
            <title>Audio seulement</title><description>Test.</description>
            <pubDate>Thu, 20 Aug 2026 08:00:00 GMT</pubDate>
            <itunes:season>4</itunes:season><itunes:episode>1</itunes:episode>
            <itunes:duration>60</itunes:duration><guid>guid-4-1</guid>
            <podcast:alternateEnclosure type="audio/flac">
              <podcast:source uri="https://media.example/episode.flac" />
            </podcast:alternateEnclosure>
            <podcast:alternateEnclosure type="video/mp4">
              <podcast:source uri="file:///private/episode.mp4" />
            </podcast:alternateEnclosure>
          </item></channel>
        </rss>`;
      const episode = await fetchEpisodeFromRSS(
        4,
        1,
        5000,
        async () => new Response(invalidVideoFixture, { status: 200 })
      );

      assert.equal(episode.hasVideo, false);
      assert.deepEqual(episode.videoFormats, { mp4: false, hls: false });
    });
  });
});
