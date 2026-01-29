"""MCP server for channel-chat - search YouTube transcripts from Claude."""

import asyncio
import shutil
import tempfile
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from .database import (
    get_connection,
    init_db,
    upsert_channel,
    upsert_video,
    video_exists,
    list_channels,
    list_videos,
    delete_video_chunks,
    insert_chunk,
    insert_chunk_embedding,
    get_video,
    get_stats,
)
from .downloader import (
    get_channel_info,
    get_channel_videos,
    get_video_info,
    download_subtitles,
    download_audio,
    DownloaderError,
)
from .transcriber import parse_subtitles, transcribe_audio
from .chunker import chunk_transcript
from .embedder import embed_batch
from .search import search as do_search, format_timestamp

server = Server("channel-chat")


def _index_single_video(video_id: str, channel_id: str, conn, temp_dir: Path) -> tuple[bool, str]:
    """Index a single video. Returns (success, message)."""
    try:
        video_info = get_video_info(video_id)
        subtitle_path = download_subtitles(video_id, temp_dir)

        segments = None
        transcript_source = None

        if subtitle_path:
            segments = parse_subtitles(subtitle_path)
            transcript_source = "subtitles"
        else:
            # Try ElevenLabs transcription if API key is available
            import os
            if os.environ.get("ELEVENLABS_API_KEY"):
                audio_path = download_audio(video_id, temp_dir)
                segments = transcribe_audio(audio_path)
                transcript_source = "transcription"
            else:
                return False, f"No subtitles for {video_id} (set ELEVENLABS_API_KEY for transcription)"

        if not segments:
            return False, f"No transcript data for {video_id}"

        chunks = chunk_transcript(segments, video_info["title"])
        if not chunks:
            return False, f"No chunks generated for {video_id}"

        chunk_texts = [chunk["text"] for chunk in chunks]
        embeddings = embed_batch(chunk_texts, show_progress=False)

        upsert_video(
            conn,
            video_id=video_info["id"],
            channel_id=channel_id,
            title=video_info["title"],
            description=video_info.get("description", ""),
            duration=video_info["duration"],
            published_at=video_info.get("published_at", ""),
            thumbnail_url=video_info.get("thumbnail_url", ""),
            transcript_source=transcript_source,
        )

        for chunk, embedding in zip(chunks, embeddings):
            chunk_id = insert_chunk(
                conn,
                video_id=video_id,
                seq=chunk["seq"],
                start_time=chunk["start_time"],
                end_time=chunk["end_time"],
                text=chunk["text"],
            )
            insert_chunk_embedding(conn, chunk_id, embedding)

        return True, f"Indexed {video_info['title']}"

    except Exception as e:
        return False, f"Error: {e}"


