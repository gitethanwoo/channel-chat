/**
 * Cloudflare Worker entry point for channel-chat.
 * Handles MCP protocol, indexing API, video/transcript serving, and UI.
 */

import type { Env, IndexRequest } from './types';
import {
  upsertChannel,
  upsertVideo,
  insertChunk,
  updateChunkVectorizeId,
  deleteVideoChunks,
  getVideo,
  getStats,
  listChannels,
} from './db';
import {
  generateEmbeddings,
  upsertVectors,
  deleteVectors,
} from './vectorize';
import { searchTranscripts, listIndexedChannels, getStats as getMcpStats } from './mcp-handler';
import { UI_HTML } from './ui-html';

// MCP Protocol constants
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'channel-chat';
const SERVER_VERSION = '1.0.0';

// UI Resource constants for MCP App
const PLAYER_RESOURCE_URI = 'ui://channel-chat/player.html';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const RESOURCE_META = {
  csp: {
    // Allow YouTube embeds (using nocookie domain for privacy/fewer restrictions)
    frameDomains: ['https://www.youtube-nocookie.com'],
  },
};

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// MCP Tool definitions
const MCP_TOOLS = [
  {
    name: 'search_transcripts',
    description: 'Search indexed YouTube video transcripts using semantic similarity. Returns relevant transcript excerpts with timestamps and links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant transcript segments',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5, max: 20)',
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
    description: 'List all YouTube channels that have been indexed for transcript search.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_stats',
    description: 'Get statistics about the indexed content including channel count, video count, and transcript chunk count.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

/**
 * Add CORS headers to a response
 */
function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Create a JSON response with CORS headers
 */
function jsonResponse(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

/**
 * Create an error response with CORS headers
 */
function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Verify API key authentication for protected routes.
 * Returns null if authentication is valid, or an error Response if invalid.
 * Skips auth if API_KEY is not set (for development).
 */
function verifyApiKey(request: Request, env: Env): Response | null {
  // Skip auth if API_KEY is not configured (development mode)
  if (!env.API_KEY) {
    return null;
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return errorResponse('Missing Authorization header', 401);
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return errorResponse('Invalid Authorization header format. Expected: Bearer <api_key>', 401);
  }

  const providedKey = match[1];
  if (providedKey !== env.API_KEY) {
    return errorResponse('Invalid API key', 401);
  }

  return null;
}

/**
 * Handle POST /api/index - Index a video with chunks
 */
async function handleIndexRequest(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as IndexRequest;

    // Validate required fields
    if (!body.channel || !body.video || !body.chunks) {
      return errorResponse('Missing required fields: channel, video, chunks', 400);
    }

    // Upsert channel
    await upsertChannel(env.DB, body.channel);

    // Upsert video
    await upsertVideo(env.DB, {
      id: body.video.id,
      channel_id: body.channel.id,
      title: body.video.title,
      description: body.video.description ?? null,
      duration: body.video.duration ?? null,
      published_at: body.video.published_at ?? null,
      thumbnail_url: body.video.thumbnail_url ?? null,
      transcript_source: body.video.transcript_source,
      r2_video_key: body.r2_video_key ?? null,
      r2_transcript_key: body.r2_transcript_key ?? null,
    });

    // Insert chunks and generate embeddings
    const chunkTexts = body.chunks.map((c) => c.text);
    const embeddings = await generateEmbeddings(env.AI, chunkTexts);

    const vectorsToUpsert: Array<{ id: string; embedding: number[]; metadata?: Record<string, string> }> = [];

    for (let i = 0; i < body.chunks.length; i++) {
      const chunk = body.chunks[i];
      const chunkId = await insertChunk(env.DB, {
        video_id: body.video.id,
        seq: chunk.seq,
        start_time: chunk.start_time,
        end_time: chunk.end_time,
        text: chunk.text,
      });

      const vectorizeId = `chunk_${chunkId}`;
      await updateChunkVectorizeId(env.DB, chunkId, vectorizeId);

      vectorsToUpsert.push({
        id: vectorizeId,
        embedding: embeddings[i],
        metadata: { video_id: body.video.id },
      });
    }

    // Batch upsert vectors
    await upsertVectors(env.VECTORIZE, vectorsToUpsert);

    return jsonResponse({
      success: true,
      video_id: body.video.id,
      chunks_indexed: body.chunks.length,
    });
  } catch (error) {
    console.error('Index error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to index video',
      500
    );
  }
}

/**
 * Handle DELETE /api/video/:id - Delete a video and its chunks
 */
async function handleDeleteVideo(videoId: string, env: Env): Promise<Response> {
  try {
    const video = await getVideo(env.DB, videoId);
    if (!video) {
      return errorResponse('Video not found', 404);
    }

    // Get all chunk vectorize_ids for this video to delete from Vectorize
    const chunksResult = await env.DB
      .prepare('SELECT vectorize_id FROM chunks WHERE video_id = ?')
      .bind(videoId)
      .all<{ vectorize_id: string | null }>();

    const vectorizeIds = chunksResult.results
      .map((c) => c.vectorize_id)
      .filter((id): id is string => id !== null);

    // Delete from Vectorize
    if (vectorizeIds.length > 0) {
      await deleteVectors(env.VECTORIZE, vectorizeIds);
    }

    // Delete chunks from D1
    await deleteVideoChunks(env.DB, videoId);

    // Delete video from D1
    await env.DB.prepare('DELETE FROM videos WHERE id = ?').bind(videoId).run();

    // Delete from R2 if keys exist
    if (video.r2_video_key) {
      await env.R2.delete(video.r2_video_key);
    }
    if (video.r2_transcript_key) {
      await env.R2.delete(video.r2_transcript_key);
    }

    return jsonResponse({ success: true, video_id: videoId });
  } catch (error) {
    console.error('Delete video error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to delete video',
      500
    );
  }
}

/**
 * Handle GET /video/:id - Stream video from R2 with Range header support
 */
async function handleVideoRequest(videoId: string, request: Request, env: Env): Promise<Response> {
  try {
    const video = await getVideo(env.DB, videoId);
    if (!video) {
      return errorResponse('Video not found', 404);
    }

    if (!video.r2_video_key) {
      return errorResponse('Video file not available', 404);
    }

    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      // Parse the range header
      const range = parseRangeHeader(rangeHeader);

      if (!range) {
        // Invalid range header, return full content
        return await serveFullVideo(video.r2_video_key, env);
      }

      // Handle range request for video seeking
      const object = await env.R2.get(video.r2_video_key, { range });

      if (!object) {
        return errorResponse('Video file not found in storage', 404);
      }

      const headers = new Headers();
      headers.set('Content-Type', object.httpMetadata?.contentType || 'video/mp4');
      headers.set('Accept-Ranges', 'bytes');

      // Get the full size for Content-Range header
      const fullSize = object.size;
      const start = range.offset;
      const end = range.length !== undefined ? start + range.length - 1 : fullSize - 1;
      headers.set('Content-Range', `bytes ${start}-${end}/${fullSize}`);
      headers.set('Content-Length', String(end - start + 1));

      return withCors(
        new Response(object.body, {
          status: 206,
          headers,
        })
      );
    } else {
      // Full video request
      return await serveFullVideo(video.r2_video_key, env);
    }
  } catch (error) {
    console.error('Video request error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch video',
      500
    );
  }
}

