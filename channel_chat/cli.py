"""CLI module for channel-chat using Click and Rich."""

import shutil
import tempfile
from pathlib import Path

import click
from rich.console import Console, Group
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn
from rich.table import Table
from rich.text import Text

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
from .search import search, format_timestamp

console = Console()


def _index_video(
    video_id: str,
    channel_id: str,
    conn,
    temp_dir: Path,
    progress=None,
    task_id=None,
) -> bool:
    """Index a single video. Returns True on success, False on failure."""
    try:
        # Get video metadata
        if progress and task_id:
            progress.update(task_id, description=f"[cyan]Getting metadata for {video_id}...")
        video_info = get_video_info(video_id)

        # Try to download subtitles
        if progress and task_id:
            progress.update(task_id, description=f"[cyan]Downloading subtitles for {video_id}...")
        subtitle_path = download_subtitles(video_id, temp_dir)

        segments = None
        transcript_source = None

        if subtitle_path:
            # Parse subtitles
            if progress and task_id:
                progress.update(task_id, description=f"[cyan]Parsing subtitles for {video_id}...")
            segments = parse_subtitles(subtitle_path)
            transcript_source = "subtitles"
        else:
            # No subtitles available - try ElevenLabs if API key is set
            import os
            if not os.environ.get("ELEVENLABS_API_KEY"):
                console.print(f"[yellow]Skipping {video_id}: no subtitles (set ELEVENLABS_API_KEY for transcription)[/yellow]")
                return False

            if progress and task_id:
                progress.update(task_id, description=f"[cyan]Downloading audio for {video_id}...")
            audio_path = download_audio(video_id, temp_dir)

            if progress and task_id:
                progress.update(task_id, description=f"[cyan]Transcribing {video_id}...")
            segments = transcribe_audio(audio_path)
            transcript_source = "transcription"

        if not segments:
            console.print(f"[yellow]Warning: No transcript data for {video_id}[/yellow]")
            return False

        # Chunk the transcript
        if progress and task_id:
            progress.update(task_id, description=f"[cyan]Chunking transcript for {video_id}...")
        chunks = chunk_transcript(segments, video_info["title"])

        if not chunks:
            console.print(f"[yellow]Warning: No chunks generated for {video_id}[/yellow]")
            return False

        # Generate embeddings
        if progress and task_id:
            progress.update(task_id, description=f"[cyan]Generating embeddings for {video_id}...")
        chunk_texts = [chunk["text"] for chunk in chunks]
        embeddings = embed_batch(chunk_texts, show_progress=False)

        # Store video and chunks in database
        if progress and task_id:
            progress.update(task_id, description=f"[cyan]Storing {video_id} in database...")

        upsert_video(
            conn,
            video_id=video_info["id"],
            channel_id=channel_id,
            title=video_info["title"],
            description=video_info["description"],
            duration=video_info["duration"],
            published_at=video_info["published_at"] or "",
            thumbnail_url=video_info["thumbnail_url"] or "",
            transcript_source=transcript_source,
        )

        # Insert chunks with embeddings
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

        return True

    except DownloaderError as e:
        console.print(f"[red]Error downloading {video_id}: {e}[/red]")
        return False
    except Exception as e:
        console.print(f"[red]Error processing {video_id}: {e}[/red]")
        return False


@click.group()
def cli():
    """Channel Chat - Search YouTube channel transcripts with semantic search."""
    pass


