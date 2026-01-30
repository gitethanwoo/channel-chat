/**
 * Cloudflare client module for R2 storage and Worker communication.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

/**
 * Configuration for Cloudflare services.
 */
export interface CloudflareConfig {
  /** Worker URL (e.g., "https://channel-chat.your-account.workers.dev") */
  workerUrl: string;
  /** Cloudflare account ID */
  accountId: string;
  /** R2 bucket name */
  r2BucketName: string;
  /** R2 Access Key ID (from API token) */
  r2AccessKeyId: string;
  /** R2 Secret Access Key (from API token) */
  r2SecretAccessKey: string;
  /** Worker API key for authenticated endpoints (optional) */
  workerApiKey?: string;
}

/**
 * Channel information for indexing.
 */
export interface IndexChannel {
  id: string;
  name: string;
  url: string;
}

/**
 * Video information for indexing.
 */
export interface IndexVideo {
  id: string;
  title: string;
  description?: string;
  duration?: number;
  published_at?: string;
  thumbnail_url?: string;
  transcript_source: string;
}

/**
 * Chunk information for indexing.
 */
export interface IndexChunk {
  seq: number;
  start_time: number;
  end_time: number;
  text: string;
}

/**
 * Request payload for the index endpoint.
 */
export interface IndexRequest {
  channel: IndexChannel;
  video: IndexVideo;
  chunks: IndexChunk[];
  r2_video_key?: string;
  r2_transcript_key?: string;
}

/**
 * Response from the index endpoint.
 */
export interface IndexResponse {
  success: boolean;
  video_id?: string;
  chunks_indexed?: number;
  error?: string;
}

/**
 * Get Cloudflare configuration from environment variables.
 * @throws Error if required environment variables are missing.
 */
export function getCloudflareConfig(): CloudflareConfig {
  const workerUrl = process.env.CLOUDFLARE_WORKER_URL;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const r2BucketName = process.env.CLOUDFLARE_R2_BUCKET;
  const r2AccessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const workerApiKey = process.env.CLOUDFLARE_WORKER_API_KEY;

  const missing: string[] = [];

  if (!workerUrl) missing.push('CLOUDFLARE_WORKER_URL');
  if (!accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!r2BucketName) missing.push('CLOUDFLARE_R2_BUCKET');
  if (!r2AccessKeyId) missing.push('CLOUDFLARE_R2_ACCESS_KEY_ID');
  if (!r2SecretAccessKey) missing.push('CLOUDFLARE_R2_SECRET_ACCESS_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required Cloudflare environment variables:\n  ${missing.join('\n  ')}\n\n` +
      'Run "channel-chat cloudflare-setup" for setup instructions.'
    );
  }

  return {
    workerUrl: workerUrl!,
    accountId: accountId!,
    r2BucketName: r2BucketName!,
    r2AccessKeyId: r2AccessKeyId!,
    r2SecretAccessKey: r2SecretAccessKey!,
    workerApiKey,
  };
}

/**
 * Create an S3 client configured for Cloudflare R2.
 */
function createR2Client(config: CloudflareConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

/**
 * Upload a file to Cloudflare R2.
 * @param config - Cloudflare configuration
 * @param key - The R2 object key (path)
 * @param data - File data as Buffer or ReadableStream
 * @param contentType - MIME type of the content
 * @returns The R2 key on success
 */
export async function uploadToR2(
  config: CloudflareConfig,
  key: string,
  data: Buffer | ReadableStream,
  contentType: string
): Promise<string> {
  const client = createR2Client(config);

  try {
    const command = new PutObjectCommand({
      Bucket: config.r2BucketName,
      Key: key,
      Body: data,
      ContentType: contentType,
    });

    await client.send(command);
    return key;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to upload to R2 (key: ${key}): ${errorMessage}`);
  } finally {
    client.destroy();
  }
}

/**
 * Index content via the Cloudflare Worker.
 * @param config - Cloudflare configuration
 * @param request - Index request payload
 * @returns Response with success status and indexed count
 */
export async function indexContent(
  config: CloudflareConfig,
  request: IndexRequest
): Promise<IndexResponse> {
  const url = `${config.workerUrl}/api/index`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add Authorization header if API key is configured
  if (config.workerApiKey) {
    headers['Authorization'] = `Bearer ${config.workerApiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      return {
        success: false,
        error: (errorData as { error?: string }).error || response.statusText,
      };
    }

    const result = await response.json() as IndexResponse;
    return {
      success: result.success ?? true,
      video_id: result.video_id,
      chunks_indexed: result.chunks_indexed,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to index content: ${errorMessage}`,
    };
  }
}

/**
 * Download a video file using yt-dlp.
 * Returns the path to the downloaded video.
 * @param videoId - YouTube video ID
 * @param outputDir - Directory to save the video
 * @param maxHeight - Maximum video height (default: 720)
 * @param onProgress - Optional callback for progress updates
 */
export async function downloadVideo(
  videoId: string,
  outputDir: string,
  maxHeight: number = 720,
  onProgress?: (message: string) => void
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${videoId}.mp4`);

  // Format string: best video up to maxHeight + best audio, fallback to combined
  // Don't filter by ext since many videos only have m3u8/HLS streams
  const formatStr = `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`;

  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', [
      '-f', formatStr,
      '--merge-output-format', 'mp4',
      '--progress',
      '--newline',
      '-o', outputPath,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      const line = data.toString().trim();
      // Parse progress line like "[download]  45.2% of 50.00MiB at 2.50MiB/s"
      if (onProgress && line.includes('%')) {
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) {
          onProgress(`Downloading video: ${match[1]}%`);
        }
      }
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`Failed to download video: ${stderr}`));
      }
    });

    ytdlp.on('error', (err) => {
      reject(new Error(`yt-dlp not found. Install it with: pip install yt-dlp. Error: ${err.message}`));
    });
  });
}

/**
 * Check if Cloudflare environment variables are configured.
 */
export function isCloudflareConfigured(): boolean {
  return !!(
    process.env.CLOUDFLARE_WORKER_URL &&
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_R2_BUCKET &&
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID &&
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY
  );
}

/**
 * Get list of already-indexed video IDs from Cloudflare.
 * @param config - Cloudflare configuration
 * @param channelId - Optional channel ID to filter by
 * @returns Array of video IDs
 */
export async function getIndexedVideos(
  config: CloudflareConfig,
  channelId?: string
): Promise<string[]> {
  const url = new URL(`${config.workerUrl}/api/videos`);
  if (channelId) {
    url.searchParams.set('channel_id', channelId);
  }

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      console.warn(`Failed to fetch indexed videos: ${response.statusText}`);
      return [];
    }
    return await response.json() as string[];
  } catch (error) {
    console.warn(`Failed to fetch indexed videos: ${error}`);
    return [];
  }
}
