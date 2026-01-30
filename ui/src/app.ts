/**
 * Channel Chat Video Player - MCP App
 *
 * Displays video with full seekable transcript from show_video tool.
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

// Types for show_video tool result
interface ShowVideoResult {
  video_id: string;
  video_title: string;
  channel_name: string;
  video_url: string;
  start_time: number;
  transcript_uri: string;
  description: string | null;
  reason: string | null;
}

interface TranscriptSegment {
  start_time: number;
  end_time: number;
  text: string;
}

interface TranscriptData {
  video_id: string;
  video_title: string;
  channel_name: string;
  segments: TranscriptSegment[];
}

// DOM Elements
const playerEl = document.querySelector(".video-player") as HTMLElement;
const titleEl = document.getElementById("video-title") as HTMLElement;
const channelEl = document.getElementById("channel-name") as HTMLElement;
const fallbackEl = document.getElementById("youtube-fallback") as HTMLElement;
const videoWrapper = document.getElementById("video-wrapper") as HTMLElement;
const transcriptSegmentsEl = document.getElementById("transcript-segments") as HTMLElement;
const expandBtn = document.getElementById("expand-btn") as HTMLButtonElement;
const videoContextEl = document.getElementById("video-context") as HTMLElement;
const videoReasonEl = document.getElementById("video-reason") as HTMLElement;
const videoDescriptionEl = document.getElementById("video-description") as HTMLElement;

let videoEl: HTMLVideoElement | null = null;
let currentSegmentIndex = -1;
let currentDisplayMode: "inline" | "fullscreen" = "inline";

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Seek video to a specific time
 */
function seekTo(time: number) {
  if (videoEl) {
    videoEl.currentTime = time;
    videoEl.play();
  }
}

/**
 * Highlight the current segment based on video time
 */
