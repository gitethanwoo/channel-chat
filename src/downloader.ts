/**
 * YouTube downloader module using youtubei.js
 */

import { Innertube } from 'youtubei.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

// Custom error types
export class DownloaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloaderError';
  }
}

export class ChannelNotFoundError extends DownloaderError {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelNotFoundError';
  }
}

export class VideoNotFoundError extends DownloaderError {
  constructor(message: string) {
    super(message);
    this.name = 'VideoNotFoundError';
  }
}

export class SubtitleNotFoundError extends DownloaderError {
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleNotFoundError';
  }
}

export class AudioDownloadError extends DownloaderError {
  constructor(message: string) {
    super(message);
    this.name = 'AudioDownloadError';
  }
}

// Types
export interface ChannelInfo {
  channel_id: string;
  name: string;
  url: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  description: string;
  duration: number;
  published_at: string | null;
  thumbnail_url: string | null;
  channel_id: string;
}

// Singleton Innertube instance
let _innertube: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  if (!_innertube) {
    _innertube = await Innertube.create();
  }
  return _innertube;
}

/**
 * Extract channel ID from various URL formats
 */
function extractChannelIdentifier(url: string): { type: 'id' | 'handle' | 'vanity'; value: string } {
  // Handle @username format
  const handleMatch = url.match(/@([^\/\?]+)/);
  if (handleMatch) {
    return { type: 'handle', value: handleMatch[1] };
  }

  // Handle /channel/ID format
  const channelIdMatch = url.match(/\/channel\/([^\/\?]+)/);
  if (channelIdMatch) {
    return { type: 'id', value: channelIdMatch[1] };
  }

  // Handle /c/vanity or /user/name format
  const vanityMatch = url.match(/\/(c|user)\/([^\/\?]+)/);
  if (vanityMatch) {
    return { type: 'vanity', value: vanityMatch[2] };
  }

  throw new ChannelNotFoundError(`Could not parse channel URL: ${url}`);
}

/**
 * Get channel information from a YouTube channel URL.
 */
export async function getChannelInfo(url: string): Promise<ChannelInfo> {
  try {
    const yt = await getInnertube();
    const identifier = extractChannelIdentifier(url);

    let channel;
    if (identifier.type === 'handle') {
      channel = await yt.getChannel(`@${identifier.value}`);
    } else if (identifier.type === 'id') {
      channel = await yt.getChannel(identifier.value);
    } else {
      // Try as handle first, then as channel id
      try {
        channel = await yt.getChannel(identifier.value);
      } catch {
        channel = await yt.getChannel(`@${identifier.value}`);
      }
    }

    if (!channel || !channel.metadata) {
      throw new ChannelNotFoundError(`Could not find channel: ${url}`);
    }

    const metadata = channel.metadata;
    return {
      channel_id: metadata.external_id || '',
      name: metadata.title || '',
      url: metadata.vanity_channel_url || url,
    };
  } catch (error) {
    if (error instanceof ChannelNotFoundError) throw error;
    throw new ChannelNotFoundError(`Failed to fetch channel info: ${error}`);
  }
}

/**
 * Get all video IDs from a YouTube channel.
 */
export async function getChannelVideos(channelUrl: string): Promise<string[]> {
  try {
    const yt = await getInnertube();
    const identifier = extractChannelIdentifier(channelUrl);

    let channel;
    if (identifier.type === 'handle') {
      channel = await yt.getChannel(`@${identifier.value}`);
    } else if (identifier.type === 'id') {
      channel = await yt.getChannel(identifier.value);
    } else {
      channel = await yt.getChannel(identifier.value);
    }

    if (!channel) {
      throw new ChannelNotFoundError(`Could not find channel: ${channelUrl}`);
    }

    // Get videos tab
    const videosTab = await channel.getVideos();
    const videoIds: string[] = [];

    // Get all videos (including continuation)
    let videos: typeof videosTab | Awaited<ReturnType<typeof videosTab.getContinuation>> = videosTab;
    while (videos) {
      for (const video of videos.videos) {
        if (video && 'id' in video && video.id) {
          videoIds.push(video.id);
        }
      }

      if (!videos.has_continuation) break;
      videos = await videos.getContinuation();
    }

    return videoIds;
  } catch (error) {
    if (error instanceof ChannelNotFoundError) throw error;
    throw new ChannelNotFoundError(`Failed to fetch channel videos: ${error}`);
  }
}

