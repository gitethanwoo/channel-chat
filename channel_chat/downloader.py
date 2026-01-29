"""YouTube downloader module using yt-dlp."""

import re
from datetime import datetime
from pathlib import Path
from typing import Optional

import yt_dlp


class DownloaderError(Exception):
    """Base exception for downloader errors."""

    pass


class ChannelNotFoundError(DownloaderError):
    """Raised when a channel cannot be found."""

    pass


class VideoNotFoundError(DownloaderError):
    """Raised when a video cannot be found."""

    pass


class SubtitleNotFoundError(DownloaderError):
    """Raised when subtitles cannot be found for a video."""

    pass


class AudioDownloadError(DownloaderError):
    """Raised when audio download fails."""

    pass


def _get_base_opts() -> dict:
    """Get base yt-dlp options."""
    return {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }


def get_channel_info(url: str) -> dict:
    """
    Extract channel information from a YouTube channel URL.

    Args:
        url: YouTube channel URL (e.g., https://www.youtube.com/@channelname)

    Returns:
        dict with channel_id, name, url

    Raises:
        ChannelNotFoundError: If the channel cannot be found
    """
    opts = _get_base_opts()
    opts["extract_flat"] = True
    opts["playlistend"] = 1  # Only need one video to get channel info

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)

            if info is None:
                raise ChannelNotFoundError(f"Could not extract info from URL: {url}")

            # Handle different URL types
            channel_id = info.get("channel_id") or info.get("uploader_id")
            channel_name = info.get("channel") or info.get("uploader") or info.get("title")
            channel_url = info.get("channel_url") or info.get("uploader_url") or url

            if not channel_id:
                raise ChannelNotFoundError(f"Could not find channel ID for URL: {url}")

            return {
                "channel_id": channel_id,
                "name": channel_name,
                "url": channel_url,
            }

    except yt_dlp.utils.DownloadError as e:
        raise ChannelNotFoundError(f"Failed to fetch channel info: {e}") from e


def get_channel_videos(channel_url: str) -> list[str]:
    """
    Get all video IDs from a YouTube channel.

    Args:
        channel_url: YouTube channel URL

    Returns:
        List of video IDs

    Raises:
        ChannelNotFoundError: If the channel cannot be found
    """
    # Ensure we're using the videos tab URL
    if "/videos" not in channel_url:
        if channel_url.endswith("/"):
            channel_url = channel_url + "videos"
        else:
            channel_url = channel_url + "/videos"

    opts = _get_base_opts()
    opts["extract_flat"] = True
    opts["ignoreerrors"] = True

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(channel_url, download=False)

            if info is None:
                raise ChannelNotFoundError(f"Could not extract info from URL: {channel_url}")

            entries = info.get("entries", [])
            video_ids = []

            for entry in entries:
                if entry is None:
                    continue
                video_id = entry.get("id")
                if video_id:
                    video_ids.append(video_id)

            return video_ids

    except yt_dlp.utils.DownloadError as e:
        raise ChannelNotFoundError(f"Failed to fetch channel videos: {e}") from e


def get_video_info(video_id: str) -> dict:
    """
    Get metadata for a specific video.

    Args:
        video_id: YouTube video ID

    Returns:
        dict with id, title, description, duration, published_at (ISO format),
        thumbnail_url, channel_id

    Raises:
        VideoNotFoundError: If the video cannot be found
    """
    video_url = f"https://www.youtube.com/watch?v={video_id}"
    opts = _get_base_opts()

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(video_url, download=False)

            if info is None:
                raise VideoNotFoundError(f"Could not extract info for video: {video_id}")

            # Parse upload date to ISO format
            upload_date = info.get("upload_date")
            published_at = None
            if upload_date:
                try:
                    dt = datetime.strptime(upload_date, "%Y%m%d")
                    published_at = dt.isoformat()
                except ValueError:
                    published_at = upload_date

            # Get best thumbnail
            thumbnails = info.get("thumbnails", [])
            thumbnail_url = None
            if thumbnails:
                # Prefer maxresdefault or high quality thumbnails
                for thumb in reversed(thumbnails):
                    if thumb.get("url"):
                        thumbnail_url = thumb["url"]
                        break

            return {
                "id": info.get("id", video_id),
                "title": info.get("title", ""),
                "description": info.get("description", ""),
                "duration": info.get("duration", 0),
                "published_at": published_at,
                "thumbnail_url": thumbnail_url,
                "channel_id": info.get("channel_id", ""),
            }

    except yt_dlp.utils.DownloadError as e:
        raise VideoNotFoundError(f"Failed to fetch video info: {e}") from e


