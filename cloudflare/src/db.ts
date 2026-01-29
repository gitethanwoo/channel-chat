/**
 * Cloudflare D1 database operations module.
 */

import type { ChannelRow, VideoRow, ChunkRow } from './types';

/**
 * Insert or update a channel. Sets indexed_at to current ISO timestamp.
 */
export async function upsertChannel(
  db: D1Database,
  channel: { id: string; name: string; url: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO channels (id, name, url, indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         url = excluded.url,
         indexed_at = excluded.indexed_at`
    )
    .bind(channel.id, channel.name, channel.url, new Date().toISOString())
    .run();
}

/**
 * List all channels ordered by indexed_at DESC.
 */
export async function listChannels(db: D1Database): Promise<ChannelRow[]> {
  const result = await db
    .prepare('SELECT * FROM channels ORDER BY indexed_at DESC')
    .all<ChannelRow>();
  return result.results;
}

/**
 * Insert or update a video.
 */
export async function upsertVideo(
  db: D1Database,
  video: VideoRow
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO videos (id, channel_id, title, description, duration, published_at, thumbnail_url, transcript_source, r2_video_key, r2_transcript_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         channel_id = excluded.channel_id,
         title = excluded.title,
         description = excluded.description,
         duration = excluded.duration,
         published_at = excluded.published_at,
         thumbnail_url = excluded.thumbnail_url,
         transcript_source = excluded.transcript_source,
         r2_video_key = excluded.r2_video_key,
         r2_transcript_key = excluded.r2_transcript_key`
    )
    .bind(
      video.id,
      video.channel_id,
      video.title,
      video.description,
      video.duration,
      video.published_at,
      video.thumbnail_url,
      video.transcript_source,
      video.r2_video_key,
      video.r2_transcript_key
    )
    .run();
}

/**
 * Get a video by ID.
 */
export async function getVideo(
  db: D1Database,
  id: string
): Promise<VideoRow | null> {
  const result = await db
    .prepare('SELECT * FROM videos WHERE id = ?')
    .bind(id)
    .first<VideoRow>();
  return result;
}

/**
 * List videos, optionally filtered by channel_id, ordered by published_at DESC.
 */
export async function listVideos(
  db: D1Database,
  channelId?: string
): Promise<VideoRow[]> {
  if (channelId) {
    const result = await db
      .prepare(
        'SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC'
      )
      .bind(channelId)
      .all<VideoRow>();
    return result.results;
  }
  const result = await db
    .prepare('SELECT * FROM videos ORDER BY published_at DESC')
    .all<VideoRow>();
  return result.results;
}

/**
 * Insert a chunk and return the auto-generated id.
 */
export async function insertChunk(
  db: D1Database,
  chunk: {
    video_id: string;
    seq: number;
    start_time: number;
    end_time: number;
    text: string;
  }
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO chunks (video_id, seq, start_time, end_time, text)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .bind(
      chunk.video_id,
      chunk.seq,
      chunk.start_time,
      chunk.end_time,
      chunk.text
    )
    .first<{ id: number }>();

  if (!result) {
    throw new Error('Failed to insert chunk: no id returned');
  }
  return result.id;
}

/**
 * Update a chunk's vectorize_id field.
 */
export async function updateChunkVectorizeId(
  db: D1Database,
  chunkId: number,
  vectorizeId: string
): Promise<void> {
  await db
    .prepare('UPDATE chunks SET vectorize_id = ? WHERE id = ?')
    .bind(vectorizeId, chunkId)
    .run();
}

/**
 * Get chunks by vectorize_ids with JOINs to videos and channels.
 */
export async function getChunksByVectorizeIds(
  db: D1Database,
  vectorizeIds: string[]
): Promise<
  (ChunkRow & { video_title: string; channel_name: string; channel_id: string })[]
> {
  if (vectorizeIds.length === 0) {
    return [];
  }

  // Build parameterized query with IN clause
  const placeholders = vectorizeIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT
         chunks.id,
         chunks.video_id,
         chunks.seq,
         chunks.start_time,
         chunks.end_time,
         chunks.text,
         chunks.vectorize_id,
         videos.title AS video_title,
         videos.channel_id,
         channels.name AS channel_name
       FROM chunks
       JOIN videos ON videos.id = chunks.video_id
       JOIN channels ON channels.id = videos.channel_id
       WHERE chunks.vectorize_id IN (${placeholders})`
    )
    .bind(...vectorizeIds)
    .all<
      ChunkRow & { video_title: string; channel_name: string; channel_id: string }
    >();

  return result.results;
}

/**
 * Get all chunks for a video.
 */
export async function getVideoChunks(
  db: D1Database,
  videoId: string
): Promise<ChunkRow[]> {
  const result = await db
    .prepare('SELECT * FROM chunks WHERE video_id = ? ORDER BY seq')
    .bind(videoId)
    .all<ChunkRow>();
  return result.results;
}

/**
 * Delete all chunks for a video.
 */
export async function deleteVideoChunks(
  db: D1Database,
  videoId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM chunks WHERE video_id = ?')
    .bind(videoId)
    .run();
}

/**
 * Delete a video by ID.
 */
export async function deleteVideo(
  db: D1Database,
  videoId: string
): Promise<void> {
  await db
    .prepare('DELETE FROM videos WHERE id = ?')
    .bind(videoId)
    .run();
}

/**
 * Get database statistics.
 */
export async function getStats(
  db: D1Database
): Promise<{ channels: number; videos: number; chunks: number }> {
  const [channelsResult, videosResult, chunksResult] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM channels').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM videos').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM chunks').first<{ count: number }>(),
  ]);

  return {
    channels: channelsResult?.count ?? 0,
    videos: videosResult?.count ?? 0,
    chunks: chunksResult?.count ?? 0,
  };
}
