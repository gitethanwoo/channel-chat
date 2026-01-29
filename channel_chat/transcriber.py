"""Transcription and subtitle parsing for YouTube videos."""

import os
import re
from pathlib import Path


def _parse_vtt_timestamp(timestamp: str) -> float:
    """Parse VTT timestamp to seconds.

    Supports formats:
    - 00:00:00.000 (hours:minutes:seconds.milliseconds)
    - 00:00.000 (minutes:seconds.milliseconds)
    """
    parts = timestamp.strip().split(":")
    if len(parts) == 3:
        hours, minutes, seconds = parts
        hours = int(hours)
    elif len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    else:
        raise ValueError(f"Invalid VTT timestamp format: {timestamp}")

    minutes = int(minutes)
    seconds = float(seconds)

    return hours * 3600 + minutes * 60 + seconds


def _parse_srt_timestamp(timestamp: str) -> float:
    """Parse SRT timestamp to seconds.

    Format: 00:00:00,000 (hours:minutes:seconds,milliseconds)
    """
    # SRT uses comma as decimal separator
    timestamp = timestamp.strip().replace(",", ".")
    parts = timestamp.split(":")

    if len(parts) != 3:
        raise ValueError(f"Invalid SRT timestamp format: {timestamp}")

    hours = int(parts[0])
    minutes = int(parts[1])
    seconds = float(parts[2])

    return hours * 3600 + minutes * 60 + seconds


def parse_vtt(file_path: Path) -> list[dict]:
    """Parse a VTT subtitle file.

    Args:
        file_path: Path to the VTT file.

    Returns:
        List of segment dicts with {text, start_time, end_time}.
    """
    content = file_path.read_text(encoding="utf-8")
    segments = []

    # Remove WEBVTT header and any metadata
    lines = content.split("\n")
    start_idx = 0
    for i, line in enumerate(lines):
        if line.strip() == "WEBVTT" or line.strip().startswith("WEBVTT "):
            start_idx = i + 1
            break

    # Skip any header metadata (lines before first timestamp)
    while start_idx < len(lines):
        line = lines[start_idx].strip()
        if "-->" in line:
            break
        start_idx += 1

    # Parse cues
    i = start_idx
    while i < len(lines):
        line = lines[i].strip()

        # Skip empty lines and cue identifiers
        if not line or (line and "-->" not in line and not lines[i - 1].strip() == ""):
            # Check if this might be a cue identifier (numeric or string before timestamp)
            if i + 1 < len(lines) and "-->" in lines[i + 1]:
                i += 1
                continue

        # Look for timestamp line
        if "-->" in line:
            # Parse timestamp line: "00:00:00.000 --> 00:00:05.000" with optional settings
            timestamp_match = re.match(
                r"([\d:.]+)\s*-->\s*([\d:.]+)",
                line
            )
            if timestamp_match:
                start_time = _parse_vtt_timestamp(timestamp_match.group(1))
                end_time = _parse_vtt_timestamp(timestamp_match.group(2))

                # Collect text lines until empty line or next timestamp
                text_lines = []
                i += 1
                while i < len(lines):
                    text_line = lines[i]
                    # Stop at empty line or next timestamp
                    if not text_line.strip():
                        break
                    if "-->" in text_line:
                        i -= 1  # Back up so outer loop catches this timestamp
                        break
                    # Remove VTT formatting tags like <c>, </c>, <00:00:00.000>
                    clean_line = re.sub(r"<[^>]+>", "", text_line)
                    text_lines.append(clean_line.strip())
                    i += 1

                text = " ".join(text_lines).strip()
                if text:
                    segments.append({
                        "text": text,
                        "start_time": start_time,
                        "end_time": end_time,
                    })

        i += 1

    return segments


def parse_srt(file_path: Path) -> list[dict]:
    """Parse an SRT subtitle file.

    Args:
        file_path: Path to the SRT file.

    Returns:
        List of segment dicts with {text, start_time, end_time}.
    """
    content = file_path.read_text(encoding="utf-8")
    segments = []

    # SRT format: sequence number, timestamp line, text, blank line
    # Split by double newlines to get blocks
    blocks = re.split(r"\n\n+", content.strip())

    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 2:
            continue

        # Find the timestamp line (contains "-->")
        timestamp_idx = None
        for idx, line in enumerate(lines):
            if "-->" in line:
                timestamp_idx = idx
                break

        if timestamp_idx is None:
            continue

        # Parse timestamp
        timestamp_line = lines[timestamp_idx]
        timestamp_match = re.match(
            r"([\d:,]+)\s*-->\s*([\d:,]+)",
            timestamp_line
        )
        if not timestamp_match:
            continue

        start_time = _parse_srt_timestamp(timestamp_match.group(1))
        end_time = _parse_srt_timestamp(timestamp_match.group(2))

        # Text is everything after the timestamp line
        text_lines = lines[timestamp_idx + 1:]
        # Remove SRT formatting tags like <i>, </i>, {\\an8}, etc.
        text = " ".join(text_lines)
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\{[^}]+\}", "", text)
        text = text.strip()

        if text:
            segments.append({
                "text": text,
                "start_time": start_time,
                "end_time": end_time,
            })

    return segments


def parse_subtitles(file_path: Path) -> list[dict]:
    """Auto-detect subtitle format and parse.

    Args:
        file_path: Path to the subtitle file (.vtt or .srt).

    Returns:
        List of segment dicts with {text, start_time, end_time}.

    Raises:
        ValueError: If the file format cannot be determined.
    """
    file_path = Path(file_path)
    suffix = file_path.suffix.lower()

    if suffix == ".vtt":
        return parse_vtt(file_path)
    elif suffix == ".srt":
        return parse_srt(file_path)
    else:
        # Try to detect from content
        content = file_path.read_text(encoding="utf-8")
        if content.strip().startswith("WEBVTT"):
            return parse_vtt(file_path)
        # Check for SRT pattern (number followed by timestamp with comma)
        if re.search(r"^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}", content, re.MULTILINE):
            return parse_srt(file_path)

        raise ValueError(
            f"Cannot determine subtitle format for {file_path}. "
            "Expected .vtt or .srt extension, or recognizable content."
        )


