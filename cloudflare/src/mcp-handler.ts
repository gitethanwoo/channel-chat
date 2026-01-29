/**
 * MCP tool handlers for the channel-chat Cloudflare Worker.
 * Implements search_transcripts, list_indexed_channels, and get_stats tools.
 */

import type { Env, ChannelRow, SearchResult } from './types';
import { listChannels, getChunksByVectorizeIds, getStats as getDbStats } from './db';
import { generateEmbedding, searchVectors } from './vectorize';

// Constants for clip resource URIs
const CLIP_RESOURCE_PREFIX = 'video://clip/';
const DEFAULT_CLIP_DURATION = 60;

/**
 * Format seconds into a human-readable timestamp (HH:MM:SS or MM:SS).
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
function secondsToYoutubeTime(seconds: number): number {
  return Math.round(seconds);
}

/**
 * Search result with additional formatted fields for MCP response.
 */
interface FormattedSearchResult extends SearchResult {
  youtube_url: string;
  clip_resource_uri: string;
}

/**
 * Search indexed transcripts using semantic similarity search.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param query - Search query string
 * @param limit - Maximum number of results (default: 5)
 * @returns MCP tool response with text and structuredContent
 */
export async function searchTranscripts(
  env: Env,
  query: string,
  limit: number = 5
): Promise<{ content: Array<{ type: string; text: string }>; structuredContent: { query: string; results: FormattedSearchResult[] } }> {
  // Generate embedding for the query using Workers AI
  const queryEmbedding = await generateEmbedding(env.AI, query);

  // Search Vectorize for similar vectors
  const vectorMatches = await searchVectors(env.VECTORIZE, queryEmbedding, limit);

  if (vectorMatches.length === 0) {
    return {
      content: [{ type: 'text', text: 'No results found.' }],
      structuredContent: { query, results: [] },
    };
  }

  // Extract vectorize IDs for D1 lookup
  const vectorizeIds = vectorMatches.map((m) => m.id);

  // Fetch chunk details from D1
  const chunks = await getChunksByVectorizeIds(env.DB, vectorizeIds);

  // Create a map of vectorize_id -> score for quick lookup
  const scoreMap = new Map<string, number>();
  for (const match of vectorMatches) {
    scoreMap.set(match.id, match.score);
  }

  // Format results with all required fields
  const results: FormattedSearchResult[] = [];

  for (const chunk of chunks) {
    const score = scoreMap.get(chunk.vectorize_id ?? '') ?? 0;
    const startTime = chunk.start_time ?? 0;
    const endTime = chunk.end_time ?? startTime;

    // Build YouTube URL with timestamp
    const youtubeTime = secondsToYoutubeTime(startTime);
    const youtubeUrl = `https://youtube.com/watch?v=${chunk.video_id}&t=${youtubeTime}`;

    // Build clip resource URI with 60s default duration
    const clipStart = Math.floor(startTime);
    const clipResourceUri = `${CLIP_RESOURCE_PREFIX}${chunk.video_id}?start=${clipStart}&duration=${DEFAULT_CLIP_DURATION}`;

    results.push({
      chunk_id: chunk.id,
      score,
      text: chunk.text,
      start_time: startTime,
      end_time: endTime,
      video_id: chunk.video_id,
      video_title: chunk.video_title,
      channel_id: chunk.channel_id,
      channel_name: chunk.channel_name,
      youtube_url: youtubeUrl,
      clip_resource_uri: clipResourceUri,
    });
  }

  // Sort by score descending (Vectorize returns sorted, but we need to reorder after D1 lookup)
  results.sort((a, b) => b.score - a.score);

  // Build text output (markdown formatted)
  let output = `Found ${results.length} results for: ${query}\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const timestamp = formatTimestamp(r.start_time ?? 0);
    const scorePct = r.score * 100;

    // Clean text - remove title prefix if present
    let text = r.text;
    if (text.includes('|')) {
      text = text.split('|').slice(1).join('|').trim();
    }

    output += `**Result ${i + 1}** (Score: ${scorePct.toFixed(1)}%)\n`;
    output += `- Video: ${r.video_title}\n`;
    output += `- Channel: ${r.channel_name}\n`;
    output += `- Timestamp: ${timestamp}\n`;
    output += `- Link: ${r.youtube_url}\n`;
    output += `- Clip Resource: ${r.clip_resource_uri}\n`;
    output += `- Excerpt: ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}\n\n`;
  }

  return {
    content: [{ type: 'text', text: output }],
    structuredContent: { query, results },
  };
}

/**
 * List all indexed YouTube channels.
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns MCP tool response with channel list
 */
export async function listIndexedChannels(
  env: Env
): Promise<{ content: Array<{ type: string; text: string }>; structuredContent: { channels: ChannelRow[] } }> {
  const channels = await listChannels(env.DB);

  if (channels.length === 0) {
    return {
      content: [{ type: 'text', text: 'No channels indexed yet.' }],
      structuredContent: { channels: [] },
    };
  }

  // Build text output (markdown formatted)
  let output = '**Indexed Channels:**\n\n';
  for (const ch of channels) {
    output += `- **${ch.name}**\n`;
    output += `  - ID: ${ch.id}\n`;
    output += `  - URL: ${ch.url}\n`;
    output += `  - Indexed at: ${ch.indexed_at ?? 'Unknown'}\n\n`;
  }

  return {
    content: [{ type: 'text', text: output }],
    structuredContent: { channels },
  };
}

/**
 * Get statistics about indexed content.
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns MCP tool response with stats
 */
export async function getStats(
  env: Env
): Promise<{ content: Array<{ type: string; text: string }>; structuredContent: { channels: number; videos: number; chunks: number } }> {
  const stats = await getDbStats(env.DB);

  // Build text output (markdown formatted)
  let output = '**Channel Chat Stats:**\n';
  output += `- Channels indexed: ${stats.channels}\n`;
  output += `- Videos indexed: ${stats.videos}\n`;
  output += `- Transcript chunks: ${stats.chunks}\n`;

  return {
    content: [{ type: 'text', text: output }],
    structuredContent: stats,
  };
}
