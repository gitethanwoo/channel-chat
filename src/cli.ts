#!/usr/bin/env node
/**
 * CLI module for channel-chat using Commander and Chalk.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from project root
config({ path: resolve(import.meta.dirname, '..', '.env') });

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { mkdtempSync, rmSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

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
import { chunkTranscript, Segment } from './chunker.js';
import { embedBatch } from './embedder.js';
import { search, formatTimestamp } from './search.js';
import {
  getCloudflareConfig,
  uploadToR2,
  indexContent,
  downloadVideo,
  getIndexedVideos,
  CloudflareConfig,
  IndexRequest,
} from './cloudflare-client.js';

const program = new Command();

// Global options
let useCloudflare = false;

/**
 * Index a single video to local database. Returns true on success, false on failure.
 */
async function indexVideoLocal(
  videoId: string,
  channelId: string,
  db: ReturnType<typeof getConnection>,
  tempDir: string,
  spinner?: ReturnType<typeof ora>
): Promise<boolean> {
  try {
    if (spinner) spinner.text = `Getting metadata for ${videoId}...`;
    const videoInfo = await getVideoInfo(videoId);

    if (spinner) spinner.text = `Downloading subtitles for ${videoId}...`;
    const subtitlePath = await downloadSubtitles(videoId, tempDir);

    let segments = null;
    let transcriptSource: string | null = null;

    if (subtitlePath) {
      if (spinner) spinner.text = `Parsing subtitles for ${videoId}...`;
      segments = await parseSubtitles(subtitlePath);
      transcriptSource = 'subtitles';
    } else {
      // No subtitles - try ElevenLabs if API key is set
      if (!process.env.ELEVENLABS_API_KEY) {
        console.log(chalk.yellow(`Skipping ${videoId}: no subtitles (set ELEVENLABS_API_KEY for transcription)`));
        return false;
      }

      if (spinner) spinner.text = `Downloading audio for ${videoId}...`;
      const audioPath = await downloadAudio(videoId, tempDir, (msg) => {
        if (spinner) spinner.text = `${videoId}: ${msg}`;
      });

      if (spinner) spinner.text = `Transcribing ${videoId}...`;
      segments = await transcribeAudio(audioPath);
      transcriptSource = 'transcription';
    }

    if (!segments || segments.length === 0) {
      console.log(chalk.yellow(`Warning: No transcript data for ${videoId}`));
      return false;
    }

    if (spinner) spinner.text = `Chunking transcript for ${videoId}...`;
    const chunks = chunkTranscript(segments, videoInfo.title);

    if (chunks.length === 0) {
      console.log(chalk.yellow(`Warning: No chunks generated for ${videoId}`));
      return false;
    }

    if (spinner) spinner.text = `Generating embeddings for ${videoId}...`;
    const chunkTexts = chunks.map(c => c.text);
    const embeddings = await embedBatch(chunkTexts, 100, false);

    if (spinner) spinner.text = `Storing ${videoId} in database...`;
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

    return true;
  } catch (error) {
    if (error instanceof DownloaderError) {
      console.log(chalk.red(`Error downloading ${videoId}: ${error.message}`));
    } else {
      console.log(chalk.red(`Error processing ${videoId}: ${error}`));
    }
    return false;
  }
}

/**
 * Index a single video to Cloudflare. Returns true on success, false on failure.
 */
