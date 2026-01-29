/**
 * Indexing API module.
 * Handles the POST /api/index endpoint for indexing new content from the local CLI.
 */

import type { Env, IndexRequest, VideoRow } from './types';
import {
  upsertChannel,
  upsertVideo,
  deleteVideoChunks,
  insertChunk,
  updateChunkVectorizeId,
  getVideoChunks,
  deleteVideo,
} from './db';
import { generateEmbeddings, upsertVectors, deleteVectors } from './vectorize';

/**
 * Handle POST /api/index - Index new content from the local CLI
 */
export async function handleIndexRequest(
  env: Env,
  request: Request
): Promise<Response> {
  try {
    // Parse JSON body
    let body: IndexRequest;
    try {
      body = (await request.json()) as IndexRequest;
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate required fields
    const validationError = validateIndexRequest(body);
    if (validationError) {
      return new Response(
        JSON.stringify({ error: validationError }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Upsert channel to D1
    await upsertChannel(env.DB, body.channel);

    // Upsert video to D1
    const videoRow: VideoRow = {
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
    };
    await upsertVideo(env.DB, videoRow);

    // Delete existing chunks for this video (for re-indexing)
    await deleteVideoChunks(env.DB, body.video.id);

    // Insert chunks and collect info for vectorization
    const chunkInfos: Array<{ chunkId: number; vectorizeId: string; text: string }> = [];

    for (const chunk of body.chunks) {
      // Insert chunk to D1
      const chunkId = await insertChunk(env.DB, {
        video_id: body.video.id,
        seq: chunk.seq,
        start_time: chunk.start_time,
        end_time: chunk.end_time,
        text: chunk.text,
      });

      // Generate unique vectorize_id
      const vectorizeId = `${body.video.id}_${chunk.seq}`;

      chunkInfos.push({
        chunkId,
        vectorizeId,
        text: chunk.text,
      });
    }

    // Generate embeddings for all chunk texts in batch
    const texts = chunkInfos.map((info) => info.text);
    const embeddings = await generateEmbeddings(env.AI, texts);

    // Prepare vectors for batch upsert
    const vectors = chunkInfos.map((info, index) => ({
      id: info.vectorizeId,
      embedding: embeddings[index],
      metadata: { video_id: body.video.id },
    }));

    // Upsert vectors to Vectorize
    await upsertVectors(env.VECTORIZE, vectors);

    // Update chunks with vectorize_ids
    for (const info of chunkInfos) {
      await updateChunkVectorizeId(env.DB, info.chunkId, info.vectorizeId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        channel_id: body.channel.id,
        video_id: body.video.id,
        chunks_indexed: chunkInfos.length,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in handleIndexRequest:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle DELETE /api/videos/:videoId - Delete a video and its chunks
 */
export async function handleDeleteVideo(
  env: Env,
  videoId: string
): Promise<Response> {
  try {
    // Get all chunks for video from D1
    const chunks = await getVideoChunks(env.DB, videoId);

    // Collect vectorize_ids for deletion
    const vectorizeIds = chunks
      .map((chunk) => chunk.vectorize_id)
      .filter((id): id is string => id !== null);

    // Delete vectors from Vectorize
    if (vectorizeIds.length > 0) {
      await deleteVectors(env.VECTORIZE, vectorizeIds);
    }

    // Delete chunks from D1
    await deleteVideoChunks(env.DB, videoId);

    // Delete video from D1
    await deleteVideo(env.DB, videoId);

    return new Response(
      JSON.stringify({
        success: true,
        video_id: videoId,
        chunks_deleted: chunks.length,
        vectors_deleted: vectorizeIds.length,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error in handleDeleteVideo:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Validate the IndexRequest body and return an error message if invalid.
 */
function validateIndexRequest(body: IndexRequest): string | null {
  if (!body.channel) {
    return 'Missing required field: channel';
  }
  if (!body.channel.id) {
    return 'Missing required field: channel.id';
  }
  if (!body.channel.name) {
    return 'Missing required field: channel.name';
  }
  if (!body.video) {
    return 'Missing required field: video';
  }
  if (!body.video.id) {
    return 'Missing required field: video.id';
  }
  if (!body.video.title) {
    return 'Missing required field: video.title';
  }
  if (!Array.isArray(body.chunks)) {
    return 'Missing required field: chunks (must be an array)';
  }
  if (body.chunks.length === 0) {
    return 'chunks array cannot be empty';
  }

  // Validate each chunk
  for (let i = 0; i < body.chunks.length; i++) {
    const chunk = body.chunks[i];
    if (typeof chunk.seq !== 'number') {
      return `Invalid chunk at index ${i}: missing or invalid seq`;
    }
    if (typeof chunk.start_time !== 'number') {
      return `Invalid chunk at index ${i}: missing or invalid start_time`;
    }
    if (typeof chunk.end_time !== 'number') {
      return `Invalid chunk at index ${i}: missing or invalid end_time`;
    }
    if (typeof chunk.text !== 'string' || chunk.text.trim() === '') {
      return `Invalid chunk at index ${i}: missing or empty text`;
    }
  }

  return null;
}
