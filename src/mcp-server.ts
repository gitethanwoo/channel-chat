#!/usr/bin/env node
/**
 * MCP server for channel-chat - search YouTube transcripts from Claude.
 * Supports both HTTP and stdio transports.
 */

import { config } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
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
  updateVideoPath,
  getVideoTranscript,
  getChannel,
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

// Load .env from project root
config({ path: join(__dirname, '..', '..', '.env') });

// UI Resource URI for the video player
const PLAYER_RESOURCE_URI = 'ui://channel-chat/player.html';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const CLIP_RESOURCE_PREFIX = 'video://clip/';
const CLIP_RESOURCE_MIME_TYPE = 'video/mp4';
const TRANSCRIPT_RESOURCE_PREFIX = 'transcript://';

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

function buildClipArgs(videoPath: string, start: number, duration: number): string[] {
  return [
    '-ss', start.toString(),
    '-i', videoPath,
    '-t', duration.toString(),
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-c:a', 'aac',
    '-movflags', '+frag_keyframe+empty_moov+faststart',
    '-f', 'mp4',
    '-loglevel', 'error',
    'pipe:1'
  ];
}

function parseClipResourceUri(uri: string): { videoId: string; start: number; duration: number } {
  const url = new URL(uri);
  const videoId = url.pathname.replace(/^\//, '');
  const start = parseFloat(url.searchParams.get('start') || '0');
  const duration = parseFloat(url.searchParams.get('duration') || '30');
  return { videoId, start, duration };
}

function clipToBase64(videoPath: string, start: number, duration: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', buildClipArgs(videoPath, start, duration));
    const chunks: Buffer[] = [];

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    ffmpeg.stderr.on('data', (data) => {
      console.error(`[ffmpeg] ${data}`);
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('base64'));
    });
  });
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
// Resource metadata for sandbox/CSP configuration.
// Note: Hosts read this from `contents[]. _meta.ui.*` on the UI HTML resource.
const RESOURCE_META = {
  ui: {
    csp: {
      // Allow YouTube embeds (using nocookie domain for privacy/fewer restrictions)
      frameDomains: ['https://www.youtube-nocookie.com'],
      // Allow media sources that use data/blob URIs in the UI sandbox
      resourceDomains: ['data:', 'blob:'],
    },
  },
  // Legacy shape (some hosts read this)
  csp: {
    frameDomains: ['https://www.youtube-nocookie.com'],
    resourceDomains: ['data:', 'blob:'],
  },
};

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.log('[MCP] List resources requested');
  return {
    resources: [
      {
        uri: PLAYER_RESOURCE_URI,
        name: 'Video Player',
        description: 'Interactive video player for search results',
        mimeType: RESOURCE_MIME_TYPE,
        _meta: RESOURCE_META,
      },
    ],
  };
});

