/**
 * SQLite + sqlite-vec database operations.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

// Types
export interface Channel {
  id: string;
  name: string;
  url: string;
  avatar_url: string | null;
  indexed_at: string;
}

export interface Video {
  id: string;
  channel_id: string;
  title: string;
  description: string;
  duration: number;
  published_at: string;
  thumbnail_url: string;
  transcript_source: string;
  video_path: string | null;
}

export interface ChunkRow {
  id: number;
  video_id: string;
  seq: number;
  start_time: number;
  end_time: number;
  text: string;
}

export interface SearchResult {
  chunk_id: number;
  distance: number;
  text: string;
  start_time: number;
  end_time: number;
  video_id: string;
  video_title: string;
  channel_id: string;
  channel_name: string;
}

export interface Stats {
  channels: number;
  videos: number;
  chunks: number;
}

/**
 * Get the database path in user's data directory.
 */
export function getDbPath(): string {
  const dataDir = join(homedir(), '.channel-chat');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, 'channel_chat.db');
}

/**
 * Get a database connection with sqlite-vec loaded.
 */
export function getConnection(dbPath?: string): Database.Database {
  const path = dbPath || getDbPath();
  const db = new Database(path);
  sqliteVec.load(db);
  return db;
}

/**
 * Initialize database schema.
 */
export function initDb(db: Database.Database): void {
  db.exec(`
    -- Channels
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT,
      url TEXT,
      indexed_at TIMESTAMP
    );

    -- Videos
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      channel_id TEXT REFERENCES channels(id),
      title TEXT,
      description TEXT,
      duration INTEGER,
      published_at TIMESTAMP,
      thumbnail_url TEXT,
      transcript_source TEXT,
      video_path TEXT
    );

    -- Transcript chunks
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT REFERENCES videos(id),
      seq INTEGER,
      start_time REAL,
      end_time REAL,
      text TEXT
    );

    -- Create indexes for faster lookups
    CREATE INDEX IF NOT EXISTS idx_chunks_video_id ON chunks(video_id);
    CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
  `);

  // Migration: add video_path column if it doesn't exist
  const videoPathExists = db.prepare(
    "SELECT 1 FROM pragma_table_info('videos') WHERE name='video_path'"
  ).get();
  if (!videoPathExists) {
    db.exec('ALTER TABLE videos ADD COLUMN video_path TEXT');
  }

  // Migration: add avatar_url column to channels if it doesn't exist
  const avatarUrlExists = db.prepare(
    "SELECT 1 FROM pragma_table_info('channels') WHERE name='avatar_url'"
  ).get();
  if (!avatarUrlExists) {
    db.exec('ALTER TABLE channels ADD COLUMN avatar_url TEXT');
  }

  // Create vector table if it doesn't exist
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
  ).get();

  if (!tableExists) {
    db.exec(`
      CREATE VIRTUAL TABLE chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[768]
      )
    `);
  }
}

// Channel operations

/**
 * Insert or update a channel.
 */
export function upsertChannel(
  db: Database.Database,
  channelId: string,
  name: string,
  url: string,
  avatarUrl?: string | null
): void {
  const stmt = db.prepare(`
    INSERT INTO channels (id, name, url, avatar_url, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      avatar_url = excluded.avatar_url,
      indexed_at = excluded.indexed_at
  `);
  stmt.run(channelId, name, url, avatarUrl ?? null, new Date().toISOString());
}

/**
 * Get a channel by ID.
 */
export function getChannel(db: Database.Database, channelId: string): Channel | undefined {
  return db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as Channel | undefined;
}

/**
 * List all indexed channels.
 */
export function listChannels(db: Database.Database): Channel[] {
  return db.prepare('SELECT * FROM channels ORDER BY indexed_at DESC').all() as Channel[];
}

// Video operations

/**
 * Insert or update a video.
 */
export function upsertVideo(
  db: Database.Database,
  videoId: string,
  channelId: string,
  title: string,
  description: string,
  duration: number,
  publishedAt: string,
  thumbnailUrl: string,
  transcriptSource: string
): void {
  const stmt = db.prepare(`
    INSERT INTO videos (id, channel_id, title, description, duration, published_at, thumbnail_url, transcript_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      channel_id = excluded.channel_id,
      title = excluded.title,
      description = excluded.description,
      duration = excluded.duration,
      published_at = excluded.published_at,
      thumbnail_url = excluded.thumbnail_url,
      transcript_source = excluded.transcript_source
  `);
  stmt.run(videoId, channelId, title, description, duration, publishedAt, thumbnailUrl, transcriptSource);
}

