/**
 * One-time script to dedupe VTT transcript artifacts in R2.
 * Run with: npx wrangler --env production d1 execute ... or via worker endpoint
 */

interface Segment {
  text: string;
  start_time: number;
  end_time: number;
}

function dedupeSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];

  const result: Segment[] = [];
  let prevText = '';

  for (const seg of segments) {
    // Skip exact duplicates of previous segment
    if (seg.text === prevText) continue;

    // Skip very short segments (< 0.05s) that are just timing artifacts
    const duration = seg.end_time - seg.start_time;
    if (duration < 0.05 && result.length > 0) continue;

    result.push(seg);
    prevText = seg.text;
  }

  return result;
}

// This will be called via a worker endpoint
export async function dedupeTranscript(
  r2: R2Bucket,
  transcriptKey: string
): Promise<{ before: number; after: number } | null> {
  const obj = await r2.get(transcriptKey);
  if (!obj) return null;

  const text = await obj.text();
  const segments: Segment[] = JSON.parse(text);
  const deduped = dedupeSegments(segments);

  // Only update if we actually removed duplicates
  if (deduped.length < segments.length) {
    await r2.put(transcriptKey, JSON.stringify(deduped), {
      httpMetadata: { contentType: 'application/json' },
    });
    return { before: segments.length, after: deduped.length };
  }

  return { before: segments.length, after: segments.length };
}

export async function dedupeAllTranscripts(
  db: D1Database,
  r2: R2Bucket,
  dryRun: boolean = true
): Promise<{ processed: number; updated: number; results: Array<{ videoId: string; before: number; after: number }> }> {
  // Get all videos with R2 transcripts
  const videos = await db
    .prepare('SELECT id, r2_transcript_key FROM videos WHERE r2_transcript_key IS NOT NULL')
    .all<{ id: string; r2_transcript_key: string }>();

  const results: Array<{ videoId: string; before: number; after: number }> = [];
  let updated = 0;

  for (const video of videos.results) {
    const obj = await r2.get(video.r2_transcript_key);
    if (!obj) continue;

    const text = await obj.text();
    const segments: Segment[] = JSON.parse(text);
    const deduped = dedupeSegments(segments);

    if (deduped.length < segments.length) {
      results.push({
        videoId: video.id,
        before: segments.length,
        after: deduped.length,
      });

      if (!dryRun) {
        await r2.put(video.r2_transcript_key, JSON.stringify(deduped), {
          httpMetadata: { contentType: 'application/json' },
        });
        updated++;
      }
    }
  }

  return {
    processed: videos.results.length,
    updated: dryRun ? 0 : updated,
    results,
  };
}
