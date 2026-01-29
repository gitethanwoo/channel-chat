# channel-chat

CLI tool to download, transcribe, embed, and semantically search YouTube channel content.

## Installation

```bash
pip install -e .
```

## Environment Variables

```bash
export GOOGLE_API_KEY=...      # Required - for Gemini embeddings
export ELEVENLABS_API_KEY=...  # Optional - for transcribing videos without subtitles
```

Note: Most YouTube videos have subtitles. ElevenLabs is only needed for videos without any captions.

## Usage

```bash
# Add a channel and index all videos
channel-chat add "https://youtube.com/@channelname"

# Search across all indexed content
channel-chat search "how to optimize database queries"

# List indexed channels
channel-chat list

# Re-index a specific video
channel-chat index-video "VIDEO_ID"
```

## MCP Server

Use channel-chat as an MCP server to search transcripts directly from Claude:

```bash
# Add to your Claude config (~/.claude/claude_desktop_config.json or claude settings)
claude mcp add channel-chat -- /path/to/channel-chat/.venv/bin/channel-chat-mcp
```

Or manually add to your MCP config:
```json
{
  "mcpServers": {
    "channel-chat": {
      "command": "/path/to/channel-chat/.venv/bin/channel-chat-mcp",
      "env": {
        "GOOGLE_API_KEY": "your-key"
      }
    }
  }
}
```

(Add `ELEVENLABS_API_KEY` only if you need to transcribe videos without subtitles)

Available tools:
- `search_transcripts` - Semantic search across indexed videos
- `list_indexed_channels` - Show indexed channels
- `add_channel` - Index a YouTube channel
- `index_video` - Index a specific video
- `get_stats` - Get indexing statistics

## Tech Stack

- **yt-dlp** - Download video metadata, subtitles, and audio
- **ElevenLabs Scribe v2** - Transcription with word-level timestamps
- **Google gemini-embedding-001** - Text embeddings (768 dimensions)
- **SQLite + sqlite-vec** - Storage and vector search
- **Click** - CLI framework
