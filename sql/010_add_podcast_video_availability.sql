-- Migration 010: Independent podcast video availability and YouTube share image
-- Date: 2026-09-04
-- Additive migration: existing smartlinks and generated OG images are preserved.

ALTER TABLE episode_links
  ADD COLUMN IF NOT EXISTS spotify_video_available BOOLEAN,
  ADD COLUMN IF NOT EXISTS youtube_thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS youtube_thumbnail_checked BOOLEAN;

COMMENT ON COLUMN episode_links.spotify_video_available IS
  'Whether Spotify oEmbed confirms video for the direct episode URL';
COMMENT ON COLUMN episode_links.youtube_thumbnail_url IS
  'YouTube API maxres 16:9 thumbnail used as the episode share image';
COMMENT ON COLUMN episode_links.youtube_thumbnail_checked IS
  'Whether YouTube thumbnail availability has been checked for this episode';

-- Known published video episodes confirmed editorially before automatic
-- Spotify oEmbed enrichment is run by the worker.
UPDATE episode_links
SET spotify_video_available = TRUE
WHERE season = 3 AND episode IN (1, 2);

-- Planned rollback (not automatic):
--   ALTER TABLE episode_links
--     DROP COLUMN IF EXISTS youtube_thumbnail_checked,
--     DROP COLUMN IF EXISTS youtube_thumbnail_url,
--     DROP COLUMN IF EXISTS spotify_video_available;
-- Dropping these columns loses only derived availability and thumbnail cache.
