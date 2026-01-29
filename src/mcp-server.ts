#!/usr/bin/env node
/**
 * MCP server for channel-chat - search YouTube transcripts from Claude.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import {
  getConnection,
  initDb,
  upsertChannel,
  upsertVideo,
  videoExists,
  listChannels,
  listVideos,
  deleteVideoChunks,
  insertChunk,
  insertChunkEmbedding,
  getVideo,
  getStats,
} from './database.js';
import {
  getChannelInfo,
  getChannelVideos,
  getVideoInfo,
  downloadSubtitles,
  downloadAudio,
  DownloaderError,
} from './downloader.js';
import { parseSubtitles, transcribeAudio } from './transcriber.js';
import { chunkTranscript } from './chunker.js';
import { embedBatch } from './embedder.js';
import { search, formatTimestamp } from './search.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// UI Resource URI for the video player
const PLAYER_RESOURCE_URI = 'ui://channel-chat/player.html';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Load the bundled UI HTML.
 */
function getUiHtml(): string {
  const uiPath = join(__dirname, '..', '..', 'ui', 'dist', 'index.html');
  if (existsSync(uiPath)) {
    return readFileSync(uiPath, 'utf-8');
  }
  // Fallback
  return `<!DOCTYPE html>
<html><body style="font-family: system-ui; padding: 20px; color: #e5e5e5; background: #1a1a1a;">
<h2>Channel Chat Player</h2>
<p>UI not built. Run <code>cd ui && npm run build</code></p>
</body></html>`;
}

interface IndexResult {
  success: boolean;
  message: string;
}

/**
 * Index a single video.
 */
async function indexSingleVideo(
  videoId: string,
  channelId: string,
  db: ReturnType<typeof getConnection>,
  tempDir: string
): Promise<IndexResult> {
  try {
    const videoInfo = await getVideoInfo(videoId);
    const subtitlePath = await downloadSubtitles(videoId, tempDir);

    let segments = null;
    let transcriptSource: string | null = null;

    if (subtitlePath) {
      segments = await parseSubtitles(subtitlePath);
      transcriptSource = 'subtitles';
    } else {
      // Try ElevenLabs transcription if API key is available
      if (process.env.ELEVENLABS_API_KEY) {
        const audioPath = await downloadAudio(videoId, tempDir);
        segments = await transcribeAudio(audioPath);
        transcriptSource = 'transcription';
      } else {
        return { success: false, message: `No subtitles for ${videoId} (set ELEVENLABS_API_KEY for transcription)` };
      }
    }

    if (!segments || segments.length === 0) {
      return { success: false, message: `No transcript data for ${videoId}` };
    }

    const chunks = chunkTranscript(segments, videoInfo.title);
    if (chunks.length === 0) {
      return { success: false, message: `No chunks generated for ${videoId}` };
    }

    const chunkTexts = chunks.map(c => c.text);
    const embeddings = await embedBatch(chunkTexts, 100, false);

    upsertVideo(
      db,
      videoInfo.id,
      channelId,
      videoInfo.title,
      videoInfo.description || '',
      videoInfo.duration,
      videoInfo.published_at || '',
      videoInfo.thumbnail_url || '',
      transcriptSource
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const chunkId = insertChunk(
        db,
        videoId,
        chunk.seq,
        chunk.start_time,
        chunk.end_time,
        chunk.text
      );
      insertChunkEmbedding(db, chunkId, embedding);
    }

    return { success: true, message: `Indexed ${videoInfo.title}` };
  } catch (error) {
    return { success: false, message: `Error: ${error}` };
  }
}

// Create MCP server
const server = new Server(
  { name: 'channel-chat', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// List resources
// Resource metadata for sandbox/CSP configuration
const RESOURCE_META = {
  csp: {
    // Allow YouTube embeds (using nocookie domain for privacy/fewer restrictions)
    frameDomains: ['https://www.youtube-nocookie.com'],
  },
};

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: PLAYER_RESOURCE_URI,
      name: 'Video Player',
      description: 'Interactive video player for search results',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: RESOURCE_META,
    },
  ],
}));

