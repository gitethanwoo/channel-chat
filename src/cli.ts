#!/usr/bin/env node
/**
 * CLI module for channel-chat using Commander and Chalk.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
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
import { chunkTranscript } from './chunker.js';
import { embedBatch } from './embedder.js';
import { search, formatTimestamp } from './search.js';

const program = new Command();

/**
 * Index a single video. Returns true on success, false on failure.
 */
async function indexVideo(
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
      const audioPath = await downloadAudio(videoId, tempDir);

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

program
  .name('channel-chat')
  .description('Search YouTube channel transcripts with semantic search')
  .version('0.1.0');

program
  .command('add')
  .description('Add a YouTube channel and index all its videos')
  .argument('<url>', 'YouTube channel URL (e.g., https://www.youtube.com/@channelname)')
  .action(async (url: string) => {
    const db = getConnection();
    initDb(db);

    try {
      const spinner = ora('Fetching channel information...').start();
      const channelInfo = await getChannelInfo(url);
      spinner.succeed(`Found channel: ${channelInfo.name}`);

      console.log(chalk.green(`  ID: ${channelInfo.channel_id}`));
      console.log(chalk.green(`  URL: ${channelInfo.url}`));

      upsertChannel(db, channelInfo.channel_id, channelInfo.name, channelInfo.url);

      spinner.start('Fetching video list...');
      const videoIds = await getChannelVideos(channelInfo.url);
      spinner.succeed(`Found ${videoIds.length} videos`);

      const newVideoIds = videoIds.filter(vid => !videoExists(db, vid));
      const skipped = videoIds.length - newVideoIds.length;

      if (skipped > 0) {
        console.log(chalk.yellow(`Skipping ${skipped} already indexed videos`));
      }

      if (newVideoIds.length === 0) {
        console.log(chalk.green('All videos already indexed!'));
        return;
      }

      console.log(chalk.cyan(`Indexing ${newVideoIds.length} new videos...`));

      const tempDir = mkdtempSync(join(tmpdir(), 'channel-chat-'));

      try {
        let indexed = 0;
        let failed = 0;

        for (let i = 0; i < newVideoIds.length; i++) {
          const videoId = newVideoIds[i];
          const progress = `[${i + 1}/${newVideoIds.length}]`;
          const spinner = ora(`${progress} Indexing video...`).start();

          const success = await indexVideo(videoId, channelInfo.channel_id, db, tempDir, spinner);

          if (success) {
            indexed++;
            spinner.succeed(`${progress} Indexed successfully`);
          } else {
            failed++;
            spinner.fail(`${progress} Failed`);
          }
        }

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
            upsertChannel(db, channelInfo.channel_id, channelInfo.name, channelInfo.url);
          } catch {
            upsertChannel(db, channelId, 'Unknown Channel', channelUrl);
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
        const success = await indexVideo(videoId, channelId, db, tempDir, spinner);

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
  });

program
  .command('mcp')
  .description('Set up the MCP server for Claude Code integration')
  .option('--install', 'Run the install command directly')
  .action((options: { install?: boolean }) => {
    const mcpPath = process.argv[1].replace('cli.js', 'mcp-server.js');

    const cmd = `claude mcp add channel-chat -- node ${mcpPath}`;

    if (options.install) {
      console.log(chalk.cyan(`Running: ${cmd}`));

      const child = spawn('claude', ['mcp', 'add', 'channel-chat', '--', 'node', mcpPath], {
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
      console.log(chalk.dim('Note: Set GOOGLE_API_KEY in your environment for embeddings.'));
    }
  });

program.parse();
