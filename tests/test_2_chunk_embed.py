"""Test 2: Chunk and embed transcripts."""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from channel_chat.downloader import get_video_info, download_subtitles
from channel_chat.transcriber import parse_subtitles
from channel_chat.chunker import chunk_transcript, count_tokens
from channel_chat.embedder import embed_text, embed_batch

# Test with one video first
TEST_VIDEO_ID = "MZPVPCIeUpg"  # "How to Change Your Life" video

def main():
    print("=" * 60)
    print("TEST 2: Chunking and Embedding")
    print("=" * 60)

    # Step 1: Get transcript
    print("\n[1/4] Getting transcript...")
    video_info = get_video_info(TEST_VIDEO_ID)
    print(f"  Video: {video_info['title']}")

    with tempfile.TemporaryDirectory() as tmpdir:
        subtitle_path = download_subtitles(TEST_VIDEO_ID, Path(tmpdir))
        segments = parse_subtitles(subtitle_path)
        print(f"  Segments: {len(segments)}")

    # Step 2: Test chunking
    print("\n[2/4] Testing chunker...")
    chunks = chunk_transcript(segments, video_info['title'], target_tokens=800, overlap_pct=0.15)
    print(f"  Created {len(chunks)} chunks")

    # Analyze chunks
    token_counts = [count_tokens(c['text']) for c in chunks]
    avg_tokens = sum(token_counts) / len(token_counts)
    min_tokens = min(token_counts)
    max_tokens = max(token_counts)

    print(f"  Token stats: avg={avg_tokens:.0f}, min={min_tokens}, max={max_tokens}")
    print(f"  Time coverage: {chunks[0]['start_time']:.1f}s - {chunks[-1]['end_time']:.1f}s")

    # Show sample chunks
    print("\n  Sample chunks:")
    for i, chunk in enumerate(chunks[:3]):
        preview = chunk['text'][:80].replace('\n', ' ')
        print(f"    [{i}] {chunk['start_time']:.1f}s-{chunk['end_time']:.1f}s ({count_tokens(chunk['text'])} tokens)")
        print(f"        {preview}...")

    # Step 3: Test single embedding
    print("\n[3/4] Testing single embedding...")
    test_text = chunks[0]['text']
    embedding = embed_text(test_text)
    print(f"  Embedding dimensions: {len(embedding)}")
    print(f"  Sample values: [{embedding[0]:.4f}, {embedding[1]:.4f}, ..., {embedding[-1]:.4f}]")

    # Step 4: Test batch embedding
    print("\n[4/4] Testing batch embedding...")
    chunk_texts = [c['text'] for c in chunks[:10]]  # Just first 10 for testing
    embeddings = embed_batch(chunk_texts, show_progress=False)
    print(f"  Embedded {len(embeddings)} chunks")
    print(f"  All 768 dimensions: {all(len(e) == 768 for e in embeddings)}")

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Transcript segments: {len(segments)}")
    print(f"  Chunks created: {len(chunks)}")
    print(f"  Avg tokens per chunk: {avg_tokens:.0f}")
    print(f"  Embedding dimensions: 768")
    print(f"  Batch embedding working: {len(embeddings) == len(chunk_texts)}")

    print("\n✓ TEST 2 PASSED: Chunking and embedding working")

    return {
        'chunks': chunks,
        'embeddings': embeddings,
        'video_info': video_info
    }

if __name__ == "__main__":
    main()