/**
 * Serve full video content from R2
 */
async function serveFullVideo(r2Key: string, env: Env): Promise<Response> {
  const object = await env.R2.get(r2Key);

  if (!object) {
    return errorResponse('Video file not found in storage', 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'video/mp4');
  headers.set('Content-Length', String(object.size));
  headers.set('Accept-Ranges', 'bytes');

  return withCors(
    new Response(object.body, {
      status: 200,
      headers,
    })
  );
}

/**
 * Parse Range header into R2 range object
 * Supports format: bytes=start-end or bytes=start-
 * Returns null if the header is invalid
 */
function parseRangeHeader(rangeHeader: string): { offset: number; length?: number } | null {
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    return null;
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;

  if (end !== undefined) {
    return { offset: start, length: end - start + 1 };
  }

  return { offset: start };
}

/**
 * Handle GET /transcript/:id - Return transcript from R2
 */
async function handleTranscriptRequest(videoId: string, env: Env): Promise<Response> {
  try {
    const video = await getVideo(env.DB, videoId);
    if (!video) {
      return errorResponse('Video not found', 404);
    }

    if (!video.r2_transcript_key) {
      return errorResponse('Transcript not available', 404);
    }

    const object = await env.R2.get(video.r2_transcript_key);

    if (!object) {
      return errorResponse('Transcript file not found in storage', 404);
    }

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/json');

    return withCors(
      new Response(object.body, {
        status: 200,
        headers,
      })
    );
  } catch (error) {
    console.error('Transcript request error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch transcript',
      500
    );
  }
}

/**
 * Handle POST /api/search - Search transcripts
 */
async function handleSearchRequest(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { query?: string; limit?: number };

    if (!body.query || typeof body.query !== 'string') {
      return errorResponse('Missing required field: query', 400);
    }

    const limit = typeof body.limit === 'number' ? Math.min(body.limit, 20) : 5;

    // Get base URL from request for generating cloudflare_video_url
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    const result = await searchTranscripts(env, body.query, limit, baseUrl);

    return jsonResponse(result.structuredContent);
  } catch (error) {
    console.error('Search request error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to search transcripts',
      500
    );
  }
}