@cli.command()
@click.argument("url")
def add(url: str):
    """Add a YouTube channel and index all its videos.

    URL should be a YouTube channel URL (e.g., https://www.youtube.com/@channelname)
    """
    # Initialize database
    conn = get_connection()
    init_db(conn)

    try:
        # Get channel info
        with console.status("[bold green]Fetching channel information..."):
            channel_info = get_channel_info(url)

        console.print(
            Panel(
                f"[bold]{channel_info['name']}[/bold]\n"
                f"ID: {channel_info['channel_id']}\n"
                f"URL: {channel_info['url']}",
                title="Channel Found",
                border_style="green",
            )
        )

        # Store channel
        upsert_channel(
            conn,
            channel_id=channel_info["channel_id"],
            name=channel_info["name"],
            url=channel_info["url"],
        )

        # Get video list
        with console.status("[bold green]Fetching video list..."):
            video_ids = get_channel_videos(channel_info["url"])

        console.print(f"[green]Found {len(video_ids)} videos[/green]")

        # Filter out already indexed videos
        new_video_ids = [vid for vid in video_ids if not video_exists(conn, vid)]
        skipped = len(video_ids) - len(new_video_ids)

        if skipped > 0:
            console.print(f"[yellow]Skipping {skipped} already indexed videos[/yellow]")

        if not new_video_ids:
            console.print("[green]All videos already indexed![/green]")
            return

        console.print(f"[cyan]Indexing {len(new_video_ids)} new videos...[/cyan]")

        # Create temp directory for downloads
        temp_dir = Path(tempfile.mkdtemp(prefix="channel-chat-"))

        try:
            indexed = 0
            failed = 0

            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TaskProgressColumn(),
                console=console,
            ) as progress:
                overall_task = progress.add_task(
                    "[green]Indexing videos...",
                    total=len(new_video_ids),
                )

                for video_id in new_video_ids:
                    success = _index_video(
                        video_id,
                        channel_info["channel_id"],
                        conn,
                        temp_dir,
                        progress,
                        overall_task,
                    )

                    if success:
                        indexed += 1
                    else:
                        failed += 1

                    progress.update(overall_task, advance=1)

            console.print(
                Panel(
                    f"[green]Successfully indexed: {indexed}[/green]\n"
                    f"[red]Failed: {failed}[/red]\n"
                    f"[yellow]Skipped (already indexed): {skipped}[/yellow]",
                    title="Indexing Complete",
                    border_style="blue",
                )
            )

        finally:
            # Clean up temp directory
            shutil.rmtree(temp_dir, ignore_errors=True)

    finally:
        conn.close()


@cli.command("search")
@click.argument("query")
@click.option("--limit", "-n", default=10, help="Maximum number of results to return")
def search_cmd(query: str, limit: int):
    """Search across all indexed content.

    QUERY is the search text to find in video transcripts.
    """
    # Initialize database
    conn = get_connection()
    init_db(conn)
    conn.close()

    with console.status("[bold green]Searching..."):
        results = search(query, limit=limit)

    if not results:
        console.print("[yellow]No results found.[/yellow]")
        return

    console.print(f"\n[bold]Found {len(results)} results for:[/bold] {query}\n")

    for i, result in enumerate(results, 1):
        # Create result panel
        timestamp = format_timestamp(result["start_time"])
        score_pct = result["score"] * 100

        table = Table(show_header=False, box=None, padding=(0, 1))
        table.add_column(style="dim")
        table.add_column()

        table.add_row("Video", f"[bold]{result['video_title']}[/bold]")
        table.add_row("Channel", result["channel_name"])
        table.add_row("Time", f"[cyan]{timestamp}[/cyan]")
        table.add_row("Link", f"[link={result['youtube_url']}]{result['youtube_url']}[/link]")
        table.add_row("Score", f"[green]{score_pct:.1f}%[/green]")

        # Truncate text preview if too long
        text_preview = result["text"]
        if len(text_preview) > 300:
            text_preview = text_preview[:297] + "..."

        # Use Group to combine table and text in panel
        content = Group(
            table,
            Text(),  # Empty line
            Text(text_preview, style="italic"),
        )

        console.print(
            Panel(
                content,
                title=f"Result {i}",
                border_style="blue",
            )
        )
        console.print()


@cli.command("list")
@click.option("--verbose", "-v", is_flag=True, help="Show videos for each channel")
def list_cmd(verbose: bool):
    """List all indexed channels."""
    # Initialize database
    conn = get_connection()
    init_db(conn)

    try:
        channels = list_channels(conn)

        if not channels:
            console.print("[yellow]No channels indexed yet.[/yellow]")
            console.print("Use [cyan]channel-chat add <url>[/cyan] to add a channel.")
            return

        table = Table(title="Indexed Channels")
        table.add_column("Name", style="bold")
        table.add_column("ID", style="dim")
        table.add_column("Videos", justify="right")
        table.add_column("Indexed At")

        for channel in channels:
            videos = list_videos(conn, channel["id"])
            table.add_row(
                channel["name"],
                channel["id"],
                str(len(videos)),
                channel["indexed_at"] or "N/A",
            )

        console.print(table)

        if verbose:
            console.print()
            for channel in channels:
                videos = list_videos(conn, channel["id"])
                if videos:
                    video_table = Table(title=f"Videos: {channel['name']}")
                    video_table.add_column("Title", style="bold", max_width=50)
                    video_table.add_column("ID", style="dim")
                    video_table.add_column("Duration", justify="right")
                    video_table.add_column("Source")

                    for video in videos:
                        duration_str = format_timestamp(video["duration"]) if video["duration"] else "N/A"
                        video_table.add_row(
                            video["title"][:47] + "..." if len(video["title"]) > 50 else video["title"],
                            video["id"],
                            duration_str,
                            video["transcript_source"] or "N/A",
                        )

                    console.print(video_table)
                    console.print()

    finally:
        conn.close()