/**
 * Get metadata for a specific video.
 */
export async function getVideoInfo(videoId: string): Promise<VideoInfo> {
  try {
    const yt = await getInnertube();
    const info = await yt.getBasicInfo(videoId);

    if (!info || !info.basic_info) {
      throw new VideoNotFoundError(`Could not get info for video: ${videoId}`);
    }

    const basic = info.basic_info;

    // Get best thumbnail
    let thumbnailUrl: string | null = null;
    if (basic.thumbnail && basic.thumbnail.length > 0) {
      // Get the highest resolution thumbnail
      const sortedThumbnails = [...basic.thumbnail].sort((a, b) => (b.width || 0) - (a.width || 0));
      thumbnailUrl = sortedThumbnails[0].url;
    }

    return {
      id: basic.id || videoId,
      title: basic.title || '',
      description: basic.short_description || '',
      duration: basic.duration || 0,
      published_at: null, // Basic info doesn't include this
      thumbnail_url: thumbnailUrl,
      channel_id: basic.channel_id || '',
    };
  } catch (error) {
    if (error instanceof VideoNotFoundError) throw error;
    throw new VideoNotFoundError(`Failed to fetch video info: ${error}`);
  }
}

/**
 * Download subtitles for a video.
 * Returns path to the downloaded subtitle file, or null if no subtitles available.
 */
export async function downloadSubtitles(videoId: string, outputDir: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);

    if (!info) {
      return null;
    }

    // Get captions
    const captions = info.captions;
    if (!captions || !captions.caption_tracks || captions.caption_tracks.length === 0) {
      return null;
    }

    // Prefer English captions
    const englishLangs = ['en', 'en-US', 'en-GB', 'a.en']; // a.en for auto-generated
    let selectedTrack = null;

    // First try manual English subtitles
    for (const lang of englishLangs.slice(0, 3)) {
      selectedTrack = captions.caption_tracks.find(
        t => t.language_code === lang && !t.kind?.includes('asr')
      );
      if (selectedTrack) break;
    }

    // Fall back to auto-generated English
    if (!selectedTrack) {
      selectedTrack = captions.caption_tracks.find(
        t => t.language_code.startsWith('en') || t.language_code === 'a.en'
      );
    }

    // Fall back to any available track
    if (!selectedTrack && captions.caption_tracks.length > 0) {
      selectedTrack = captions.caption_tracks[0];
    }

    if (!selectedTrack || !selectedTrack.base_url) {
      return null;
    }

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Fetch the captions (in SRV3/timedtext format by default)
    // We need to request VTT format
    const captionUrl = new URL(selectedTrack.base_url);
    captionUrl.searchParams.set('fmt', 'vtt');

    const response = await fetch(captionUrl.toString());
    if (!response.ok) {
      return null;
    }

    const vttContent = await response.text();
    const outputPath = join(outputDir, `${videoId}.en.vtt`);
    await writeFile(outputPath, vttContent, 'utf-8');

    return outputPath;
  } catch (error) {
    throw new DownloaderError(`Failed to download subtitles: ${error}`);
  }
}

/**
 * Download audio from a video for transcription.
 * Uses yt-dlp as a fallback since youtubei.js audio download is complex.
 */
export async function downloadAudio(videoId: string, outputDir: string): Promise<string> {
  const { spawn } = await import('child_process');

  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${videoId}.mp3`);

  // Check if yt-dlp is available
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '-o', outputPath,
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    let stderr = '';
    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new AudioDownloadError(`Failed to download audio: ${stderr}`));
      }
    });

    ytdlp.on('error', (err) => {
      reject(new AudioDownloadError(`yt-dlp not found. Install it with: pip install yt-dlp. Error: ${err.message}`));
    });
  });
}