/**
 * Get a video by ID.
 */
export function getVideo(db: Database.Database, videoId: string): Video | undefined {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as Video | undefined;
}

/**
 * List videos, optionally filtered by channel.
 */
export function listVideos(db: Database.Database, channelId?: string): Video[] {
  if (channelId) {
    return db.prepare(
      'SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC'
    ).all(channelId) as Video[];
  }
  return db.prepare('SELECT * FROM videos ORDER BY published_at DESC').all() as Video[];
}

/**
 * Check if a video is already indexed.
 */
export function videoExists(db: Database.Database, videoId: string): boolean {
  const row = db.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId);
  return row !== undefined;
}

/**
 * Update a video's local file path.
 */
export function updateVideoPath(
  db: Database.Database,
  videoId: string,
  videoPath: string
): void {
  db.prepare('UPDATE videos SET video_path = ? WHERE id = ?').run(videoPath, videoId);
}

// Chunk operations

/**
 * Delete all chunks for a video (including vectors).
 */
export function deleteVideoChunks(db: Database.Database, videoId: string): void {
  // Get chunk IDs first
  const chunks = db.prepare('SELECT id FROM chunks WHERE video_id = ?').all(videoId) as { id: number }[];

  // Delete from vector table
  const deleteVec = db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?');
  for (const chunk of chunks) {
    deleteVec.run(chunk.id);
  }

  // Delete chunks
  db.prepare('DELETE FROM chunks WHERE video_id = ?').run(videoId);
}

/**
 * Insert a chunk and return its ID.
 */
export function insertChunk(
  db: Database.Database,
  videoId: string,
  seq: number,
  startTime: number,
  endTime: number,
  text: string
): number {
  const result = db.prepare(`
    INSERT INTO chunks (video_id, seq, start_time, end_time, text)
    VALUES (?, ?, ?, ?, ?)
  `).run(videoId, seq, startTime, endTime, text);
  // lastInsertRowid is a bigint, convert to number for sqlite-vec compatibility
  return typeof result.lastInsertRowid === 'bigint'
    ? Number(result.lastInsertRowid)
    : (result.lastInsertRowid as number);
}

/**
 * Insert a chunk embedding into the vector table.
 */
export function insertChunkEmbedding(
  db: Database.Database,
  chunkId: number,
  embedding: number[]
): void {
  // Convert to Float32Array and then to Buffer for sqlite-vec
  const floatArray = new Float32Array(embedding);
  const buffer = Buffer.from(floatArray.buffer);
  // sqlite-vec with better-sqlite3 needs BigInt for integer PK when using blob params
  db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(
    BigInt(chunkId),
    buffer
  );
}

/**
 * Search for similar chunks using vector similarity.
 */
export function searchChunks(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number = 10
): SearchResult[] {
  const floatArray = new Float32Array(queryEmbedding);
  const buffer = Buffer.from(floatArray.buffer);

  const rows = db.prepare(`
    SELECT
      chunks_vec.chunk_id,
      chunks_vec.distance,
      chunks.text,
      chunks.start_time,
      chunks.end_time,
      chunks.video_id,
      videos.title as video_title,
      videos.channel_id,
      channels.name as channel_name
    FROM chunks_vec
    JOIN chunks ON chunks.id = chunks_vec.chunk_id
    JOIN videos ON videos.id = chunks.video_id
    JOIN channels ON channels.id = videos.channel_id
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `).all(buffer, limit) as SearchResult[];

  return rows;
}

/**
 * Get database statistics.
 */
export function getStats(db: Database.Database): Stats {
  const channelsRow = db.prepare('SELECT COUNT(*) as count FROM channels').get() as { count: number };
  const videosRow = db.prepare('SELECT COUNT(*) as count FROM videos').get() as { count: number };
  const chunksRow = db.prepare('SELECT COUNT(*) as count FROM chunks').get() as { count: number };

  return {
    channels: channelsRow.count,
    videos: videosRow.count,
    chunks: chunksRow.count,
  };
}