async function indexVideoCloudflare(
  videoId: string,
  channelInfo: { channel_id: string; name: string; url: string },
  config: CloudflareConfig,
  tempDir: string,
  spinner?: ReturnType<typeof ora>
): Promise<boolean> {
  try {
    if (spinner) spinner.text = `Getting metadata for ${videoId}...`;
    const videoInfo = await getVideoInfo(videoId);

    // Download subtitles/transcript
    if (spinner) spinner.text = `Downloading subtitles for ${videoId}...`;
    const subtitlePath = await downloadSubtitles(videoId, tempDir);

    let segments: Segment[] | null = null;
    let transcriptSource: string | null = null;

    if (subtitlePath) {
      if (spinner) spinner.text = `Parsing subtitles for ${videoId}...`;
      segments = await parseSubtitles(subtitlePath);
      transcriptSource = 'subtitles';
    } else {
      // No subtitles - try ElevenLabs if API key is set
      if (!process.env.ELEVENLABS_API_KEY) {
        console.log(chalk.yellow(`Skipping ${videoId}: no subtitles (set ELEVENLABS_API_KEY for transcription)`));
        return false;
      }

      if (spinner) spinner.text = `Downloading audio for ${videoId}...`;
      const audioPath = await downloadAudio(videoId, tempDir, (msg) => {
        if (spinner) spinner.text = `${videoId}: ${msg}`;
      });

      if (spinner) spinner.text = `Transcribing ${videoId}...`;
      segments = await transcribeAudio(audioPath);
      transcriptSource = 'transcription';
    }

    if (!segments || segments.length === 0) {
      console.log(chalk.yellow(`Warning: No transcript data for ${videoId}`));
      return false;
    }

    if (spinner) spinner.text = `Chunking transcript for ${videoId}...`;
    const chunks = chunkTranscript(segments, videoInfo.title);

    if (chunks.length === 0) {
      console.log(chalk.yellow(`Warning: No chunks generated for ${videoId}`));
      return false;
    }

    // Download video for R2 upload
    if (spinner) spinner.text = `Downloading video ${videoId}...`;
    const videoPath = await downloadVideo(videoId, tempDir, 720, (msg) => {
      if (spinner) spinner.text = `${videoId}: ${msg}`;
    });

    // Upload video to R2
    if (spinner) spinner.text = `Uploading video to R2...`;
    const r2VideoKey = `videos/${videoId}.mp4`;
    const videoData = await readFile(videoPath);
    await uploadToR2(config, r2VideoKey, videoData, 'video/mp4');

    // Upload transcript to R2
    if (spinner) spinner.text = `Uploading transcript to R2...`;
    const r2TranscriptKey = `transcripts/${videoId}.json`;
    const transcriptData = Buffer.from(JSON.stringify(segments));
    await uploadToR2(config, r2TranscriptKey, transcriptData, 'application/json');

    // Call indexContent API (worker handles embedding generation)
    if (spinner) spinner.text = `Indexing ${videoId} via Cloudflare Worker...`;
    const indexRequest: IndexRequest = {
      channel: {
        id: channelInfo.channel_id,
        name: channelInfo.name,
        url: channelInfo.url,
      },
      video: {
        id: videoInfo.id,
        title: videoInfo.title,
        description: videoInfo.description,
        duration: videoInfo.duration,
        published_at: videoInfo.published_at || undefined,
        thumbnail_url: videoInfo.thumbnail_url || undefined,
        transcript_source: transcriptSource!,
      },
      chunks: chunks.map(c => ({
        seq: c.seq,
        start_time: c.start_time,
        end_time: c.end_time,
        text: c.text,
      })),
      r2_video_key: r2VideoKey,
      r2_transcript_key: r2TranscriptKey,
    };

    const result = await indexContent(config, indexRequest);

    if (!result.success) {
      console.log(chalk.red(`Error indexing ${videoId}: ${result.error}`));
      return false;
    }

    return true;
  } catch (error) {
    if (error instanceof DownloaderError) {
      console.log(chalk.red(`Error downloading ${videoId}: ${error.message}`));
    } else {
      console.log(chalk.red(`Error processing ${videoId}: ${error}`));
    }
    return false;
  }
}

program
  .name('channel-chat')
  .description('Search YouTube channel transcripts with semantic search')
  .version('0.1.0')
  .option('--cloudflare', 'Index to Cloudflare Worker instead of local database')
  .hook('preAction', (thisCommand) => {
    useCloudflare = thisCommand.opts().cloudflare || false;
  });

