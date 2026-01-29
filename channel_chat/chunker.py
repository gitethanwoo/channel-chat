"""Token-based transcript chunking with overlap."""

import tiktoken

# Use cl100k_base encoding (GPT-4 tokenizer)
_encoding = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    """Count the number of tokens in a text string."""
    return len(_encoding.encode(text))


def chunk_transcript(
    segments: list[dict],
    video_title: str,
    target_tokens: int = 800,
    overlap_pct: float = 0.15,
) -> list[dict]:
    """
    Split transcript segments into overlapping chunks.

    Args:
        segments: List of segments with {text, start_time, end_time}
        video_title: Title to prepend to each chunk
        target_tokens: Target token count per chunk (~800)
        overlap_pct: Percentage of overlap between chunks (~15%)

    Returns:
        List of chunks with {text, start_time, end_time, seq}
    """
    if not segments:
        return []

    chunks = []
    seq = 0

    # Calculate overlap tokens
    overlap_tokens = int(target_tokens * overlap_pct)

    # Current chunk state
    current_segments: list[dict] = []
    current_token_count = 0

    # Segments to carry over for overlap
    overlap_segments: list[dict] = []
    overlap_token_count = 0

    i = 0
    while i < len(segments):
        segment = segments[i]
        segment_text = segment["text"]
        segment_tokens = count_tokens(segment_text)

        # Handle very long segments (longer than target)
        if segment_tokens > target_tokens and not current_segments:
            # This segment alone exceeds target - emit it as its own chunk
            chunk_text = f"{video_title} | {segment_text}"
            chunks.append({
                "text": chunk_text,
                "start_time": segment["start_time"],
                "end_time": segment["end_time"],
                "seq": seq,
            })
            seq += 1
            i += 1
            continue

        # Check if adding this segment exceeds target
        if current_token_count + segment_tokens > target_tokens and current_segments:
            # Emit current chunk
            combined_text = " ".join(seg["text"] for seg in current_segments)
            chunk_text = f"{video_title} | {combined_text}"
            chunks.append({
                "text": chunk_text,
                "start_time": current_segments[0]["start_time"],
                "end_time": current_segments[-1]["end_time"],
                "seq": seq,
            })
            seq += 1

            # Calculate overlap: keep segments from the end that total ~overlap_tokens
            overlap_segments = []
            overlap_token_count = 0
            for seg in reversed(current_segments):
                seg_tokens = count_tokens(seg["text"])
                if overlap_token_count + seg_tokens <= overlap_tokens:
                    overlap_segments.insert(0, seg)
                    overlap_token_count += seg_tokens
                else:
                    # Include this segment if we have no overlap yet
                    if not overlap_segments:
                        overlap_segments.insert(0, seg)
                        overlap_token_count += seg_tokens
                    break

            # Start new chunk with overlap
            current_segments = list(overlap_segments)
            current_token_count = overlap_token_count

        # Add segment to current chunk
        current_segments.append(segment)
        current_token_count += segment_tokens
        i += 1

    # Emit final chunk if we have remaining segments
    if current_segments:
        combined_text = " ".join(seg["text"] for seg in current_segments)
        chunk_text = f"{video_title} | {combined_text}"
        chunks.append({
            "text": chunk_text,
            "start_time": current_segments[0]["start_time"],
            "end_time": current_segments[-1]["end_time"],
            "seq": seq,
        })

    return chunks