@server.list_tools()
async def list_tools():
    """List available tools."""
    return [
        Tool(
            name="search_transcripts",
            description="Search across all indexed YouTube video transcripts using semantic search. Returns relevant clips with timestamps and YouTube links.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query - can be a question or topic"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 5)",
                        "default": 5
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="list_indexed_channels",
            description="List all YouTube channels that have been indexed for searching.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        Tool(
            name="add_channel",
            description="Add a YouTube channel and index all its videos for searching. This may take a while for large channels.",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "YouTube channel URL (e.g., https://youtube.com/@channelname)"
                    },
                    "max_videos": {
                        "type": "integer",
                        "description": "Maximum number of videos to index (default: all)",
                        "default": None
                    }
                },
                "required": ["url"]
            }
        ),
        Tool(
            name="index_video",
            description="Index a specific YouTube video for searching.",
            inputSchema={
                "type": "object",
                "properties": {
                    "video_id": {
                        "type": "string",
                        "description": "YouTube video ID (e.g., dQw4w9WgXcQ)"
                    }
                },
                "required": ["video_id"]
            }
        ),
        Tool(
            name="get_stats",
            description="Get statistics about indexed content.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    """Handle tool calls."""

    if name == "search_transcripts":
        query = arguments["query"]
        limit = arguments.get("limit", 5)

        conn = get_connection()
        init_db(conn)
        conn.close()

        results = do_search(query, limit=limit)

        if not results:
            return [TextContent(type="text", text="No results found.")]

        output = f"Found {len(results)} results for: {query}\n\n"

        for i, r in enumerate(results, 1):
            timestamp = format_timestamp(r["start_time"])
            score_pct = r["score"] * 100

            # Clean text - remove title prefix if present
            text = r["text"]
            if "|" in text:
                text = text.split("|", 1)[1].strip()

            output += f"**Result {i}** (Score: {score_pct:.1f}%)\n"
            output += f"- Video: {r['video_title']}\n"
            output += f"- Channel: {r['channel_name']}\n"
            output += f"- Timestamp: {timestamp}\n"
            output += f"- Link: {r['youtube_url']}\n"
            output += f"- Excerpt: {text[:300]}{'...' if len(text) > 300 else ''}\n\n"

        return [TextContent(type="text", text=output)]

    elif name == "list_indexed_channels":
        conn = get_connection()
        init_db(conn)

        channels = list_channels(conn)

        if not channels:
            conn.close()
            return [TextContent(type="text", text="No channels indexed yet.")]

        output = "**Indexed Channels:**\n\n"
        for ch in channels:
            videos = list_videos(conn, ch["id"])
            output += f"- **{ch['name']}** ({len(videos)} videos)\n"
            output += f"  ID: {ch['id']}\n"

        conn.close()
        return [TextContent(type="text", text=output)]

    elif name == "add_channel":
        url = arguments["url"]
        max_videos = arguments.get("max_videos")

        conn = get_connection()
        init_db(conn)

        try:
            channel_info = get_channel_info(url)
            upsert_channel(
                conn,
                channel_id=channel_info["channel_id"],
                name=channel_info["name"],
                url=channel_info["url"],
            )

            video_ids = get_channel_videos(channel_info["url"])

            # Filter already indexed
            new_video_ids = [vid for vid in video_ids if not video_exists(conn, vid)]

            if max_videos:
                new_video_ids = new_video_ids[:max_videos]

            if not new_video_ids:
                conn.close()
                return [TextContent(type="text", text=f"Channel '{channel_info['name']}' - all videos already indexed.")]

            temp_dir = Path(tempfile.mkdtemp(prefix="channel-chat-"))

            try:
                indexed = 0
                failed = 0

                for vid in new_video_ids:
                    success, msg = _index_single_video(vid, channel_info["channel_id"], conn, temp_dir)
                    if success:
                        indexed += 1
                    else:
                        failed += 1

                output = f"**Indexed channel: {channel_info['name']}**\n"
                output += f"- Successfully indexed: {indexed} videos\n"
                output += f"- Failed: {failed} videos\n"
                output += f"- Skipped (already indexed): {len(video_ids) - len(new_video_ids)} videos\n"

                return [TextContent(type="text", text=output)]

            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)
                conn.close()

        except DownloaderError as e:
            conn.close()
            return [TextContent(type="text", text=f"Error: {e}")]

    elif name == "index_video":
        video_id = arguments["video_id"]

        conn = get_connection()
        init_db(conn)

        try:
            existing = get_video(conn, video_id)

            if existing:
                channel_id = existing["channel_id"]
                delete_video_chunks(conn, video_id)
            else:
                video_info = get_video_info(video_id)
                channel_id = video_info["channel_id"]

                if channel_id:
                    try:
                        channel_url = f"https://www.youtube.com/channel/{channel_id}"
                        channel_info = get_channel_info(channel_url)
                        upsert_channel(conn, channel_info["channel_id"], channel_info["name"], channel_info["url"])
                    except:
                        upsert_channel(conn, channel_id, "Unknown Channel", "")

            temp_dir = Path(tempfile.mkdtemp(prefix="channel-chat-"))

            try:
                success, msg = _index_single_video(video_id, channel_id, conn, temp_dir)
                return [TextContent(type="text", text=msg)]
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)
                conn.close()

        except Exception as e:
            conn.close()
            return [TextContent(type="text", text=f"Error: {e}")]

    elif name == "get_stats":
        conn = get_connection()
        init_db(conn)
        stats = get_stats(conn)
        conn.close()

        output = "**Channel Chat Stats:**\n"
        output += f"- Channels indexed: {stats['channels']}\n"
        output += f"- Videos indexed: {stats['videos']}\n"
        output += f"- Transcript chunks: {stats['chunks']}\n"

        return [TextContent(type="text", text=output)]

    else:
        return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


def run():
    """Entry point for the MCP server."""
    asyncio.run(main())


if __name__ == "__main__":
    run()
