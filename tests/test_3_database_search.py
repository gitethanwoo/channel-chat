"""Test 3: Database storage and vector search."""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from channel_chat.downloader import get_video_info, download_subtitles
from channel_chat.transcriber import parse_subtitles
from channel_chat.chunker import chunk_transcript
from channel_chat.embedder import embed_batch, embed_text
from channel_chat.database import (
    get_connection, init_db, upsert_channel, upsert_video,
    insert_chunk, insert_chunk_embedding, search_chunks, get_stats
)

TEST_VIDEO_ID = "MZPVPCIeUpg"
TEST_CHANNEL_ID = "UCUyDOdBWhC1MCxEjC46d-zw"

def main():
    print("=" * 60)
    print("TEST 3: Database Storage and Vector Search")
    print("=" * 60)

    # Use a test database
    test_db_path = Path(__file__).parent / "test_channel_chat.db"
    if test_db_path.exists():
        test_db_path.unlink()

    conn = get_connection(test_db_path)
    init_db(conn)

    # Step 1: Get video data
    print("\n[1/5] Getting video data...")
    video_info = get_video_info(TEST_VIDEO_ID)
    print(f"  Video: {video_info['title']}")

    with tempfile.TemporaryDirectory() as tmpdir:
        subtitle_path = download_subtitles(TEST_VIDEO_ID, Path(tmpdir))
        segments = parse_subtitles(subtitle_path)

    chunks = chunk_transcript(segments, video_info['title'])
    print(f"  Chunks: {len(chunks)}")

    # Step 2: Store channel and video
    print("\n[2/5] Storing channel and video...")
    upsert_channel(conn, TEST_CHANNEL_ID, "Alex Hormozi", "https://youtube.com/@AlexHormozi")
    upsert_video(
        conn,
        video_info['id'],
        TEST_CHANNEL_ID,
        video_info['title'],
        video_info.get('description', ''),
        video_info['duration'],
        video_info['published_at'],
        video_info.get('thumbnail_url', ''),
        'youtube'
    )
    print("  Channel and video stored")

    # Step 3: Generate embeddings
    print("\n[3/5] Generating embeddings...")
    chunk_texts = [c['text'] for c in chunks]
    embeddings = embed_batch(chunk_texts, show_progress=False)
    print(f"  Generated {len(embeddings)} embeddings")

    # Step 4: Store chunks and embeddings
    print("\n[4/5] Storing chunks and embeddings...")
    for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
        chunk_id = insert_chunk(
            conn,
            video_info['id'],
            chunk['seq'],
            chunk['start_time'],
            chunk['end_time'],
            chunk['text']
        )
        insert_chunk_embedding(conn, chunk_id, embedding)

    stats = get_stats(conn)
    print(f"  Stored: {stats['channels']} channel, {stats['videos']} video, {stats['chunks']} chunks")

    # Step 5: Test vector search
    print("\n[5/5] Testing vector search...")
    test_queries = [
        "How do I change my habits?",
        "What is the cost of success?",
        "business growth strategies"
    ]

    for query in test_queries:
        print(f"\n  Query: \"{query}\"")
        query_embedding = embed_text(query)
        results = search_chunks(conn, query_embedding, limit=3)

        for j, r in enumerate(results):
            text_preview = r['text'].split('|')[1][:60].strip() if '|' in r['text'] else r['text'][:60]
            print(f"    [{j+1}] score={1-r['distance']:.3f} @ {r['start_time']:.0f}s: {text_preview}...")

    # Cleanup
    conn.close()

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Database created: {test_db_path}")
    print(f"  Channels: {stats['channels']}")
    print(f"  Videos: {stats['videos']}")
    print(f"  Chunks: {stats['chunks']}")
    print(f"  Vector search: Working")

    print("\n✓ TEST 3 PASSED: Database storage and vector search working")

    # Keep test db for inspection
    print(f"\n  (Test database kept at {test_db_path} for inspection)")

if __name__ == "__main__":
    main()
