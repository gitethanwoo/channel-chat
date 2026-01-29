/**
 * Search module with vector similarity search for channel-chat.
 */

import { getConnection, initDb, searchChunks, type SearchResult as DbSearchResult } from './database.js';
import { embedText } from './embedder.js';

export interface SearchResult {
  text: string;
  video_title: string;
  video_id: string;
  channel_name: string;
  start_time: number;
  end_time: number;
  youtube_url: string;
  score: number;
}

/**
 * Format seconds into a human-readable timestamp.
 */
export function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Convert seconds to YouTube URL time parameter.
 */
export function secondsToYoutubeTime(seconds: number): number {
  return Math.round(seconds);
}

/**
 * Search for chunks similar to the query.
 */
export async function search(query: string, limit: number = 10): Promise<SearchResult[]> {
  // Embed the query
  const queryEmbedding = await embedText(query);

  // Get database connection and search
  const db = getConnection();
  initDb(db);
  const rawResults = searchChunks(db, queryEmbedding, limit);
  db.close();

  // Format results
  const results: SearchResult[] = [];
  for (const row of rawResults) {
    // Extract text without title prefix if present
    let text = row.text;
    const videoTitle = row.video_title;

    // Remove title prefix if the text starts with it
    const titlePrefix = `${videoTitle}: `;
    if (text.startsWith(titlePrefix)) {
      text = text.slice(titlePrefix.length);
    }

    // Calculate similarity score (1 - distance)
    const score = 1 - row.distance;

    // Build YouTube URL with timestamp
    const youtubeTime = secondsToYoutubeTime(row.start_time);
    const youtubeUrl = `https://youtube.com/watch?v=${row.video_id}&t=${youtubeTime}`;

    results.push({
      text,
      video_title: videoTitle,
      video_id: row.video_id,
      channel_name: row.channel_name,
      start_time: row.start_time,
      end_time: row.end_time,
      youtube_url: youtubeUrl,
      score,
    });
  }

  return results;
}
