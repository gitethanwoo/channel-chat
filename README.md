# channel-chat

CLI tool to download, transcribe, embed, and semantically search YouTube channel content.

## Installation

```bash
pip install -e .
```

## Environment Variables

```bash
export GOOGLE_API_KEY=...      # For Gemini embeddings
export ELEVENLABS_API_KEY=...  # For transcription (when no subtitles)
```

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

## Tech Stack

- **yt-dlp** - Download video metadata, subtitles, and audio
- **ElevenLabs Scribe v2** - Transcription with word-level timestamps
- **Google gemini-embedding-001** - Text embeddings (768 dimensions)
- **SQLite + sqlite-vec** - Storage and vector search
- **Click** - CLI framework
