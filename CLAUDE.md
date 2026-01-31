# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

channel-chat downloads YouTube channel videos, transcribes them, generates vector embeddings, and serves content via MCP for semantic search in Claude. Two deployment modes:

- **Local**: SQLite + sqlite-vec, Google Gemini embeddings
- **Cloudflare**: Workers + D1 + Vectorize + R2, Workers AI embeddings

## Build & Run Commands

### Local CLI (src/)

```bash
cd src
npm install
npm run build          # Compile TypeScript
npm run dev            # Watch mode
node dist/cli.js       # Run CLI
```

### Cloudflare Worker (cloudflare/)

```bash
cd cloudflare
npm install
npm run dev            # Local dev server
npm run deploy         # Deploy to Cloudflare
npm run db:migrate     # Apply D1 schema
npm run typecheck      # Type check only
```

### UI (ui/)

```bash
cd ui
npm install
npm run build          # Build the UI bundle
```

**Important**: After building the UI, you must regenerate the embedded HTML in the worker before deploying:

```bash
cd cloudflare
npm run build:ui       # Embeds ui/dist/index.html into src/ui-html.ts
npm run deploy
```

Full UI deploy pipeline: `cd ui && npm run build && cd ../cloudflare && npm run build:ui && npm run deploy`

### Linting & Tests

```bash
# From src/
npm run test           # Run tests: node --test dist/**/*.test.js
```

## Architecture

### Data Flow

1. **Ingestion** (`src/cli.ts` → `downloader.ts`): Fetches channel/video metadata via youtubei.js, downloads subtitles via yt-dlp
2. **Transcription** (`transcriber.ts`): Parses VTT/SRT subtitles with timestamp extraction, falls back to ElevenLabs for videos without subtitles
3. **Chunking** (`chunker.ts`): Token-based chunking (800 tokens, 15% overlap) using gpt-tokenizer
4. **Embedding** (`embedder.ts`): Google Gemini API for local mode; Workers AI for Cloudflare
5. **Storage**: Local uses SQLite + sqlite-vec virtual table; Cloudflare uses D1 + Vectorize
6. **Search** (`search.ts`): Vector similarity search, returns results with YouTube timestamps

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/cli.ts` | Commander.js CLI with add/search/list/index-video commands |
| `src/mcp-server.ts` | MCP server (stdio + HTTP), exposes search_transcripts tool |
| `src/cloudflare-client.ts` | R2 upload, Worker API communication |
| `cloudflare/src/index.ts` | Worker entry point, MCP JSON-RPC routing, REST API |
| `cloudflare/src/mcp-handler.ts` | MCP tool implementations for Worker |

### MCP Integration

The `search_transcripts` tool returns structured results with:
- `youtube_url`: Link with timestamp (`?t=X`)
- `clip_resource_uri`: `video://clip/{videoId}?start=X&duration=Y` for video playback
- `cloudflare_video_url`: Direct R2 video URL (Cloudflare mode)

UI resource at `ui://channel-chat/player.html` provides embedded video player.

## Environment Variables

### Local Mode
```
GOOGLE_API_KEY=...           # Required: Gemini embeddings
ELEVENLABS_API_KEY=...       # Optional: transcription fallback
```

### Cloudflare Mode
```
CLOUDFLARE_WORKER_URL=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_R2_BUCKET=...
CLOUDFLARE_R2_ACCESS_KEY_ID=...
CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
```

## Database

Local: `~/.channel-chat/channel_chat.db`
- Tables: `channels`, `videos`, `chunks`
- Vector table: `chunks_vec` (sqlite-vec, 768 dimensions)

Cloudflare D1 schema: `cloudflare/schema.sql`

## External Dependencies

- **yt-dlp**: Required for subtitle/video download (`brew install yt-dlp`)
- **ffmpeg**: Required for clip extraction (`brew install ffmpeg`)

## Development Guidelines

- **Atomic commits**: Keep commits focused on a single logical change
- **Task subagents**: Whenever possible, use Task subagents to preserve your context window and speed up tasks through parallelization
