# channel-chat

Download YouTube channel videos, transcribe, embed, and serve via MCP for semantic search in Claude.

## Overview

channel-chat is a CLI tool that:

1. Downloads videos from YouTube channels
2. Extracts or generates transcripts with timestamps
3. Creates vector embeddings for semantic search
4. Serves content via MCP (Model Context Protocol) for use with Claude

Supports two deployment modes:
- **Local**: SQLite + sqlite-vec for personal use
- **Cloudflare**: Workers + D1 + Vectorize + R2 for cloud deployment

## Prerequisites

- **Node.js** >= 20.0.0
- **yt-dlp** - `brew install yt-dlp` or `pip install yt-dlp`
- **ffmpeg** - `brew install ffmpeg` (required for video clips)

## Installation

```bash
cd src
npm install
npm run build
```

To make the CLI globally available:

```bash
npm link
```

## Environment Variables

### Required (Local Mode)

```bash
export GOOGLE_API_KEY=...  # For Gemini embeddings
```

### Optional

```bash
export ELEVENLABS_API_KEY=...  # For transcribing videos without subtitles
```

### Cloudflare Mode

```bash
export CLOUDFLARE_WORKER_URL=https://your-worker.workers.dev
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_R2_BUCKET=channel-chat-media
export CLOUDFLARE_R2_ACCESS_KEY_ID=...
export CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
export CLOUDFLARE_WORKER_API_KEY=...  # Optional: for authenticated endpoints
```

## CLI Usage

### Add a Channel

```bash
# Index all videos from a channel (local SQLite)
channel-chat add "https://youtube.com/@channelname"

# Limit to first 50 videos with 3 concurrent workers
channel-chat add "https://youtube.com/@channelname" --limit 50 --concurrency 3

# Index to Cloudflare (downloads video, uploads to R2)
channel-chat add "https://youtube.com/@channelname" --cloudflare
```

**Options:**
- `--limit <n>` - Maximum videos to index
- `--concurrency <n>` - Parallel processing (default: 1)
- `--cloudflare` - Index to Cloudflare instead of local SQLite

### Search Transcripts

```bash
channel-chat search "how to optimize database queries"
channel-chat search "kubernetes deployment" --limit 5
```

**Options:**
- `-n, --limit <n>` - Maximum results (default: 10)

### List Channels

```bash
channel-chat list          # Show indexed channels
channel-chat list -v       # Verbose: show videos per channel
```

### Index Single Video

```bash
channel-chat index-video "VIDEO_ID"
```

### Cloudflare Setup

```bash
channel-chat cloudflare-setup  # Display setup instructions
```

## MCP Server

Use channel-chat as an MCP server to search transcripts directly from Claude.

### Quick Setup

```bash
channel-chat mcp --install
```

### Manual Setup

Add to your MCP config (`~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "channel-chat": {
      "command": "node",
      "args": ["/path/to/channel-chat/src/dist/mcp-server.js"],
      "env": {
        "GOOGLE_API_KEY": "your-key"
      }
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `search_transcripts` | Semantic search across indexed videos |
| `list_indexed_channels` | Show indexed channels with video counts |
| `add_channel` | Index a YouTube channel |
| `index_video` | Index a specific video |
| `get_stats` | Get indexing statistics |
| `set_video_path` | Set local video path for clip playback |

### MCP Resources

| Resource | Description |
|----------|-------------|
| `ui://channel-chat/player.html` | React-based video player UI |
| `video://clip/{videoId}?start=X&duration=Y` | On-the-fly video clip extraction |

## Cloudflare Deployment

For cloud deployment with video storage in R2:

### 1. Create Cloudflare Resources

```bash
cd cloudflare

# Create D1 database
npm run db:create
npm run db:migrate

# Create Vectorize index
npm run vectorize:create

# Create R2 bucket
npm run r2:create
```

### 2. Set API Key

```bash
wrangler secret put API_KEY
```

### 3. Deploy Worker

```bash
npm run deploy
```

### 4. Create R2 API Token

In Cloudflare Dashboard:
1. Go to R2 > Manage R2 API Tokens
2. Create token with Object Read/Write permissions
3. Add credentials to your environment

### Worker Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC interface |
| `/api/index` | POST | Index video content |
| `/api/videos` | GET | List indexed video IDs |
| `/api/videos/:id` | DELETE | Delete a video |
| `/api/stats` | GET | Get statistics |

## Data Flow

### Local Indexing

```
YouTube URL → getChannelVideos → downloadSubtitles → parseSubtitles
           → chunkTranscript (800 tokens, 15% overlap)
           → embedBatch (Google Gemini, 768D)
           → SQLite + sqlite-vec
```

### Cloudflare Indexing

```
YouTube URL → downloadVideo → uploadToR2
           → chunks → POST /api/index
           → Workers AI embeddings → Vectorize + D1
```

## Tech Stack

**CLI**
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [youtubei.js](https://github.com/LuanRT/YouTube.js) - YouTube data extraction
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - Video/subtitle download
- [Google Gemini](https://ai.google.dev/) - Embeddings (768D)
- [ElevenLabs Scribe](https://elevenlabs.io/) - Transcription fallback
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) - Vector storage
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Claude integration

**Cloudflare Worker**
- [Cloudflare Workers](https://workers.cloudflare.com/) - Serverless runtime
- [D1](https://developers.cloudflare.com/d1/) - SQLite database
- [Vectorize](https://developers.cloudflare.com/vectorize/) - Vector search
- [R2](https://developers.cloudflare.com/r2/) - Object storage
- [Workers AI](https://developers.cloudflare.com/workers-ai/) - Embeddings

## Project Structure

```
channel-chat/
├── src/                    # Node.js CLI and MCP server
│   ├── cli.ts             # CLI commands
│   ├── mcp-server.ts      # MCP server (stdio/HTTP)
│   ├── downloader.ts      # YouTube video/subtitle fetching
│   ├── database.ts        # SQLite + vector operations
│   ├── transcriber.ts     # Subtitle parsing, transcription
│   ├── embedder.ts        # Google Gemini embeddings
│   ├── chunker.ts         # Token-based transcript chunking
│   ├── search.ts          # Vector similarity search
│   └── cloudflare-client.ts # R2 upload & Worker API
├── cloudflare/             # Cloudflare Worker
│   ├── src/
│   │   ├── index.ts       # Worker entry point
│   │   ├── api.ts         # API endpoints
│   │   ├── mcp-handler.ts # MCP tool implementations
│   │   ├── db.ts          # D1 operations
│   │   └── vectorize.ts   # Vector storage
│   ├── schema.sql         # D1 schema
│   └── wrangler.toml      # Worker config
└── ui/                     # React MCP App for video player
```

## Database Location

Local database: `~/.channel-chat/channel_chat.db`

## License

MIT
