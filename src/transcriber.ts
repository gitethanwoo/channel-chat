/**
 * Transcription and subtitle parsing for YouTube videos.
 */

import { readFile } from 'fs/promises';

// Types
export interface Segment {
  text: string;
  start_time: number;
  end_time: number;
}

/**
 * Parse VTT timestamp to seconds.
 * Supports formats:
 * - 00:00:00.000 (hours:minutes:seconds.milliseconds)
 * - 00:00.000 (minutes:seconds.milliseconds)
 */
function parseVttTimestamp(timestamp: string): number {
  const parts = timestamp.trim().split(':');
  let hours = 0;
  let minutes: number;
  let seconds: number;

  if (parts.length === 3) {
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
    seconds = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10);
    seconds = parseFloat(parts[1]);
  } else {
    throw new Error(`Invalid VTT timestamp format: ${timestamp}`);
  }

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse SRT timestamp to seconds.
 * Format: 00:00:00,000 (hours:minutes:seconds,milliseconds)
 */
function parseSrtTimestamp(timestamp: string): number {
  // SRT uses comma as decimal separator
  const normalized = timestamp.trim().replace(',', '.');
  const parts = normalized.split(':');

  if (parts.length !== 3) {
    throw new Error(`Invalid SRT timestamp format: ${timestamp}`);
  }

  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Deduplicate VTT segments that have rolling/scrolling text.
 * YouTube captions often show scrolling text where each cue contains
 * previous text plus new text.
 */
function deduplicateVttSegments(segments: Segment[]): Segment[] {
  if (segments.length === 0) return [];

  const result: Segment[] = [];
  let prevText = '';

  for (const segment of segments) {
    const text = segment.text;
    let newText: string;

    // If current text starts with previous text, extract only new part
    if (prevText && text.startsWith(prevText)) {
      newText = text.slice(prevText.length).trim();
    } else if (prevText && text.includes(prevText)) {
      // Previous text is somewhere in current text - extract after it
      const idx = text.indexOf(prevText);
      newText = text.slice(idx + prevText.length).trim();
    } else {
      newText = text;
    }

    if (newText) {
      result.push({
        text: newText,
        start_time: segment.start_time,
        end_time: segment.end_time,
      });
    }

    prevText = text;
  }

  return result;
}

/**
 * Parse a VTT subtitle file.
 */
export async function parseVtt(filePath: string): Promise<Segment[]> {
  const content = await readFile(filePath, 'utf-8');
  const segments: Segment[] = [];

  const lines = content.split('\n');
  let startIdx = 0;

  // Find WEBVTT header
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === 'WEBVTT' || line.startsWith('WEBVTT ')) {
      startIdx = i + 1;
      break;
    }
  }

  // Skip header metadata until first timestamp
  while (startIdx < lines.length) {
    const line = lines[startIdx].trim();
    if (line.includes('-->')) break;
    startIdx++;
  }

  // Parse cues
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip empty lines and cue identifiers
    if (!line || (line && !line.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->'))) {
      i++;
      continue;
    }

    // Look for timestamp line
    if (line.includes('-->')) {
      const timestampMatch = line.match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (timestampMatch) {
        const startTime = parseVttTimestamp(timestampMatch[1]);
        const endTime = parseVttTimestamp(timestampMatch[2]);

        // Collect text lines
        const textLines: string[] = [];
        i++;
        while (i < lines.length) {
          const textLine = lines[i];
          // Stop at empty line or next timestamp
          if (!textLine.trim()) break;
          if (textLine.includes('-->')) {
            i--;
            break;
          }
          // Only keep lines with inline timestamps (new content)
          const hasInlineTimestamps = textLine.includes('<c>') || /\d{2}:\d{2}/.test(textLine);
          if (hasInlineTimestamps || textLines.length === 0) {
            // Remove VTT formatting tags
            let cleanLine = textLine.replace(/<[^>]+>/g, '');
            if (hasInlineTimestamps) {
              textLines.push(cleanLine.trim());
            }
          }
          i++;
        }

        const text = textLines.join(' ').trim();
        if (text) {
          segments.push({ text, start_time: startTime, end_time: endTime });
        }
      }
    }

    i++;
  }

  // Deduplicate rolling/scrolling text
  return deduplicateVttSegments(segments);
}

/**
 * Parse an SRT subtitle file.
 */
export async function parseSrt(filePath: string): Promise<Segment[]> {
  const content = await readFile(filePath, 'utf-8');
  const segments: Segment[] = [];

  // Split by double newlines to get blocks
  const blocks = content.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timestamp line
    let timestampIdx: number | null = null;
    for (let idx = 0; idx < lines.length; idx++) {
      if (lines[idx].includes('-->')) {
        timestampIdx = idx;
        break;
      }
    }

    if (timestampIdx === null) continue;

    // Parse timestamp
    const timestampLine = lines[timestampIdx];
    const timestampMatch = timestampLine.match(/([\d:,]+)\s*-->\s*([\d:,]+)/);
    if (!timestampMatch) continue;

    const startTime = parseSrtTimestamp(timestampMatch[1]);
    const endTime = parseSrtTimestamp(timestampMatch[2]);

    // Text is everything after the timestamp line
    const textLines = lines.slice(timestampIdx + 1);
    let text = textLines.join(' ');
    // Remove SRT formatting tags
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/\{[^}]+\}/g, '');
    text = text.trim();

    if (text) {
      segments.push({ text, start_time: startTime, end_time: endTime });
    }
  }

  return segments;
}

