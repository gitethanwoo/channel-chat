/**
 * YouTube downloader module using youtubei.js
 */

import { Innertube } from 'youtubei.js';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
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
  avatar_url: string | null;
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
    if (identifier.type === 'id') {
      // Channel ID is most reliable
      channel = await yt.getChannel(identifier.value);
    } else if (identifier.type === 'handle') {
      // Try handle with @ prefix, fall back to resolving via search if needed
      try {
        channel = await yt.getChannel(`@${identifier.value}`);
      } catch {
        // Handle lookup failed, try without @
        channel = await yt.getChannel(identifier.value);
      }
    } else {
      // Vanity URL - try as-is first, then with @
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

    // Get best avatar URL
    let avatarUrl: string | null = null;
    if (metadata.avatar && Array.isArray(metadata.avatar) && metadata.avatar.length > 0) {
      // Sort by width descending to get highest resolution
      const sortedAvatars = [...metadata.avatar].sort((a: any, b: any) => (b.width || 0) - (a.width || 0));
      avatarUrl = sortedAvatars[0].url || null;
    }

    return {
      channel_id: metadata.external_id || '',
      name: metadata.title || '',
      url: metadata.vanity_channel_url || url,
      avatar_url: avatarUrl,
    };
  } catch (error) {
    if (error instanceof ChannelNotFoundError) throw error;
    throw new ChannelNotFoundError(`Failed to fetch channel info: ${error}`);
  }
}

/**
 * Get all video IDs from a YouTube channel.
 * @param channelUrlOrId - Channel URL or channel ID (UC...)
 */
export async function getChannelVideos(channelUrlOrId: string): Promise<string[]> {
  try {
    const yt = await getInnertube();

    let channel;
    // If it looks like a channel ID (starts with UC), use it directly
    if (channelUrlOrId.startsWith('UC') && !channelUrlOrId.includes('/')) {
      channel = await yt.getChannel(channelUrlOrId);
    } else {
      const identifier = extractChannelIdentifier(channelUrlOrId);

      if (identifier.type === 'handle') {
        // Handle lookups can be flaky, try channel ID format first if we can extract it
        channel = await yt.getChannel(`@${identifier.value}`);
      } else if (identifier.type === 'id') {
        channel = await yt.getChannel(identifier.value);
      } else {
        channel = await yt.getChannel(identifier.value);
      }
    }

    if (!channel) {
      throw new ChannelNotFoundError(`Could not find channel: ${channelUrlOrId}`);
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
 * Download subtitles for a video using yt-dlp via Python.
 * Returns path to the downloaded subtitle file, or null if no subtitles available.
 */
export async function downloadSubtitles(videoId: string, outputDir: string): Promise<string | null> {
  const { spawn } = await import('child_process');
  const { readdir } = await import('fs/promises');

  await mkdir(outputDir, { recursive: true });

  const pythonScript = `
import yt_dlp
import sys

video_id = sys.argv[1]
output_dir = sys.argv[2]

opts = {
    'quiet': True,
    'no_warnings': True,
    'writesubtitles': True,
    'writeautomaticsub': False,
    'subtitleslangs': ['en', 'en-US', 'en-GB'],
    'subtitlesformat': 'vtt/srt/best',
    'skip_download': True,
    'outtmpl': f'{output_dir}/{video_id}.%(ext)s',
}

video_url = f'https://www.youtube.com/watch?v={video_id}'

try:
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(video_url, download=False)
        subtitles = info.get('subtitles', {})
        has_manual = any(lang in subtitles for lang in ['en', 'en-US', 'en-GB'])

        if has_manual:
            ydl.download([video_url])
        else:
            opts['writesubtitles'] = False
            opts['writeautomaticsub'] = True
            opts['subtitleslangs'] = ['en', 'en-orig', 'en-US', 'en-GB']
            with yt_dlp.YoutubeDL(opts) as ydl_auto:
                auto_info = ydl_auto.extract_info(video_url, download=False)
                auto_subs = auto_info.get('automatic_captions', {})
                if any(lang in auto_subs for lang in ['en', 'en-orig', 'en-US', 'en-GB']):
                    ydl_auto.download([video_url])
except Exception as e:
    pass
`;

  // Find Python with yt-dlp - use PYTHON_PATH env var or try common locations
  const pythonFromEnv = process.env.PYTHON_PATH || process.env.CHANNEL_CHAT_PYTHON;
  // import.meta.dirname is the src/ directory, so parent has the .venv
  const projectRoot = dirname(import.meta.dirname);
  const pythonPaths = [
    ...(pythonFromEnv ? [pythonFromEnv] : []),
    join(projectRoot, '.venv', 'bin', 'python'),
    join(dirname(dirname(process.cwd())), '.venv', 'bin', 'python'),
    join(dirname(process.cwd()), '.venv', 'bin', 'python'),
    join(process.cwd(), '.venv', 'bin', 'python'),
    'python3',
    'python',
  ];

  return new Promise((resolve) => {
    const tryPython = (index: number) => {
      if (index >= pythonPaths.length) {
        resolve(null);
        return;
      }

      const pythonPath = pythonPaths[index];
      const python = spawn(pythonPath, ['-c', pythonScript, videoId, outputDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      python.on('close', async () => {
        // Find the subtitle file
        try {
          const files = await readdir(outputDir);
          for (const file of files) {
            if (file.startsWith(videoId) && (file.endsWith('.vtt') || file.endsWith('.srt'))) {
              resolve(join(outputDir, file));
              return;
            }
          }
        } catch {}
        resolve(null);
      });

      python.on('error', () => tryPython(index + 1));
    };

    tryPython(0);
  });
}

/**
 * Download audio from a video for transcription.
 * Uses yt-dlp as a fallback since youtubei.js audio download is complex.
 * @param videoId - YouTube video ID
 * @param outputDir - Directory to save the audio
 * @param onProgress - Optional callback for progress updates
 */
export async function downloadAudio(
  videoId: string,
  outputDir: string,
  onProgress?: (message: string) => void
): Promise<string> {
  const { spawn } = await import('child_process');

  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${videoId}.mp3`);

  // Download audio only (much faster than full video + extract)
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--progress',
      '--newline',
      '-o', outputPath,
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (onProgress && line.includes('%')) {
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) {
          onProgress(`Downloading audio: ${match[1]}%`);
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
        reject(new AudioDownloadError(`Failed to download audio: ${stderr}`));
      }
    });

    ytdlp.on('error', (err) => {
      reject(new AudioDownloadError(`yt-dlp not found. Install it with: pip install yt-dlp. Error: ${err.message}`));
    });
  });
}
