import { buildApp } from '../../server.js'
import {
  createDatabaseAvailability,
  DatabaseState
} from '../../server/resilience/databaseAvailability.js'

const rssEpisodes = [
  {
    season: 2,
    episode: 1,
    title: 'Une rencontre inattendue',
    description: 'Un épisode de la deuxième saison.',
    pubDate: '27 octobre 2025',
    rawPubDate: '2025-10-27',
    duration: '43:11',
    image: 'https://media.example/s2e1.jpg',
    audioUrl: 'https://media.example/s2e1.mp3',
    episodeLink: 'https://podcasts.example/s2e1',
    itemGuid: 'guid-s2e1'
  },
  {
    season: 1,
    episode: 5,
    title: 'Un bouclier collectif',
    description: 'Un épisode de la première saison.',
    pubDate: '16 octobre 2025',
    rawPubDate: '2025-10-16',
    duration: '30:00',
    image: 'https://media.example/s1e5.jpg',
    audioUrl: 'https://media.example/s1e5.mp3',
    episodeLink: 'https://podcasts.example/s1e5',
    itemGuid: 'guid-s1e5'
  }
]

export async function buildPodcastApp() {
  return buildApp({
    storageEnabled: false,
    databaseConfigured: false,
    databaseAvailability: createDatabaseAvailability({
      initialState: DatabaseState.UNAVAILABLE,
      probe: async () => DatabaseState.UNAVAILABLE
    }),
    episodeFetcher: async (season, episode) => rssEpisodes.find((item) =>
      item.season === season && item.episode === episode
    ) ?? null,
    podcastEpisodesFetcher: async () => rssEpisodes,
    op3PublicStatsEnabled: false,
    youtubeEpisodeResolutionEnabled: false
  })
}