// Read resource
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  console.log(`[MCP] Resource read: ${request.params.uri}`);
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
  if (request.params.uri.startsWith(CLIP_RESOURCE_PREFIX)) {
    const { videoId, start, duration } = parseClipResourceUri(request.params.uri);

    const db = getConnection();
    initDb(db);
    const video = getVideo(db, videoId);
    db.close();

    if (!video) {
      throw new Error(`Video not found: ${videoId}`);
    }
    if (!video.video_path || !existsSync(video.video_path)) {
      throw new Error(`Video file not found for ${videoId}. Set video_path first.`);
    }

    console.log(`[MCP] Resource clip: ${videoId} from ${start}s for ${duration}s`);
    const base64 = await clipToBase64(video.video_path, start, duration);

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: CLIP_RESOURCE_MIME_TYPE,
          blob: base64,
        },
      ],
    };
  }
  if (request.params.uri.startsWith(TRANSCRIPT_RESOURCE_PREFIX)) {
    const videoId = request.params.uri.slice(TRANSCRIPT_RESOURCE_PREFIX.length);
    console.log(`[MCP] Resource transcript: ${videoId}`);

    const db = getConnection();
    initDb(db);
    const video = getVideo(db, videoId);
    if (!video) {
      db.close();
      throw new Error(`Video not found: ${videoId}`);
    }
    const channel = getChannel(db, video.channel_id);
    const segments = getVideoTranscript(db, videoId);
    db.close();

    const transcriptData = {
      video_id: videoId,
      video_title: video.title,
      channel_name: channel?.name ?? 'Unknown Channel',
      segments,
    };

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: 'application/json',
          text: JSON.stringify(transcriptData),
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log('[MCP] List tools requested');
  return {
    tools: [
      {
        name: 'search_transcripts',
        description: 'Search across all indexed YouTube video transcripts using semantic search. Returns relevant clips with timestamps and YouTube links. Use this to find relevant content, then call show_video to display the best result.',
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
      {
        name: 'set_video_path',
        description: 'Set the local file path for a video. Required for clip resources.',
        inputSchema: {
          type: 'object',
          properties: {
            video_id: {
              type: 'string',
              description: 'YouTube video ID',
            },
            path: {
              type: 'string',
              description: 'Absolute path to the video file',
            },
          },
          required: ['video_id', 'path'],
        },
      },
      {
        name: 'show_video',
        description: 'Display a video with its full seekable transcript. Call this after using search_transcripts to show the best matching result to the user.',
        inputSchema: {
          type: 'object',
          properties: {
            video_id: {
              type: 'string',
              description: 'YouTube video ID to display',
            },
            start_time: {
              type: 'number',
              description: 'Start playback at this timestamp (in seconds)',
              default: 0,
            },
          },
          required: ['video_id'],
        },
        _meta: {
          ui: {
            resourceUri: PLAYER_RESOURCE_URI,
          },
          'ui/resourceUri': PLAYER_RESOURCE_URI,
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  console.log(`[MCP] Tool call: ${name}`, args);

  if (name === 'search_transcripts') {
    const query = args?.query as string;
    const limit = (args?.limit as number) || 5;
    console.log(`[MCP] Searching for: "${query}" (limit: ${limit})`);

    try {
      const db = getConnection();
      initDb(db);
      db.close();

      const results = await search(query, limit);
      console.log(`[MCP] Search returned ${results.length} results`);

      // Add clip resource URIs to results
      for (const r of results) {
        const duration = Math.ceil(r.end_time - r.start_time) + 5; // Add 5 sec buffer
        const start = Math.floor(r.start_time);
        r.clip_resource_uri = `${CLIP_RESOURCE_PREFIX}${r.video_id}?start=${start}&duration=${duration}`;
      }

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
      output += `- Clip Resource: ${r.clip_resource_uri}\n`;
      output += `- Excerpt: ${text.slice(0, 300)}${text.length > 300 ? '...' : ''}\n\n`;
    }

    const structured = { query, results };

    return {
      // Put JSON first so UIs can reliably parse even if `structuredContent` is not forwarded by a host.
      content: [
        { type: 'text', text: JSON.stringify(structured) },
        { type: 'text', text: output },
      ],
      structuredContent: structured,
    };
    } catch (error) {
      console.error(`[MCP] Search error:`, error);
      return { content: [{ type: 'text', text: `Search error: ${error}` }] };
    }
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

  if (name === 'set_video_path') {
    const videoId = args?.video_id as string;
    const videoPath = args?.path as string;

    if (!existsSync(videoPath)) {
      return { content: [{ type: 'text', text: `Error: File not found: ${videoPath}` }] };
    }

    const db = getConnection();
    initDb(db);

    const video = getVideo(db, videoId);
    if (!video) {
      db.close();
      return { content: [{ type: 'text', text: `Error: Video ${videoId} not found in database` }] };
    }

    updateVideoPath(db, videoId, videoPath);
    db.close();

    return { content: [{ type: 'text', text: `Video path set for ${video.title}: ${videoPath}` }] };
  }

  if (name === 'show_video') {
    const videoId = args?.video_id as string;
    const startTime = (args?.start_time as number) || 0;

    const db = getConnection();
    initDb(db);

    const video = getVideo(db, videoId);
    if (!video) {
      db.close();
      return { content: [{ type: 'text', text: `Error: Video ${videoId} not found` }] };
    }

    const channel = getChannel(db, video.channel_id);
    db.close();

    const videoUrl = `https://channelmcp.com/video/${encodeURIComponent(videoId)}`;
    const transcriptUri = `${TRANSCRIPT_RESOURCE_PREFIX}${videoId}`;

    const structured = {
      video_id: videoId,
      video_title: video.title,
      channel_name: channel?.name ?? 'Unknown Channel',
      video_url: videoUrl,
      start_time: startTime,
      transcript_uri: transcriptUri,
    };

    const textOutput = `Showing: ${video.title}\nChannel: ${channel?.name ?? 'Unknown'}\nStarting at: ${formatTimestamp(startTime)}`;

    return {
      content: [
        { type: 'text', text: JSON.stringify(structured) },
        { type: 'text', text: textOutput },
      ],
      structuredContent: structured,
    };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

const PORT = parseInt(process.env.PORT || '3000', 10);
/**
 * Run as HTTP server.
 */
async function startHttpServer() {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Handle /clip endpoint for video streaming
    if (req.url?.startsWith('/clip')) {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const videoId = url.searchParams.get('video_id');
      const start = parseFloat(url.searchParams.get('start') || '0');
      const duration = parseFloat(url.searchParams.get('duration') || '30');

      if (!videoId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'video_id is required' }));
        return;
      }

      // Get video path from database
      const db = getConnection();
      initDb(db);
      const video = getVideo(db, videoId);
      db.close();

      if (!video) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Video not found' }));
        return;
      }

      if (!video.video_path || !existsSync(video.video_path)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Video file not found. Set video_path first.' }));
        return;
      }

      console.log(`[MCP] Streaming clip: ${videoId} from ${start}s for ${duration}s`);

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      });

      const ffmpeg = spawn('ffmpeg', buildClipArgs(video.video_path, start, duration));

      ffmpeg.stdout.pipe(res);

      ffmpeg.stderr.on('data', (data) => {
        console.error(`[ffmpeg] ${data}`);
      });

      ffmpeg.on('error', (err) => {
        console.error(`[ffmpeg] Error: ${err}`);
        if (!res.writableEnded) {
          res.end();
        }
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          console.error(`[ffmpeg] Exited with code ${code}`);
        }
        if (!res.writableEnded) {
          res.end();
        }
      });

      req.on('close', () => {
        ffmpeg.kill('SIGKILL');
      });

      return;
    }

    // Handle both / and /mcp endpoints
    if (req.url !== '/mcp' && req.url !== '/') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Create transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    // Connect server to transport
    await server.connect(transport);

    // Parse body for POST requests
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const parsedBody = JSON.parse(body);
          await transport.handleRequest(req, res, parsedBody);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else {
      await transport.handleRequest(req, res);
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`MCP HTTP server listening on http://localhost:${PORT}/mcp`);
  });
}

