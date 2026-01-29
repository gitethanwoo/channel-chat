/**
 * Token-based transcript chunking with overlap.
 */

import { encode } from 'gpt-tokenizer';

// Types
export interface Segment {
  text: string;
  start_time: number;
  end_time: number;
}

export interface Chunk {
  text: string;
  start_time: number;
  end_time: number;
  seq: number;
}

/**
 * Count the number of tokens in a text string using GPT tokenizer.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Split transcript segments into overlapping chunks.
 */
export function chunkTranscript(
  segments: Segment[],
  videoTitle: string,
  targetTokens: number = 800,
  overlapPct: number = 0.15
): Chunk[] {
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let seq = 0;

  // Calculate overlap tokens
  const overlapTokens = Math.floor(targetTokens * overlapPct);

  // Current chunk state
  let currentSegments: Segment[] = [];
  let currentTokenCount = 0;

  // Segments to carry over for overlap
  let overlapSegments: Segment[] = [];
  let overlapTokenCount = 0;

  let i = 0;
  while (i < segments.length) {
    const segment = segments[i];
    const segmentText = segment.text;
    const segmentTokens = countTokens(segmentText);

    // Handle very long segments (longer than target)
    if (segmentTokens > targetTokens && currentSegments.length === 0) {
      // This segment alone exceeds target - emit it as its own chunk
      const chunkText = `${videoTitle} | ${segmentText}`;
      chunks.push({
        text: chunkText,
        start_time: segment.start_time,
        end_time: segment.end_time,
        seq,
      });
      seq++;
      i++;
      continue;
    }

    // Check if adding this segment exceeds target
    if (currentTokenCount + segmentTokens > targetTokens && currentSegments.length > 0) {
      // Emit current chunk
      const combinedText = currentSegments.map(s => s.text).join(' ');
      const chunkText = `${videoTitle} | ${combinedText}`;
      chunks.push({
        text: chunkText,
        start_time: currentSegments[0].start_time,
        end_time: currentSegments[currentSegments.length - 1].end_time,
        seq,
      });
      seq++;

      // Calculate overlap: keep segments from the end that total ~overlapTokens
      overlapSegments = [];
      overlapTokenCount = 0;
      for (let j = currentSegments.length - 1; j >= 0; j--) {
        const seg = currentSegments[j];
        const segTokens = countTokens(seg.text);
        if (overlapTokenCount + segTokens <= overlapTokens) {
          overlapSegments.unshift(seg);
          overlapTokenCount += segTokens;
        } else {
          // Include this segment if we have no overlap yet
          if (overlapSegments.length === 0) {
            overlapSegments.unshift(seg);
            overlapTokenCount += segTokens;
          }
          break;
        }
      }

      // Start new chunk with overlap
      currentSegments = [...overlapSegments];
      currentTokenCount = overlapTokenCount;
    }

    // Add segment to current chunk
    currentSegments.push(segment);
    currentTokenCount += segmentTokens;
    i++;
  }

  // Emit final chunk if we have remaining segments
  if (currentSegments.length > 0) {
    const combinedText = currentSegments.map(s => s.text).join(' ');
    const chunkText = `${videoTitle} | ${combinedText}`;
    chunks.push({
      text: chunkText,
      start_time: currentSegments[0].start_time,
      end_time: currentSegments[currentSegments.length - 1].end_time,
      seq,
    });
  }

  return chunks;
}