def download_subtitles(video_id: str, output_dir: Path) -> Optional[Path]:
    """
    Download subtitles for a video.

    Prefers manual subtitles over auto-generated. Supports VTT and SRT formats.

    Args:
        video_id: YouTube video ID
        output_dir: Directory to save the subtitle file

    Returns:
        Path to the downloaded subtitle file, or None if no subtitles available

    Raises:
        DownloaderError: If there's an error during download
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    video_url = f"https://www.youtube.com/watch?v={video_id}"
    output_template = str(output_dir / f"{video_id}.%(ext)s")

    # First, try to get manual subtitles
    opts = _get_base_opts()
    opts.update({
        "writesubtitles": True,
        "writeautomaticsub": False,
        "subtitleslangs": ["en", "en-US", "en-GB"],
        "subtitlesformat": "vtt/srt/best",
        "skip_download": True,
        "outtmpl": output_template,
    })

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(video_url, download=False)

            if info is None:
                return None

            # Check if manual subtitles exist
            subtitles = info.get("subtitles", {})
            has_manual_subs = any(
                lang in subtitles for lang in ["en", "en-US", "en-GB"]
            )

            if has_manual_subs:
                # Download manual subtitles
                ydl.download([video_url])
            else:
                # Fall back to auto-generated subtitles
                opts["writesubtitles"] = False
                opts["writeautomaticsub"] = True

                with yt_dlp.YoutubeDL(opts) as ydl_auto:
                    auto_info = ydl_auto.extract_info(video_url, download=False)
                    auto_subs = auto_info.get("automatic_captions", {}) if auto_info else {}

                    if not any(lang in auto_subs for lang in ["en", "en-US", "en-GB"]):
                        return None

                    ydl_auto.download([video_url])

        # Find the downloaded subtitle file
        for ext in ["vtt", "srt"]:
            for lang in ["en", "en-US", "en-GB"]:
                subtitle_path = output_dir / f"{video_id}.{lang}.{ext}"
                if subtitle_path.exists():
                    return subtitle_path

        # Check for files without language code
        for ext in ["vtt", "srt"]:
            subtitle_path = output_dir / f"{video_id}.{ext}"
            if subtitle_path.exists():
                return subtitle_path

        return None

    except yt_dlp.utils.DownloadError as e:
        raise DownloaderError(f"Failed to download subtitles: {e}") from e


def download_audio(video_id: str, output_dir: Path) -> Path:
    """
    Download audio from a video for transcription.

    Downloads as mp3 or m4a format suitable for ElevenLabs transcription.

    Args:
        video_id: YouTube video ID
        output_dir: Directory to save the audio file

    Returns:
        Path to the downloaded audio file

    Raises:
        AudioDownloadError: If audio download fails
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    video_url = f"https://www.youtube.com/watch?v={video_id}"
    output_template = str(output_dir / f"{video_id}.%(ext)s")

    opts = _get_base_opts()
    opts.update({
        "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
        "outtmpl": output_template,
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
    })

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([video_url])

        # Find the downloaded audio file
        for ext in ["mp3", "m4a", "opus", "webm"]:
            audio_path = output_dir / f"{video_id}.{ext}"
            if audio_path.exists():
                return audio_path

        # If no specific extension found, look for any audio file with the video ID
        for file in output_dir.iterdir():
            if file.stem == video_id and file.suffix in [".mp3", ".m4a", ".opus", ".webm"]:
                return file

        raise AudioDownloadError(f"Audio file not found after download for video: {video_id}")

    except yt_dlp.utils.DownloadError as e:
        raise AudioDownloadError(f"Failed to download audio: {e}") from e
