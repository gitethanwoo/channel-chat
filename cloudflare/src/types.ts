// Cloudflare Worker environment bindings
export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  R2: R2Bucket;
  AI: Ai;
  ENVIRONMENT: string;
  API_KEY?: string;
}

// Database row types
export interface ChannelRow {
  id: string;
  name: string;
  url: string;
  indexed_at: string | null;
}

export interface VideoRow {
  id: string;
  channel_id: string;
  title: string;
  description: string | null;
  duration: number | null;
  published_at: string | null;
  thumbnail_url: string | null;
  transcript_source: string | null;
  r2_video_key: string | null;
  r2_transcript_key: string | null;
}

export interface ChunkRow {
  id: number;
  video_id: string;
  seq: number;
  start_time: number | null;
  end_time: number | null;
  text: string;
  vectorize_id: string | null;
}

// Combined result from Vectorize + D1
export interface SearchResult {
  chunk_id: number;
  score: number;
  text: string;
  start_time: number | null;
  end_time: number | null;
  video_id: string;
  video_title: string;
  channel_id: string;
  channel_name: string;
}

// Request body for POST /api/index
export interface IndexRequest {
  channel: {
    id: string;
    name: string;
    url: string;
  };
  video: {
    id: string;
    title: string;
    description?: string;
    duration?: number;
    published_at?: string;
    thumbnail_url?: string;
    transcript_source: string;
  };
  chunks: Array<{
    seq: number;
    start_time: number;
    end_time: number;
    text: string;
  }>;
  r2_video_key?: string;
  r2_transcript_key?: string;
}

// Response for GET /api/stats
export interface StatsResponse {
  channels: number;
  videos: number;
  chunks: number;
}
