-- D1 Schema for channel-chat
-- Run with: wrangler d1 execute channel-chat --file=./schema.sql

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  indexed_at TEXT
);

-- Videos table
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  duration INTEGER,
  published_at TEXT,
  thumbnail_url TEXT,
  transcript_source TEXT,
  r2_video_key TEXT,
  r2_transcript_key TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

-- Chunks table (text only, embeddings in Vectorize)
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  start_time REAL,
  end_time REAL,
  text TEXT NOT NULL,
  vectorize_id TEXT,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_chunks_video_id ON chunks(video_id);
CREATE INDEX IF NOT EXISTS idx_chunks_vectorize_id ON chunks(vectorize_id);