/**
 * Handle GET /api/stats - Return database statistics
 */
async function handleStatsRequest(env: Env): Promise<Response> {
  try {
    const stats = await getStats(env.DB);
    return jsonResponse(stats);
  } catch (error) {
    console.error('Stats request error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch stats',
      500
    );
  }
}

/**
 * Handle GET /api/channels - Return list of channels
 */
async function handleChannelsRequest(env: Env): Promise<Response> {
  try {
    const channels = await listChannels(env.DB);
    return jsonResponse(channels);
  } catch (error) {
    console.error('Channels request error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to fetch channels',
      500
    );
  }
}

/**
 * Handle UI requests - Serve the embedded UI
 */
function handleUIRequest(): Response {
  return withCors(
    new Response(UI_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  );
}

/**
 * Build a JSON-RPC success response
 */
function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Build a JSON-RPC error response
 */
function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

/**
 * Handle MCP initialize request
 */
function handleMcpInitialize(id: string | number | null): JsonRpcResponse {
  return jsonRpcSuccess(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    capabilities: {
      tools: {},
      resources: {},
    },
  });
}

/**
 * Handle MCP tools/list request
 */
function handleMcpToolsList(id: string | number | null): JsonRpcResponse {
  return jsonRpcSuccess(id, {
    tools: MCP_TOOLS,
  });
}

/**
 * Handle MCP resources/list request
 */
function handleMcpResourcesList(id: string | number | null): JsonRpcResponse {
  return jsonRpcSuccess(id, {
    resources: [
      {
        uri: PLAYER_RESOURCE_URI,
        name: 'Video Player',
        description: 'Interactive video player for search results',
        mimeType: RESOURCE_MIME_TYPE,
        _meta: RESOURCE_META,
      },
    ],
  });
}

/**
 * Handle MCP resources/read request
 */
function handleMcpResourcesRead(
  id: string | number | null,
  params: { uri?: string } | undefined
): JsonRpcResponse {
  if (!params?.uri) {
    return jsonRpcError(id, -32602, 'Invalid params: missing uri');
  }

  if (params.uri === PLAYER_RESOURCE_URI) {
    return jsonRpcSuccess(id, {
      contents: [
        {
          uri: PLAYER_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: UI_HTML,
          _meta: RESOURCE_META,
        },
      ],
    });
  }

  return jsonRpcError(id, -32602, `Unknown resource: ${params.uri}`);
}

/**
 * Handle MCP tools/call request
 */