function updateCurrentSegment(currentTime: number, segments: TranscriptSegment[]) {
  const newIndex = segments.findIndex(
    (seg) => currentTime >= seg.start_time && currentTime < seg.end_time
  );

  if (newIndex !== currentSegmentIndex) {
    // Remove old highlight
    if (currentSegmentIndex >= 0) {
      const oldEl = document.querySelector(`[data-segment-index="${currentSegmentIndex}"]`);
      oldEl?.classList.remove("active");
    }

    // Add new highlight
    if (newIndex >= 0) {
      const newEl = document.querySelector(`[data-segment-index="${newIndex}"]`);
      newEl?.classList.add("active");

      // Scroll into view if needed
      newEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    currentSegmentIndex = newIndex;
  }
}

/**
 * Render the transcript segments
 */
function renderTranscript(segments: TranscriptSegment[]) {
  transcriptSegmentsEl.innerHTML = "";

  segments.forEach((segment, index) => {
    const segmentEl = document.createElement("div");
    segmentEl.className = "transcript-segment";
    segmentEl.dataset.segmentIndex = index.toString();

    const timestampEl = document.createElement("span");
    timestampEl.className = "segment-timestamp";
    timestampEl.textContent = formatTimestamp(segment.start_time);

    const textEl = document.createElement("span");
    textEl.className = "segment-text";
    textEl.textContent = segment.text;

    segmentEl.appendChild(timestampEl);
    segmentEl.appendChild(textEl);

    segmentEl.addEventListener("click", () => {
      seekTo(segment.start_time);
    });

    transcriptSegmentsEl.appendChild(segmentEl);
  });
}

/**
 * Render the video player with transcript
 */
function renderPlayer(
  videoUrl: string,
  videoId: string,
  startTime: number,
  segments: TranscriptSegment[]
) {
  // Create video element
  videoWrapper.innerHTML = `
    <video id="video-player" controls autoplay playsinline></video>
  `;

  videoEl = document.getElementById("video-player") as HTMLVideoElement;
  videoEl.src = videoUrl;

  // Set up time tracking for segment highlighting
  videoEl.addEventListener("timeupdate", () => {
    if (videoEl) {
      updateCurrentSegment(videoEl.currentTime, segments);
    }
  });

  // Seek to start time when ready
  videoEl.addEventListener(
    "loadedmetadata",
    () => {
      if (videoEl && startTime > 0) {
        videoEl.currentTime = startTime;
      }
    },
    { once: true }
  );

  // Render transcript
  renderTranscript(segments);

  // Highlight initial segment if starting mid-video
  if (startTime > 0) {
    const initialIndex = segments.findIndex(
      (seg) => startTime >= seg.start_time && startTime < seg.end_time
    );
    if (initialIndex >= 0) {
      const el = document.querySelector(`[data-segment-index="${initialIndex}"]`);
      el?.classList.add("active");
      el?.scrollIntoView({ behavior: "instant", block: "center" });
      currentSegmentIndex = initialIndex;
    }
  }
}

// Create MCP App
const app = new App({ name: "Channel Chat Player", version: "2.0.0" });

/**
 * Extract show_video result from tool output
 */
function extractShowVideoResult(result: CallToolResult): ShowVideoResult | null {
  if (result.structuredContent) {
    return result.structuredContent as ShowVideoResult;
  }

  const textContent = result.content?.find(
    (c): c is { type: "text"; text: string } => c.type === "text"
  );
  if (textContent) {
    try {
      return JSON.parse(textContent.text) as ShowVideoResult;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fetch transcript data from MCP resource
 */
async function fetchTranscript(transcriptUri: string): Promise<TranscriptData | null> {
  try {
    console.info("[Player] Fetching transcript:", transcriptUri);
    const resourceResult = await app.request(
      { method: "resources/read", params: { uri: transcriptUri } },
      ReadResourceResultSchema
    );

    const content = resourceResult.contents[0];
    if (!content || !("text" in content)) {
      console.error("[Player] Transcript resource did not contain text");
      return null;
    }

    return JSON.parse(content.text) as TranscriptData;
  } catch (err) {
    console.error("[Player] Error fetching transcript:", err);
    return null;
  }
}

/**
 * Toggle fullscreen mode via MCP displayMode API
 */
async function toggleFullscreen() {
  const newMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  try {
    const result = await app.requestDisplayMode({ mode: newMode });
    currentDisplayMode = result.mode as "inline" | "fullscreen";
    playerEl.classList.toggle("expanded", currentDisplayMode === "fullscreen");
    expandBtn.title = currentDisplayMode === "fullscreen" ? "Collapse view" : "Expand view";
    console.info("[Player] Display mode changed:", currentDisplayMode);
  } catch (err) {
    console.error("[Player] Failed to change display mode:", err);
  }
}

// Apply host theme and styles
function handleHostContextChanged(ctx: McpUiHostContext) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (ctx.safeAreaInsets) {
    playerEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    playerEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    playerEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    playerEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }

  // Show expand button only if fullscreen is available
  if (ctx.availableDisplayModes !== undefined) {
    const canFullscreen = ctx.availableDisplayModes.includes("fullscreen");
    expandBtn.classList.toggle("available", canFullscreen);
  }

  // Update display mode state and UI
  if (ctx.displayMode) {
    currentDisplayMode = ctx.displayMode as "inline" | "fullscreen";
    playerEl.classList.toggle("expanded", currentDisplayMode === "fullscreen");
    expandBtn.title = currentDisplayMode === "fullscreen" ? "Collapse view" : "Expand view";
  }
}

// Register handlers BEFORE connecting
app.onteardown = async () => {
  console.info("[Player] Teardown");
  return {};
};

app.ontoolinput = (params) => {
  console.info("[Player] Tool input:", params);
  playerEl.classList.add("loading");
};

app.ontoolresult = async (result) => {
  console.info("[Player] Tool result:", result);

  const showVideo = extractShowVideoResult(result);
  if (!showVideo) {
    titleEl.textContent = "Error";
    transcriptSegmentsEl.innerHTML = '<div class="transcript-segment"><span class="segment-text">Could not parse video data.</span></div>';
    playerEl.classList.remove("loading");
    return;
  }

  // Update video info
  titleEl.textContent = showVideo.video_title;
  channelEl.textContent = showVideo.channel_name;
  fallbackEl.innerHTML = `<a href="https://youtube.com/watch?v=${showVideo.video_id}" target="_blank">Watch on YouTube</a>`;

  // Update context (reason and description)
  const hasReason = showVideo.reason && showVideo.reason.trim().length > 0;
  const hasDescription = showVideo.description && showVideo.description.trim().length > 0;

  if (hasReason || hasDescription) {
    videoContextEl.style.display = "block";

    if (hasReason) {
      videoReasonEl.innerHTML = `<strong>Why this:</strong> ${showVideo.reason}`;
      videoReasonEl.style.display = "block";
    } else {
      videoReasonEl.style.display = "none";
    }

    if (hasDescription) {
      // Show full description (no truncation)
      videoDescriptionEl.textContent = showVideo.description!;
      videoDescriptionEl.style.display = "block";
    } else {
      videoDescriptionEl.style.display = "none";
    }
  } else {
    videoContextEl.style.display = "none";
  }

  // Fetch full transcript
  const transcript = await fetchTranscript(showVideo.transcript_uri);

  if (!transcript || !transcript.segments.length) {
    // Fallback: show video without transcript
    renderPlayer(showVideo.video_url, showVideo.video_id, showVideo.start_time, []);
    transcriptSegmentsEl.innerHTML = '<div class="transcript-segment"><span class="segment-text">Transcript not available.</span></div>';
  } else {
    renderPlayer(showVideo.video_url, showVideo.video_id, showVideo.start_time, transcript.segments);
  }

  playerEl.classList.remove("loading");
};

app.ontoolcancelled = () => {
  console.info("[Player] Tool cancelled");
  playerEl.classList.remove("loading");
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

// Set up expand toggle button
expandBtn.addEventListener("click", toggleFullscreen);

// Handle Escape key to exit fullscreen
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentDisplayMode === "fullscreen") {
    toggleFullscreen();
  }
});

// Connect to host
app.connect().then(() => {
  console.info("[Player] Connected to host");
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
