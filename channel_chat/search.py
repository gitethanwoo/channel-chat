"""Search module with vector similarity search for channel-chat."""

from .database import get_connection, init_db, search_chunks
from .embedder import embed_text


def format_timestamp(seconds: float) -> str:
    """Format seconds into a human-readable timestamp.

    Args:
        seconds: Time in seconds.

    Returns:
        Formatted string like "1:23" or "1:23:45".
    """
    total_seconds = int(seconds)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    else:
        return f"{minutes}:{secs:02d}"


def seconds_to_youtube_time(seconds: float) -> int:
    """Convert seconds to YouTube URL time parameter.

    Args:
        seconds: Time in seconds (float).

    Returns:
        Rounded integer seconds for YouTube URL.
    """
    return round(seconds)


def search(query: str, limit: int = 10) -> list[dict]:
    """Search for chunks similar to the query.

    Args:
        query: The search query text.
        limit: Maximum number of results to return (default: 10).

    Returns:
        List of search results with formatted output including YouTube links.
    """
    # Embed the query
    query_embedding = embed_text(query)

    # Get database connection and search
    conn = get_connection()
    init_db(conn)
    raw_results = search_chunks(conn, query_embedding, limit)
    conn.close()

    # Format results
    results = []
    for row in raw_results:
        # Extract text without title prefix if present
        text = row["text"]
        video_title = row["video_title"]

        # Remove title prefix if the text starts with it
        title_prefix = f"{video_title}: "
        if text.startswith(title_prefix):
            text = text[len(title_prefix):]

        # Calculate similarity score (1 - distance)
        score = 1 - row["distance"]

        # Build YouTube URL with timestamp
        youtube_time = seconds_to_youtube_time(row["start_time"])
        youtube_url = f"https://youtube.com/watch?v={row['video_id']}&t={youtube_time}"

        results.append({
            "text": text,
            "video_title": video_title,
            "video_id": row["video_id"],
            "channel_name": row["channel_name"],
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "youtube_url": youtube_url,
            "score": score,
        })

    return results