/**
 * Start HTTP server for clip streaming only (no MCP).
 */
function startClipServer() {
  const clipServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url?.startsWith('/clip')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const videoId = url.searchParams.get('video_id');
    const start = parseFloat(url.searchParams.get('start') || '0');
    const duration = parseFloat(url.searchParams.get('duration') || '30');

    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'video_id is required' }));
      return;
    }

    const db = getConnection();
    initDb(db);
    const video = getVideo(db, videoId);
    db.close();

    if (!video) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Video not found' }));
      return;
    }

    if (!video.video_path || !existsSync(video.video_path)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Video file not found. Set video_path first.' }));
      return;
    }

    console.error(`[Clip] Streaming: ${videoId} from ${start}s for ${duration}s`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    const ffmpeg = spawn('ffmpeg', buildClipArgs(video.video_path, start, duration));

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', (data) => console.error(`[ffmpeg] ${data}`));
    ffmpeg.on('error', (err) => {
      console.error(`[ffmpeg] Error: ${err}`);
      if (!res.writableEnded) res.end();
    });
    ffmpeg.on('close', (code) => {
      if (code !== 0) console.error(`[ffmpeg] Exited with code ${code}`);
      if (!res.writableEnded) res.end();
    });
    req.on('close', () => ffmpeg.kill('SIGKILL'));
  });

  clipServer.listen(PORT, () => {
    console.error(`[Clip] HTTP server listening on http://localhost:${PORT}/clip`);
  });
}

/**
 * Run as stdio server with clip HTTP server.
 */
async function startStdioServer() {
  startClipServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Run the MCP server.
 */
async function main() {
  if (process.argv.includes('--stdio')) {
    await startStdioServer();
  } else {
    await startHttpServer();
  }
}

main().catch(console.error);