@cli.command("index-video")
@click.argument("video_id")
def index_video(video_id: str):
    """Re-index a specific video.

    VIDEO_ID is the YouTube video ID (e.g., dQw4w9WgXcQ)
    """
    # Initialize database
    conn = get_connection()
    init_db(conn)

    try:
        # Check if video exists and get its channel
        existing_video = get_video(conn, video_id)

        if existing_video:
            channel_id = existing_video["channel_id"]
            console.print(f"[yellow]Found existing video. Re-indexing...[/yellow]")

            # Delete existing chunks
            with console.status("[bold yellow]Deleting existing chunks..."):
                delete_video_chunks(conn, video_id)
        else:
            # New video - need to get channel info from video metadata
            with console.status("[bold green]Getting video information..."):
                video_info = get_video_info(video_id)
                channel_id = video_info["channel_id"]

            # Check if channel exists, if not add it
            if channel_id:
                channel_url = f"https://www.youtube.com/channel/{channel_id}"
                try:
                    channel_info = get_channel_info(channel_url)
                    upsert_channel(
                        conn,
                        channel_id=channel_info["channel_id"],
                        name=channel_info["name"],
                        url=channel_info["url"],
                    )
                except DownloaderError:
                    # Channel info fetch failed, use video metadata
                    upsert_channel(
                        conn,
                        channel_id=channel_id,
                        name="Unknown Channel",
                        url=channel_url,
                    )

        if not channel_id:
            console.print("[red]Error: Could not determine channel ID for video[/red]")
            return

        # Create temp directory for downloads
        temp_dir = Path(tempfile.mkdtemp(prefix="channel-chat-"))

        try:
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                console=console,
            ) as progress:
                task = progress.add_task("[green]Indexing video...", total=None)

                success = _index_video(
                    video_id,
                    channel_id,
                    conn,
                    temp_dir,
                    progress,
                    task,
                )

            if success:
                console.print(f"[green]Successfully indexed video {video_id}[/green]")
            else:
                console.print(f"[red]Failed to index video {video_id}[/red]")

        finally:
            # Clean up temp directory
            shutil.rmtree(temp_dir, ignore_errors=True)

    finally:
        conn.close()


@cli.command("mcp")
@click.option("--install", is_flag=True, help="Run the install command directly")
def mcp_cmd(install: bool):
    """Set up the MCP server for Claude Code integration."""
    import sys
    import subprocess

    # Find the mcp server executable
    mcp_path = Path(sys.executable).parent / "channel-chat-mcp"

    if not mcp_path.exists():
        console.print("[red]Error: channel-chat-mcp not found. Run 'pip install -e .' first.[/red]")
        return

    # Build the command
    cmd = f'claude mcp add channel-chat -- {mcp_path}'

    if install:
        console.print(f"[cyan]Running:[/cyan] {cmd}")
        result = subprocess.run(cmd, shell=True)
        if result.returncode == 0:
            console.print("[green]MCP server installed! Restart Claude Code to use it.[/green]")
        else:
            console.print("[red]Installation failed. Try running the command manually.[/red]")
    else:
        console.print("[bold]To add channel-chat to Claude Code:[/bold]\n")
        console.print(f"  {cmd}\n")
        console.print("Or run [cyan]channel-chat mcp --install[/cyan] to do it automatically.\n")
        console.print("[dim]Note: Set GOOGLE_API_KEY in your environment for embeddings.[/dim]")


def main():
    """Entry point for the CLI."""
    cli()


if __name__ == "__main__":
    main()