def transcribe_audio(audio_path: Path) -> list[dict]:
    """Transcribe audio using ElevenLabs Scribe v2.

    Args:
        audio_path: Path to the audio file.

    Returns:
        List of segment dicts with {text, start_time, end_time}.
        Words are grouped into sentence segments.

    Raises:
        ValueError: If ELEVENLABS_API_KEY environment variable is not set.
        RuntimeError: If transcription fails.
    """
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        raise ValueError(
            "ELEVENLABS_API_KEY environment variable is not set. "
            "Please set it to use ElevenLabs transcription."
        )

    from elevenlabs import ElevenLabs

    client = ElevenLabs(api_key=api_key)

    audio_path = Path(audio_path)
    with open(audio_path, "rb") as audio_file:
        # Use Speech to Text API (Scribe v2)
        result = client.speech_to_text.convert(
            file=audio_file,
            model_id="scribe_v1",  # Scribe v1 is the current model name in the API
        )

    # Group words into sentence segments
    segments = _group_words_into_segments(result)

    return segments


def _group_words_into_segments(transcription_result) -> list[dict]:
    """Group word-level timestamps into sentence segments.

    Args:
        transcription_result: ElevenLabs transcription result object.

    Returns:
        List of segment dicts with {text, start_time, end_time}.
    """
    segments = []

    # ElevenLabs returns words with timestamps
    # We need to group them into logical segments (sentences)
    if not hasattr(transcription_result, "words") or not transcription_result.words:
        # If no word-level data, return the full text as one segment
        if hasattr(transcription_result, "text") and transcription_result.text:
            return [{
                "text": transcription_result.text.strip(),
                "start_time": 0.0,
                "end_time": 0.0,
            }]
        return []

    words = transcription_result.words
    current_segment_words = []
    current_start = None

    # Sentence-ending punctuation
    sentence_endings = {".", "!", "?"}

    for word in words:
        word_text = word.text if hasattr(word, "text") else str(word.get("text", ""))
        word_start = word.start if hasattr(word, "start") else word.get("start", 0)
        word_end = word.end if hasattr(word, "end") else word.get("end", 0)

        if current_start is None:
            current_start = word_start

        current_segment_words.append(word_text)

        # Check if this word ends a sentence
        if word_text and word_text[-1] in sentence_endings:
            text = " ".join(current_segment_words).strip()
            if text:
                segments.append({
                    "text": text,
                    "start_time": current_start,
                    "end_time": word_end,
                })
            current_segment_words = []
            current_start = None

    # Handle remaining words (incomplete sentence at the end)
    if current_segment_words:
        text = " ".join(current_segment_words).strip()
        if text:
            last_word = words[-1]
            end_time = last_word.end if hasattr(last_word, "end") else last_word.get("end", 0)
            segments.append({
                "text": text,
                "start_time": current_start,
                "end_time": end_time,
            })

    return segments


def normalize_segments(
    segments: list[dict],
    min_duration: float = 0.5,
    merge_threshold: float = 1.0,
) -> list[dict]:
    """Normalize and clean up transcript segments.

    Args:
        segments: List of segment dicts with {text, start_time, end_time}.
        min_duration: Minimum segment duration in seconds. Shorter segments
            will be merged with adjacent ones.
        merge_threshold: Maximum gap (in seconds) between segments to merge
            when a segment is too short.

    Returns:
        Normalized list of segment dicts.
    """
    if not segments:
        return []

    normalized = []

    for segment in segments:
        # Clean up text
        text = segment["text"]
        # Normalize whitespace
        text = re.sub(r"\s+", " ", text).strip()
        # Remove leading/trailing punctuation-only content
        text = text.strip()

        if not text:
            continue

        start_time = float(segment["start_time"])
        end_time = float(segment["end_time"])

        # Ensure start_time < end_time
        if start_time >= end_time:
            # Try to fix by swapping or using a minimal duration
            if start_time > end_time:
                start_time, end_time = end_time, start_time
            else:
                # start_time == end_time, add minimal duration
                end_time = start_time + 0.1

        normalized.append({
            "text": text,
            "start_time": start_time,
            "end_time": end_time,
        })

    # Merge very short segments
    if min_duration > 0:
        normalized = _merge_short_segments(normalized, min_duration, merge_threshold)

    return normalized


def _merge_short_segments(
    segments: list[dict],
    min_duration: float,
    merge_threshold: float,
) -> list[dict]:
    """Merge segments that are too short with adjacent segments.

    Args:
        segments: List of normalized segments.
        min_duration: Minimum segment duration.
        merge_threshold: Maximum gap to allow merging.

    Returns:
        List of segments with short ones merged.
    """
    if not segments:
        return []

    result = []
    current = segments[0].copy()

    for i in range(1, len(segments)):
        next_seg = segments[i]
        current_duration = current["end_time"] - current["start_time"]

        # Check if current segment is too short and can be merged
        gap = next_seg["start_time"] - current["end_time"]

        if current_duration < min_duration and gap <= merge_threshold:
            # Merge with next segment
            current["text"] = current["text"] + " " + next_seg["text"]
            current["end_time"] = next_seg["end_time"]
        else:
            result.append(current)
            current = next_seg.copy()

    # Don't forget the last segment
    result.append(current)

    return result