async function handleMcpToolsCall(
  id: string | number | null,
  params: { name?: string; arguments?: Record<string, unknown> } | undefined,
  env: Env,
  baseUrl: string
): Promise<JsonRpcResponse> {
  if (!params?.name) {
    return jsonRpcError(id, -32602, 'Invalid params: missing tool name');
  }

  const toolName = params.name;
  const toolArgs = params.arguments ?? {};

  try {
    switch (toolName) {
      case 'search_transcripts': {
        const query = toolArgs.query;
        if (typeof query !== 'string' || query.length === 0) {
          return jsonRpcError(id, -32602, 'Invalid params: query must be a non-empty string');
        }
        const limit = typeof toolArgs.limit === 'number' ? Math.min(toolArgs.limit, 20) : 5;
        const result = await searchTranscripts(env, query, limit, baseUrl);
        return jsonRpcSuccess(id, result);
      }

      case 'list_indexed_channels': {
        const result = await listIndexedChannels(env);
        return jsonRpcSuccess(id, result);
      }

      case 'get_stats': {
        const result = await getMcpStats(env);
        return jsonRpcSuccess(id, result);
      }

      default:
        return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
  } catch (error) {
    console.error(`Tool execution error (${toolName}):`, error);
    return jsonRpcError(
      id,
      -32603,
      error instanceof Error ? error.message : 'Internal error during tool execution'
    );
  }
}

/**
 * Handle MCP protocol requests via JSON-RPC
 */
async function handleMCPRequest(request: Request, env: Env): Promise<Response> {
  let body: JsonRpcRequest;

  try {
    body = await request.json() as JsonRpcRequest;
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, 'Parse error: invalid JSON'));
  }

  // Validate JSON-RPC structure
  if (body.jsonrpc !== '2.0') {
    return jsonResponse(jsonRpcError(body.id ?? null, -32600, 'Invalid Request: missing or invalid jsonrpc version'));
  }

  if (typeof body.method !== 'string') {
    return jsonResponse(jsonRpcError(body.id ?? null, -32600, 'Invalid Request: missing method'));
  }

  const id = body.id ?? null;
  const method = body.method;
  const params = body.params as Record<string, unknown> | undefined;

  // Get base URL for generating video URLs
  const url = new URL(request.url);
  const baseUrl = `${url.protocol}//${url.host}`;

  // Route to appropriate handler based on method
  let response: JsonRpcResponse;

  switch (method) {
    case 'initialize':
      response = handleMcpInitialize(id);
      break;

    case 'notifications/initialized':
      // Client acknowledgment notification - no response needed for notifications
      // But if id is provided, we should respond
      if (id !== null) {
        response = jsonRpcSuccess(id, {});
      } else {
        // Notifications don't get responses
        return jsonResponse({});
      }
      break;

    case 'tools/list':
      response = handleMcpToolsList(id);
      break;

    case 'tools/call':
      response = await handleMcpToolsCall(id, params as { name?: string; arguments?: Record<string, unknown> }, env, baseUrl);
      break;

    case 'ping':
      response = jsonRpcSuccess(id, {});
      break;

    case 'resources/list':
      response = handleMcpResourcesList(id);
      break;

    case 'resources/read':
      response = handleMcpResourcesRead(id, params as { uri?: string });
      break;

    default:
      response = jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  return jsonResponse(response);
}

/**
 * Main worker fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Handle CORS preflight requests
    if (method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      // MCP protocol requests
      if (path === '/mcp' || (path === '/' && method !== 'GET')) {
        if (method === 'POST') {
          return await handleMCPRequest(request, env);
        }
        if (method === 'GET') {
          // Streamable HTTP spec: return 405 if server doesn't support SSE streams
          return withCors(new Response(null, { status: 405, statusText: 'Method Not Allowed' }));
        }
      }

      // Indexing API (requires API key authentication)
      if (path === '/api/index' && method === 'POST') {
        const authError = verifyApiKey(request, env);
        if (authError) return authError;
        return await handleIndexRequest(request, env);
      }

      // Delete video API - match /api/video/:id (requires API key authentication)
      const deleteVideoMatch = path.match(/^\/api\/video\/([^/]+)$/);
      if (deleteVideoMatch && method === 'DELETE') {
        const authError = verifyApiKey(request, env);
        if (authError) return authError;
        return await handleDeleteVideo(deleteVideoMatch[1], env);
      }

      // Video streaming - match /video/:id
      const videoMatch = path.match(/^\/video\/([^/]+)$/);
      if (videoMatch && method === 'GET') {
        return await handleVideoRequest(videoMatch[1], request, env);
      }

      // Transcript serving - match /transcript/:id
      const transcriptMatch = path.match(/^\/transcript\/([^/]+)$/);
      if (transcriptMatch && method === 'GET') {
        return await handleTranscriptRequest(transcriptMatch[1], env);
      }

      // Search API
      if (path === '/api/search' && method === 'POST') {
        return await handleSearchRequest(request, env);
      }

      // Stats API
      if (path === '/api/stats' && method === 'GET') {
        return await handleStatsRequest(env);
      }

      // Channels API
      if (path === '/api/channels' && method === 'GET') {
        return await handleChannelsRequest(env);
      }

      // UI serving
      if (path === '/ui' || path === '/') {
        if (method === 'GET') {
          return handleUIRequest();
        }
      }

      // 404 for unmatched routes
      return errorResponse('Not Found', 404);
    } catch (error) {
      console.error('Unhandled error:', error);
      return errorResponse(
        error instanceof Error ? error.message : 'Internal Server Error',
        500
      );
    }
  },
};