// Read resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === PLAYER_RESOURCE_URI) {
    return {
      contents: [
        {
          uri: PLAYER_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: getUiHtml(),
          _meta: RESOURCE_META,
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_transcripts',
      description: 'Search across all indexed YouTube video transcripts using semantic search. Returns relevant clips with timestamps and YouTube links.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query - can be a question or topic',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default: 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
      _meta: {
        ui: {
          resourceUri: PLAYER_RESOURCE_URI,
        },
      },
    },
    {
      name: 'list_indexed_channels',
      description: 'List all YouTube channels that have been indexed for searching.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'add_channel',
      description: 'Add a YouTube channel and index all its videos for searching. This may take a while for large channels.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'YouTube channel URL (e.g., https://youtube.com/@channelname)',
          },
          max_videos: {
            type: 'integer',
            description: 'Maximum number of videos to index (default: all)',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'index_video',
      description: 'Index a specific YouTube video for searching.',
      inputSchema: {
        type: 'object',
        properties: {
          video_id: {
            type: 'string',
            description: 'YouTube video ID (e.g., dQw4w9WgXcQ)',
          },
        },
        required: ['video_id'],
      },
    },
    {
      name: 'get_stats',
      description: 'Get statistics about indexed content.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search_transcripts') {
    const query = args?.query as string;
    const limit = (args?.limit as number) || 5;

    const db = getConnection();
    initDb(db);
    db.close();

    const results = await search(query, limit);

    if (results.length === 0) {
      return { content: [{ type: 'text', text: 'No results found.' }] };
    }

    // Build text output
    let output = `Found ${results.length} results for: ${query}\n\n`;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const timestamp = formatTimestamp(r.start_time);
      const scorePct = r.score * 100;

      // Clean text
      let text = r.text;
      if (text.includes('|')) {
        text = text.split('|').slice(1).join('|').trim();
      }

      output += `**Result ${i + 1}** (Score: ${scorePct.toFixed(1)}%)\n`;
      output += `- Video: ${r.video_title}\n`;
      output += `- Channel: ${r.channel_name}\n`;
      output += `- Timestamp: ${timestamp}\n`;
      output += `- Link: ${r.youtube_url}\n`;
      output += `- Excerpt: ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}\n\n`;
    }

    return {
      content: [{ type: 'text', text: output }],
      structuredContent: { query, results },
    };
  }

  if (name === 'list_indexed_channels') {
    const db = getConnection();
    initDb(db);

    const channels = listChannels(db);

    if (channels.length === 0) {
      db.close();
      return { content: [{ type: 'text', text: 'No channels indexed yet.' }] };
    }

    let output = '**Indexed Channels:**\n\n';
    for (const ch of channels) {
      const videos = listVideos(db, ch.id);
      output += `- **${ch.name}** (${videos.length} videos)\n`;
      output += `  ID: ${ch.id}\n`;
    }

    db.close();
    return { content: [{ type: 'text', text: output }] };
  }

  if (name === 'add_channel') {
    const url = args?.url as string;
    const maxVideos = args?.max_videos as number | undefined;

    const db = getConnection();
    initDb(db);

    try {
      const channelInfo = await getChannelInfo(url);
      upsertChannel(db, channelInfo.channel_id, channelInfo.name, channelInfo.url);

      const videoIds = await getChannelVideos(channelInfo.url);
      let newVideoIds = videoIds.filter(vid => !videoExists(db, vid));

      if (maxVideos) {
        newVideoIds = newVideoIds.slice(0, maxVideos);
      }

      if (newVideoIds.length === 0) {
        db.close();
        return { content: [{ type: 'text', text: `Channel '${channelInfo.name}' - all videos already indexed.` }] };
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

      try {
        let indexed = 0;
        let failed = 0;

        for (const vid of newVideoIds) {
          const result = await indexSingleVideo(vid, channelInfo.channel_id, db, tempDir);
          if (result.success) {
            indexed++;
          } else {
            failed++;
          }
        }

        let output = `**Indexed channel: ${channelInfo.name}**\n`;
        output += `- Successfully indexed: ${indexed} videos\n`;
        output += `- Failed: ${failed} videos\n`;
        output += `- Skipped (already indexed): ${videoIds.length - newVideoIds.length} videos\n`;

        return { content: [{ type: 'text', text: output }] };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
        db.close();
      }
    } catch (error) {
      db.close();
      if (error instanceof DownloaderError) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
      throw error;
    }
  }

  if (name === 'index_video') {
    const videoId = args?.video_id as string;

    const db = getConnection();
    initDb(db);

    try {
      const existing = getVideo(db, videoId);
      let channelId: string;

      if (existing) {
        channelId = existing.channel_id;
        deleteVideoChunks(db, videoId);
      } else {
        const videoInfo = await getVideoInfo(videoId);
        channelId = videoInfo.channel_id;

        if (channelId) {
          try {
            const channelUrl = `https://www.youtube.com/channel/${channelId}`;
            const channelInfo = await getChannelInfo(channelUrl);
            upsertChannel(db, channelInfo.channel_id, channelInfo.name, channelInfo.url);
          } catch {
            upsertChannel(db, channelId, 'Unknown Channel', '');
          }
        }
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

      try {
        const result = await indexSingleVideo(videoId, channelId, db, tempDir);
        return { content: [{ type: 'text', text: result.message }] };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
        db.close();
      }
    } catch (error) {
      db.close();
      return { content: [{ type: 'text', text: `Error: ${error}` }] };
    }
  }

  if (name === 'get_stats') {
    const db = getConnection();
    initDb(db);
    const stats = getStats(db);
    db.close();

    let output = '**Channel Chat Stats:**\n';
    output += `- Channels indexed: ${stats.channels}\n`;
    output += `- Videos indexed: ${stats.videos}\n`;
    output += `- Transcript chunks: ${stats.chunks}\n`;

    return { content: [{ type: 'text', text: output }] };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

/**
 * Run the MCP server.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