/**
 * Run tasks with limited concurrency.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];
      results[index] = await fn(item, index);
    }
  }

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

program
  .command('add')
  .description('Add a YouTube channel and index all its videos')
  .argument('<url>', 'YouTube channel URL (e.g., https://www.youtube.com/@channelname)')
  .option('-l, --limit <number>', 'Maximum number of videos to index')
  .option('-c, --concurrency <number>', 'Number of videos to process in parallel', '1')
  .action(async (url: string, options: { limit?: string; concurrency: string }) => {
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    const concurrency = Math.max(1, parseInt(options.concurrency, 10) || 1);
    if (useCloudflare) {
      // Cloudflare indexing path
      let config: CloudflareConfig;
      try {
        config = getCloudflareConfig();
      } catch (error) {
        console.log(chalk.red((error as Error).message));
        return;
      }

      try {
        const spinner = ora('Fetching channel information...').start();
        const channelInfo = await getChannelInfo(url);
        spinner.succeed(`Found channel: ${channelInfo.name}`);

        console.log(chalk.green(`  ID: ${channelInfo.channel_id}`));
        console.log(chalk.green(`  URL: ${channelInfo.url}`));
        console.log(chalk.cyan('  Target: Cloudflare Worker'));

        spinner.start('Fetching video list...');
        // Use channel ID directly for more reliable fetching
        let videoIds = await getChannelVideos(channelInfo.channel_id);
        spinner.succeed(`Found ${videoIds.length} videos`);

        // Apply limit if specified
        if (limit && limit < videoIds.length) {
          console.log(chalk.yellow(`Limiting to ${limit} videos`));
          videoIds = videoIds.slice(0, limit);
        }

        // Check which videos are already indexed
        spinner.start('Checking for already indexed videos...');
        const indexedVideos = await getIndexedVideos(config, channelInfo.channel_id);
        const indexedSet = new Set(indexedVideos);
        const newVideoIds = videoIds.filter(vid => !indexedSet.has(vid));
        const skipped = videoIds.length - newVideoIds.length;
        spinner.succeed(`Found ${indexedVideos.length} already indexed`);

        if (skipped > 0) {
          console.log(chalk.yellow(`Skipping ${skipped} already indexed videos`));
        }

        if (newVideoIds.length === 0) {
          console.log(chalk.green('All videos already indexed!'));
          return;
        }

        console.log(chalk.cyan(`Indexing ${newVideoIds.length} new videos to Cloudflare (concurrency: ${concurrency})...`));

        const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

        try {
          const results = await runWithConcurrency(newVideoIds, concurrency, async (videoId, i) => {
            const progress = `[${i + 1}/${newVideoIds.length}]`;
            const spinner = ora(`${progress} Indexing video...`).start();

            const success = await indexVideoCloudflare(videoId, channelInfo, config, tempDir, spinner);

            if (success) {
              spinner.succeed(`${progress} Indexed successfully`);
              return true;
            } else {
              spinner.fail(`${progress} Failed`);
              return false;
            }
          });

          const indexed = results.filter(Boolean).length;
          const failed = results.length - indexed;

          console.log('');
          console.log(chalk.bold('Indexing Complete (Cloudflare)'));
          console.log(chalk.green(`  Successfully indexed: ${indexed}`));
          console.log(chalk.red(`  Failed: ${failed}`));
          console.log(chalk.yellow(`  Skipped (already indexed): ${skipped}`));
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof DownloaderError) {
          console.log(chalk.red(`Error: ${error.message}`));
        } else {
          throw error;
        }
      }
    } else {
      // Local database indexing path (original behavior)
      const db = getConnection();
      initDb(db);

      try {
        const spinner = ora('Fetching channel information...').start();
        const channelInfo = await getChannelInfo(url);
        spinner.succeed(`Found channel: ${channelInfo.name}`);

        console.log(chalk.green(`  ID: ${channelInfo.channel_id}`));
        console.log(chalk.green(`  URL: ${channelInfo.url}`));
        if (channelInfo.avatar_url) {
          console.log(chalk.green(`  Avatar: ${channelInfo.avatar_url.slice(0, 60)}...`));
        }

        upsertChannel(db, channelInfo.channel_id, channelInfo.name, channelInfo.url, channelInfo.avatar_url);

        spinner.start('Fetching video list...');
        // Use channel ID directly for more reliable fetching
        let videoIds = await getChannelVideos(channelInfo.channel_id);
        spinner.succeed(`Found ${videoIds.length} videos`);

        // Apply limit before filtering existing
        if (limit && limit < videoIds.length) {
          console.log(chalk.yellow(`Limiting to ${limit} videos`));
          videoIds = videoIds.slice(0, limit);
        }

        const newVideoIds = videoIds.filter(vid => !videoExists(db, vid));
        const skipped = videoIds.length - newVideoIds.length;

        if (skipped > 0) {
          console.log(chalk.yellow(`Skipping ${skipped} already indexed videos`));
        }

        if (newVideoIds.length === 0) {
          console.log(chalk.green('All videos already indexed!'));
          return;
        }

        console.log(chalk.cyan(`Indexing ${newVideoIds.length} new videos (concurrency: ${concurrency})...`));

        const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

        try {
          const results = await runWithConcurrency(newVideoIds, concurrency, async (videoId, i) => {
            const progress = `[${i + 1}/${newVideoIds.length}]`;
            const spinner = ora(`${progress} Indexing video...`).start();

            const success = await indexVideoLocal(videoId, channelInfo.channel_id, db, tempDir, spinner);

            if (success) {
              spinner.succeed(`${progress} Indexed successfully`);
              return true;
            } else {
              spinner.fail(`${progress} Failed`);
              return false;
            }
          });

          const indexed = results.filter(Boolean).length;
          const failed = results.length - indexed;

          console.log('');
          console.log(chalk.bold('Indexing Complete'));
          console.log(chalk.green(`  Successfully indexed: ${indexed}`));
          console.log(chalk.red(`  Failed: ${failed}`));
          console.log(chalk.yellow(`  Skipped (already indexed): ${skipped}`));
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof DownloaderError) {
          console.log(chalk.red(`Error: ${error.message}`));
        } else {
          throw error;
        }
      } finally {
        db.close();
      }
    }
  });

program
  .command('search')
  .description('Search across all indexed content')
  .argument('<query>', 'The search text to find in video transcripts')
  .option('-n, --limit <number>', 'Maximum number of results to return', '10')
  .action(async (query: string, options: { limit: string }) => {
    const db = getConnection();
    initDb(db);
    db.close();

    const spinner = ora('Searching...').start();
    const results = await search(query, parseInt(options.limit, 10));
    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow('No results found.'));
      return;
    }

    console.log('');
    console.log(chalk.bold(`Found ${results.length} results for: ${query}`));
    console.log('');

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const timestamp = formatTimestamp(result.start_time);
      const scorePct = (result.score * 100).toFixed(1);

      console.log(chalk.blue.bold(`Result ${i + 1}`));
      console.log(`  ${chalk.dim('Video:')} ${chalk.bold(result.video_title)}`);
      console.log(`  ${chalk.dim('Channel:')} ${result.channel_name}`);
      console.log(`  ${chalk.dim('Time:')} ${chalk.cyan(timestamp)}`);
      console.log(`  ${chalk.dim('Link:')} ${result.youtube_url}`);
      console.log(`  ${chalk.dim('Score:')} ${chalk.green(scorePct + '%')}`);

      // Truncate text preview
      let textPreview = result.text;
      if (textPreview.includes('|')) {
        textPreview = textPreview.split('|').slice(1).join('|').trim();
      }
      if (textPreview.length > 300) {
        textPreview = textPreview.slice(0, 297) + '...';
      }
      console.log(`  ${chalk.italic(textPreview)}`);
      console.log('');
    }
  });

program
  .command('list')
  .description('List all indexed channels')
  .option('-v, --verbose', 'Show videos for each channel')
  .action((options: { verbose?: boolean }) => {
    const db = getConnection();
    initDb(db);

    try {
      const channels = listChannels(db);

      if (channels.length === 0) {
        console.log(chalk.yellow('No channels indexed yet.'));
        console.log(`Use ${chalk.cyan('channel-chat add <url>')} to add a channel.`);
        return;
      }

      const table = new Table({
        head: ['Name', 'ID', 'Videos', 'Indexed At'],
        style: { head: ['cyan'] },
      });

      for (const channel of channels) {
        const videos = listVideos(db, channel.id);
        table.push([
          channel.name,
          channel.id,
          videos.length.toString(),
          channel.indexed_at || 'N/A',
        ]);
      }

      console.log(table.toString());

      if (options.verbose) {
        console.log('');
        for (const channel of channels) {
          const videos = listVideos(db, channel.id);
          if (videos.length > 0) {
            console.log(chalk.bold(`Videos: ${channel.name}`));

            const videoTable = new Table({
              head: ['Title', 'ID', 'Duration', 'Source'],
              style: { head: ['cyan'] },
              colWidths: [50, 15, 10, 15],
            });

            for (const video of videos) {
              const title = video.title.length > 47 ? video.title.slice(0, 44) + '...' : video.title;
              const duration = video.duration ? formatTimestamp(video.duration) : 'N/A';
              videoTable.push([
                title,
                video.id,
                duration,
                video.transcript_source || 'N/A',
              ]);
            }

            console.log(videoTable.toString());
            console.log('');
          }
        }
      }
    } finally {
      db.close();
    }
  });

program
  .command('index-video')
  .description('Re-index a specific video')
  .argument('<video_id>', 'YouTube video ID (e.g., dQw4w9WgXcQ)')
  .action(async (videoId: string) => {
    if (useCloudflare) {
      // Cloudflare indexing path
      let config: CloudflareConfig;
      try {
        config = getCloudflareConfig();
      } catch (error) {
        console.log(chalk.red((error as Error).message));
        return;
      }

      try {
        const spinner = ora('Getting video information...').start();
        const videoInfo = await getVideoInfo(videoId);
        const channelId = videoInfo.channel_id;
        spinner.succeed('Got video information');

        if (!channelId) {
          console.log(chalk.red('Error: Could not determine channel ID for video'));
          return;
        }

        // Get channel info
        const channelUrl = `https://www.youtube.com/channel/${channelId}`;
        let channelInfo: { channel_id: string; name: string; url: string };
        try {
          channelInfo = await getChannelInfo(channelUrl);
        } catch {
          channelInfo = { channel_id: channelId, name: 'Unknown Channel', url: channelUrl };
        }

        console.log(chalk.cyan('  Target: Cloudflare Worker'));

        const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

        try {
          const spinner = ora('Indexing video to Cloudflare...').start();
          const success = await indexVideoCloudflare(videoId, channelInfo, config, tempDir, spinner);

          if (success) {
            spinner.succeed(`Successfully indexed video ${videoId} to Cloudflare`);
          } else {
            spinner.fail(`Failed to index video ${videoId}`);
          }
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof DownloaderError) {
          console.log(chalk.red(`Error: ${error.message}`));
        } else {
          throw error;
        }
      }
    } else {
      // Local database indexing path (original behavior)
      const db = getConnection();
      initDb(db);

      try {
        const existing = getVideo(db, videoId);
        let channelId: string;

        if (existing) {
          channelId = existing.channel_id;
          console.log(chalk.yellow('Found existing video. Re-indexing...'));

          const spinner = ora('Deleting existing chunks...').start();
          deleteVideoChunks(db, videoId);
          spinner.succeed('Deleted existing chunks');
        } else {
          const spinner = ora('Getting video information...').start();
          const videoInfo = await getVideoInfo(videoId);
          channelId = videoInfo.channel_id;
          spinner.succeed('Got video information');

          if (channelId) {
            const channelUrl = `https://www.youtube.com/channel/${channelId}`;
            try {
              const channelInfo = await getChannelInfo(channelUrl);
              upsertChannel(db, channelInfo.channel_id, channelInfo.name, channelInfo.url, channelInfo.avatar_url);
            } catch {
              upsertChannel(db, channelId, 'Unknown Channel', channelUrl, null);
            }
          }
        }

        if (!channelId) {
          console.log(chalk.red('Error: Could not determine channel ID for video'));
          return;
        }

        const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

        try {
          const spinner = ora('Indexing video...').start();
          const success = await indexVideoLocal(videoId, channelId, db, tempDir, spinner);

          if (success) {
            spinner.succeed(`Successfully indexed video ${videoId}`);
          } else {
            spinner.fail(`Failed to index video ${videoId}`);
          }
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof DownloaderError) {
          console.log(chalk.red(`Error: ${error.message}`));
        } else {
          throw error;
        }
      } finally {
        db.close();
      }
    }
  });

program
  .command('cloudflare-setup')
  .description('Print setup instructions for Cloudflare integration')
  .action(() => {
    console.log(chalk.bold.cyan('\nCloudflare Setup Instructions\n'));
    console.log(chalk.bold('1. Required Environment Variables:\n'));
    console.log('   Add these to your .env file:\n');
    console.log(chalk.yellow('   CLOUDFLARE_WORKER_URL=https://channel-chat.<your-account>.workers.dev'));
    console.log(chalk.yellow('   CLOUDFLARE_ACCOUNT_ID=<your-account-id>'));
    console.log(chalk.yellow('   CLOUDFLARE_R2_BUCKET=channel-chat-media'));
    console.log(chalk.yellow('   CLOUDFLARE_R2_ACCESS_KEY_ID=<your-r2-access-key-id>'));
    console.log(chalk.yellow('   CLOUDFLARE_R2_SECRET_ACCESS_KEY=<your-r2-secret-access-key>'));

    console.log(chalk.bold('\n2. Create Cloudflare Resources:\n'));
    console.log('   a. Deploy the worker:');
    console.log(chalk.dim('      cd cloudflare && npm install && npx wrangler deploy'));
    console.log('');
    console.log('   b. Create the D1 database:');
    console.log(chalk.dim('      npx wrangler d1 create channel-chat'));
    console.log(chalk.dim('      # Update wrangler.toml with the database_id'));
    console.log(chalk.dim('      npx wrangler d1 execute channel-chat --file=./schema.sql'));
    console.log('');
    console.log('   c. Create the R2 bucket:');
    console.log(chalk.dim('      npx wrangler r2 bucket create channel-chat-media'));
    console.log('');
    console.log('   d. Create the Vectorize index:');
    console.log(chalk.dim('      npx wrangler vectorize create channel-chat-embeddings --dimensions=768 --metric=cosine'));
    console.log('');
    console.log('   e. Create R2 API token:');
    console.log(chalk.dim('      Go to Cloudflare Dashboard > R2 > Manage R2 API Tokens'));
    console.log(chalk.dim('      Create a token with read/write permissions for your bucket'));

    console.log(chalk.bold('\n3. Test the Worker:\n'));
    console.log('   Check stats:');
    console.log(chalk.dim('   curl https://channel-chat.<your-account>.workers.dev/api/stats'));
    console.log('');
    console.log('   List channels:');
    console.log(chalk.dim('   curl https://channel-chat.<your-account>.workers.dev/api/channels'));

    console.log(chalk.bold('\n4. Index Content:\n'));
    console.log('   Once configured, use the --cloudflare flag:');
    console.log(chalk.cyan('   channel-chat --cloudflare add https://www.youtube.com/@channelname'));
    console.log(chalk.cyan('   channel-chat --cloudflare index-video dQw4w9WgXcQ'));
    console.log('');
  });

program
  .command('mcp')
  .description('Set up the MCP server for Claude Code integration')
  .option('--install', 'Run the install command directly')
  .action((options: { install?: boolean }) => {
    // Use the wrapper script that loads .env automatically
    const binPath = join(dirname(process.argv[1]), '..', 'bin', 'channel-chat-mcp');

    const cmd = `claude mcp add channel-chat -- node ${binPath}`;

    if (options.install) {
      console.log(chalk.cyan(`Running: ${cmd}`));

      const child = spawn('claude', ['mcp', 'add', 'channel-chat', '--', 'node', binPath], {
        stdio: 'inherit',
        shell: true,
      });

      child.on('close', (code) => {
        if (code === 0) {
          console.log(chalk.green('MCP server installed! Restart Claude Code to use it.'));
        } else {
          console.log(chalk.red('Installation failed. Try running the command manually.'));
        }
      });
    } else {
      console.log(chalk.bold('To add channel-chat to Claude Code:'));
      console.log('');
      console.log(`  ${cmd}`);
      console.log('');
      console.log(`Or run ${chalk.cyan('channel-chat mcp --install')} to do it automatically.`);
      console.log('');
      console.log(chalk.dim('The server auto-loads .env from the project root.'));
    }
  });

program.parse();
