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
import { searchTranscripts } from './mcp-handler';

// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
 * Handle UI requests - Serve placeholder HTML
 */
function handleUIRequest(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Channel Chat</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    p {
      font-size: 1.5rem;
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Channel Chat</h1>
    <p>UI - Coming Soon</p>
  </div>
</body>
</html>`;

  return withCors(
    new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  );
}

/**
 * Handle MCP protocol requests (placeholder)
 */
function handleMCPRequest(): Response {
  // TODO: Integrate workers-mcp package for full MCP support
  return jsonResponse(
    { error: 'MCP protocol not yet implemented' },
    501
  );
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
      if ((path === '/mcp' || path === '/') && method === 'POST') {
        return handleMCPRequest();
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
