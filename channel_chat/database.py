"""SQLite + sqlite-vec database operations."""

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

import sqlite_vec


def get_db_path() -> Path:
    """Get the database path in user's data directory."""
    data_dir = Path.home() / ".channel-chat"
    data_dir.mkdir(exist_ok=True)
    return data_dir / "channel_chat.db"


def get_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Get a database connection with sqlite-vec loaded."""
    if db_path is None:
        db_path = get_db_path()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Initialize database schema."""
    conn.executescript("""
        -- Channels
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            name TEXT,
            url TEXT,
            indexed_at TIMESTAMP
        );

        -- Videos
        CREATE TABLE IF NOT EXISTS videos (
            id TEXT PRIMARY KEY,
            channel_id TEXT REFERENCES channels(id),
            title TEXT,
            description TEXT,
            duration INTEGER,
            published_at TIMESTAMP,
            thumbnail_url TEXT,
            transcript_source TEXT
        );

        -- Transcript chunks
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            video_id TEXT REFERENCES videos(id),
            seq INTEGER,
            start_time REAL,
            end_time REAL,
            text TEXT
        );

        -- Create index for faster lookups
        CREATE INDEX IF NOT EXISTS idx_chunks_video_id ON chunks(video_id);
        CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
    """)

    # Create vector table if it doesn't exist
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
    )
    if cursor.fetchone() is None:
        conn.execute("""
            CREATE VIRTUAL TABLE chunks_vec USING vec0(
                chunk_id INTEGER PRIMARY KEY,
                embedding float[768]
            )
        """)

    conn.commit()


# Channel operations
def upsert_channel(conn: sqlite3.Connection, channel_id: str, name: str, url: str) -> None:
    """Insert or update a channel."""
    conn.execute(
        """
        INSERT INTO channels (id, name, url, indexed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            url = excluded.url,
            indexed_at = excluded.indexed_at
        """,
        (channel_id, name, url, datetime.now().isoformat())
    )
    conn.commit()


def get_channel(conn: sqlite3.Connection, channel_id: str) -> Optional[sqlite3.Row]:
    """Get a channel by ID."""
    cursor = conn.execute("SELECT * FROM channels WHERE id = ?", (channel_id,))
    return cursor.fetchone()


def list_channels(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """List all indexed channels."""
    cursor = conn.execute("SELECT * FROM channels ORDER BY indexed_at DESC")
    return cursor.fetchall()


# Video operations
def upsert_video(
    conn: sqlite3.Connection,
    video_id: str,
    channel_id: str,
    title: str,
    description: str,
    duration: int,
    published_at: str,
    thumbnail_url: str,
    transcript_source: str,
) -> None:
    """Insert or update a video."""
    conn.execute(
        """
        INSERT INTO videos (id, channel_id, title, description, duration, published_at, thumbnail_url, transcript_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            channel_id = excluded.channel_id,
            title = excluded.title,
            description = excluded.description,
            duration = excluded.duration,
            published_at = excluded.published_at,
            thumbnail_url = excluded.thumbnail_url,
            transcript_source = excluded.transcript_source
        """,
        (video_id, channel_id, title, description, duration, published_at, thumbnail_url, transcript_source)
    )
    conn.commit()


def get_video(conn: sqlite3.Connection, video_id: str) -> Optional[sqlite3.Row]:
    """Get a video by ID."""
    cursor = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,))
    return cursor.fetchone()


def list_videos(conn: sqlite3.Connection, channel_id: Optional[str] = None) -> list[sqlite3.Row]:
    """List videos, optionally filtered by channel."""
    if channel_id:
        cursor = conn.execute(
            "SELECT * FROM videos WHERE channel_id = ? ORDER BY published_at DESC",
            (channel_id,)
        )
    else:
        cursor = conn.execute("SELECT * FROM videos ORDER BY published_at DESC")
    return cursor.fetchall()


def video_exists(conn: sqlite3.Connection, video_id: str) -> bool:
    """Check if a video is already indexed."""
    cursor = conn.execute("SELECT 1 FROM videos WHERE id = ?", (video_id,))
    return cursor.fetchone() is not None


# Chunk operations
def delete_video_chunks(conn: sqlite3.Connection, video_id: str) -> None:
    """Delete all chunks for a video (including vectors)."""
    # Get chunk IDs first
    cursor = conn.execute("SELECT id FROM chunks WHERE video_id = ?", (video_id,))
    chunk_ids = [row["id"] for row in cursor.fetchall()]

    # Delete from vector table
    for chunk_id in chunk_ids:
        conn.execute("DELETE FROM chunks_vec WHERE chunk_id = ?", (chunk_id,))

    # Delete chunks
    conn.execute("DELETE FROM chunks WHERE video_id = ?", (video_id,))
    conn.commit()


def insert_chunk(
    conn: sqlite3.Connection,
    video_id: str,
    seq: int,
    start_time: float,
    end_time: float,
    text: str,
) -> int:
    """Insert a chunk and return its ID."""
    cursor = conn.execute(
        """
        INSERT INTO chunks (video_id, seq, start_time, end_time, text)
        VALUES (?, ?, ?, ?, ?)
        """,
        (video_id, seq, start_time, end_time, text)
    )
    conn.commit()
    return cursor.lastrowid


def insert_chunk_embedding(conn: sqlite3.Connection, chunk_id: int, embedding: list[float]) -> None:
    """Insert a chunk embedding into the vector table."""
    conn.execute(
        "INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)",
        (chunk_id, sqlite_vec.serialize_float32(embedding))
    )
    conn.commit()


def search_chunks(
    conn: sqlite3.Connection,
    query_embedding: list[float],
    limit: int = 10,
) -> list[dict]:
    """Search for similar chunks using vector similarity."""
    cursor = conn.execute(
        """
        SELECT
            chunks_vec.chunk_id,
            chunks_vec.distance,
            chunks.text,
            chunks.start_time,
            chunks.end_time,
            chunks.video_id,
            videos.title as video_title,
            videos.channel_id,
            channels.name as channel_name
        FROM chunks_vec
        JOIN chunks ON chunks.id = chunks_vec.chunk_id
        JOIN videos ON videos.id = chunks.video_id
        JOIN channels ON channels.id = videos.channel_id
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
        """,
        (sqlite_vec.serialize_float32(query_embedding), limit)
    )

    results = []
    for row in cursor.fetchall():
        results.append({
            "chunk_id": row["chunk_id"],
            "distance": row["distance"],
            "text": row["text"],
            "start_time": row["start_time"],
            "end_time": row["end_time"],
            "video_id": row["video_id"],
            "video_title": row["video_title"],
            "channel_id": row["channel_id"],
            "channel_name": row["channel_name"],
        })
    return results


def get_stats(conn: sqlite3.Connection) -> dict:
    """Get database statistics."""
    stats = {}

    cursor = conn.execute("SELECT COUNT(*) as count FROM channels")
    stats["channels"] = cursor.fetchone()["count"]

    cursor = conn.execute("SELECT COUNT(*) as count FROM videos")
    stats["videos"] = cursor.fetchone()["count"]

    cursor = conn.execute("SELECT COUNT(*) as count FROM chunks")
    stats["chunks"] = cursor.fetchone()["count"]

    return stats