/**
 * Auto-detect subtitle format and parse.
 */
export async function parseSubtitles(filePath: string): Promise<Segment[]> {
  const suffix = filePath.toLowerCase().split('.').pop();

  if (suffix === 'vtt') {
    return parseVtt(filePath);
  } else if (suffix === 'srt') {
    return parseSrt(filePath);
  } else {
    // Try to detect from content
    const content = await readFile(filePath, 'utf-8');
    if (content.trim().startsWith('WEBVTT')) {
      return parseVtt(filePath);
    }
    // Check for SRT pattern
    if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}/m.test(content)) {
      return parseSrt(filePath);
    }

    throw new Error(
      `Cannot determine subtitle format for ${filePath}. ` +
      'Expected .vtt or .srt extension, or recognizable content.'
    );
  }
}

/**
 * Transcribe audio using ElevenLabs Scribe.
 */
export async function transcribeAudio(audioPath: string): Promise<Segment[]> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ELEVENLABS_API_KEY environment variable is not set. ' +
      'Please set it to use ElevenLabs transcription.'
    );
  }

  const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
  const { createReadStream } = await import('fs');

  const client = new ElevenLabsClient({ apiKey });

  const audioFile = createReadStream(audioPath);
  const result = await client.speechToText.convert({
    file: audioFile,
    modelId: 'scribe_v1',
  });

  // Group words into sentence segments
  return groupWordsIntoSegments(result);
}

/**
 * Group word-level timestamps into sentence segments.
 */
function groupWordsIntoSegments(transcriptionResult: any): Segment[] {
  const segments: Segment[] = [];

  if (!transcriptionResult.words || transcriptionResult.words.length === 0) {
    // If no word-level data, return the full text as one segment
    if (transcriptionResult.text) {
      return [{
        text: transcriptionResult.text.trim(),
        start_time: 0,
        end_time: 0,
      }];
    }
    return [];
  }

  const words = transcriptionResult.words;
  let currentSegmentWords: string[] = [];
  let currentStart: number | null = null;

  const sentenceEndings = new Set(['.', '!', '?']);

  for (const word of words) {
    const wordText = word.text || '';
    const wordStart = word.start || 0;
    const wordEnd = word.end || 0;

    if (currentStart === null) {
      currentStart = wordStart;
    }

    currentSegmentWords.push(wordText);

    // Check if this word ends a sentence
    if (wordText && sentenceEndings.has(wordText[wordText.length - 1])) {
      const text = currentSegmentWords.join(' ').trim();
      if (text && currentStart !== null) {
        segments.push({
          text,
          start_time: currentStart,
          end_time: wordEnd,
        });
      }
      currentSegmentWords = [];
      currentStart = null;
    }
  }

  // Handle remaining words
  if (currentSegmentWords.length > 0) {
    const text = currentSegmentWords.join(' ').trim();
    if (text && currentStart !== null) {
      const lastWord = words[words.length - 1];
      segments.push({
        text,
        start_time: currentStart,
        end_time: lastWord.end ?? 0,
      });
    }
  }

  return segments;
}

/**
 * Normalize and clean up transcript segments.
 */
export function normalizeSegments(
  segments: Segment[],
  minDuration: number = 0.5,
  mergeThreshold: number = 1.0
): Segment[] {
  if (segments.length === 0) return [];

  const normalized: Segment[] = [];

  for (const segment of segments) {
    // Clean up text
    let text = segment.text;
    text = text.replace(/\s+/g, ' ').trim();

    if (!text) continue;

    let startTime = segment.start_time;
    let endTime = segment.end_time;

    // Ensure start_time < end_time
    if (startTime >= endTime) {
      if (startTime > endTime) {
        [startTime, endTime] = [endTime, startTime];
      } else {
        endTime = startTime + 0.1;
      }
    }

    normalized.push({ text, start_time: startTime, end_time: endTime });
  }

  // Merge very short segments
  if (minDuration > 0) {
    return mergeShortSegments(normalized, minDuration, mergeThreshold);
  }

  return normalized;
}

/**
 * Merge segments that are too short with adjacent segments.
 */
function mergeShortSegments(
  segments: Segment[],
  minDuration: number,
  mergeThreshold: number
): Segment[] {
  if (segments.length === 0) return [];

  const result: Segment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const nextSeg = segments[i];
    const currentDuration = current.end_time - current.start_time;
    const gap = nextSeg.start_time - current.end_time;

    if (currentDuration < minDuration && gap <= mergeThreshold) {
      // Merge with next segment
      current.text = current.text + ' ' + nextSeg.text;
      current.end_time = nextSeg.end_time;
    } else {
      result.push(current);
      current = { ...nextSeg };
    }
  }

  result.push(current);
  return result;
}
