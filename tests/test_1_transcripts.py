"""Test 1: Retrieve transcripts from 5 Alex Hormozi videos."""

import sys
import tempfile
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from channel_chat.downloader import get_channel_info, get_channel_videos, get_video_info, download_subtitles
from channel_chat.transcriber import parse_subtitles

def main():
    channel_url = "https://www.youtube.com/@AlexHormozi"

    print("=" * 60)
    print("TEST 1: Transcript Retrieval")
    print("=" * 60)

    # Step 1: Get channel info
    print("\n[1/4] Getting channel info...")
    channel_info = get_channel_info(channel_url)
    print(f"  Channel ID: {channel_info['channel_id']}")
    print(f"  Channel Name: {channel_info['name']}")

    # Step 2: Get video list
    print("\n[2/4] Getting video list...")
    video_ids = get_channel_videos(channel_url)
    print(f"  Found {len(video_ids)} videos")
    print(f"  Testing with first 5 videos...")

    test_videos = video_ids[:5]

    # Step 3: Get video metadata
    print("\n[3/4] Getting video metadata...")
    videos_info = []
    for vid in test_videos:
        info = get_video_info(vid)
        videos_info.append(info)
        print(f"  - {info['title'][:50]}... ({info['duration']}s)")

    # Step 4: Download and parse subtitles
    print("\n[4/4] Downloading and parsing subtitles...")
    results = []

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)

        for info in videos_info:
            vid = info['id']
            print(f"\n  Processing: {info['title'][:40]}...")

            # Try to download subtitles
            subtitle_path = download_subtitles(vid, tmppath)

            if subtitle_path:
                print(f"    Subtitles found: {subtitle_path.name}")
                segments = parse_subtitles(subtitle_path)
                print(f"    Parsed {len(segments)} segments")

                # Show first segment as sample
                if segments:
                    first = segments[0]
                    print(f"    First segment: [{first['start_time']:.1f}s] {first['text'][:50]}...")

                results.append({
                    'video_id': vid,
                    'title': info['title'],
                    'segments': segments,
                    'source': 'youtube'
                })
            else:
                print(f"    No subtitles available (would need ElevenLabs transcription)")
                results.append({
                    'video_id': vid,
                    'title': info['title'],
                    'segments': None,
                    'source': None
                })

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    success_count = sum(1 for r in results if r['segments'])
    print(f"Successfully retrieved transcripts: {success_count}/{len(results)}")

    for r in results:
        status = f"{len(r['segments'])} segments" if r['segments'] else "NO SUBTITLES"
        print(f"  [{status}] {r['title'][:50]}")

    if success_count > 0:
        print("\n✓ TEST 1 PASSED: Transcript retrieval working")
        return results
    else:
        print("\n✗ TEST 1 FAILED: Could not retrieve any transcripts")
        return None

if __name__ == "__main__":
    main()
