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

interface OpenAIWidgetGlobals {
  toolOutput?: ShowVideoResult;
}

interface YouTubePlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  getCurrentTime(): number;
}

interface YouTubeNamespace {
  Player: new (
    elementId: string | HTMLElement,
    options: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: { target: YouTubePlayer }) => void;
      };
    }
  ) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
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
const descriptionToggleEl = document.getElementById("description-toggle") as HTMLButtonElement;

let videoEl: HTMLVideoElement | null = null;
let embedIframe: HTMLIFrameElement | null = null;
let currentEmbedVideoId: string | null = null;
let ytPlayer: YouTubePlayer | null = null;
let ytPollId: number | null = null;
let currentSegmentIndex = -1;
let currentDisplayMode: "inline" | "fullscreen" = "inline";
let descriptionExpanded = false;
const openaiGlobals = (window as unknown as { openai?: OpenAIWidgetGlobals }).openai ?? null;
const isOpenAIWidget = openaiGlobals !== null;

// State for model context updates
let currentVideoInfo: ShowVideoResult | null = null;
let currentTranscriptSegments: TranscriptSegment[] = [];
let lastContextUpdateTime = 0;
const CONTEXT_UPDATE_INTERVAL = 3000; // Update every 3 seconds max

/**
 * Parse timestamp string to seconds
 */
function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parts[0] * 60 + parts[1];
}

/**
 * Format description with clickable links and chapter formatting
 */
function formatDescription(text: string): string {
  // Escape HTML
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Convert URLs to clickable links
  html = html.replace(
    /(https?:\/\/[^\s]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );

  // Format chapters: patterns like "00:00 - Title" or "00:00 Title"
  // Add data-time attribute for click handling
  html = html.replace(
    /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]?\s*(.+)$/gm,
    (_, time, title) => {
      const seconds = parseTimestamp(time);
      return `<span class="chapter" data-time="${seconds}"><span class="chapter-time">${time}</span>${title}</span>`;
    }
  );

  return html;
}

/**
 * Set up click handlers for chapters in description
 */
function setupChapterClickHandlers() {
  const chapters = videoDescriptionEl.querySelectorAll(".chapter[data-time]");
  chapters.forEach((chapter) => {
    chapter.addEventListener("click", () => {
      const time = parseFloat(chapter.getAttribute("data-time") || "0");
      seekTo(time);
    });
  });
}

/**
 * Toggle description expanded state
 */
function toggleDescriptionExpanded() {
  descriptionExpanded = !descriptionExpanded;
  videoDescriptionEl.classList.toggle("show-full", descriptionExpanded);
  descriptionToggleEl.textContent = descriptionExpanded ? "Show less" : "Show more";
}

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

function buildEmbedUrl(videoId: string, startTime: number): string {
  const startSeconds = Math.max(0, Math.floor(startTime));
  const embedParams = new URLSearchParams({
    start: String(startSeconds),
    autoplay: "1",
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
  });
  return `https://www.youtube.com/embed/${videoId}?${embedParams.toString()}`;
}

function ensureYouTubeApi(): Promise<void> {
  if (window.YT && window.YT.Player) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const existingScript = document.getElementById("yt-iframe-api");
    if (!existingScript) {
      const script = document.createElement("script");
      script.id = "yt-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }

    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (previousReady) {
        previousReady();
      }
      resolve();
    };
  });
}

function startYouTubePolling(segments: TranscriptSegment[]) {
  if (ytPollId !== null) {
    window.clearInterval(ytPollId);
  }

  ytPollId = window.setInterval(() => {
    if (!ytPlayer) return;
    updateCurrentSegment(ytPlayer.getCurrentTime(), segments);
  }, 1000);
}

function stopYouTubePolling() {
  if (ytPollId === null) return;
  window.clearInterval(ytPollId);
  ytPollId = null;
}

/**
 * Seek video to a specific time
 */
function seekTo(time: number) {
  if (videoEl) {
    videoEl.currentTime = time;
    videoEl.play();
    return;
  }
  if (ytPlayer) {
    ytPlayer.seekTo(time, true);
    ytPlayer.playVideo();
    return;
  }
  if (embedIframe && currentEmbedVideoId) {
    embedIframe.src = buildEmbedUrl(currentEmbedVideoId, time);
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
      updateCurrentSegment(segment.start_time, segments);
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
  if (isOpenAIWidget) {
    videoWrapper.innerHTML = `<div id="yt-player"></div>`;

    videoEl = null;
    embedIframe = null;
    currentEmbedVideoId = videoId;

    stopYouTubePolling();
    void ensureYouTubeApi().then(() => {
      const yt = window.YT;
      if (!yt) return;
      ytPlayer = new yt.Player("yt-player", {
        videoId,
        playerVars: {
          start: Math.max(0, Math.floor(startTime)),
          autoplay: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: (event) => {
            event.target.playVideo();
          },
        },
      });
      startYouTubePolling(segments);
    });
  } else {
    videoWrapper.innerHTML = `
      <video id="video-player" controls autoplay playsinline></video>
    `;

    embedIframe = null;
    currentEmbedVideoId = null;
    ytPlayer = null;
    stopYouTubePolling();
    videoEl = document.getElementById("video-player") as HTMLVideoElement;
    videoEl.src = videoUrl;

    // Set up time tracking for segment highlighting and model context
    videoEl.addEventListener("timeupdate", () => {
      if (videoEl) {
        updateCurrentSegment(videoEl.currentTime, segments);
        updateModelContext();
      }
    });

    // Also update context on pause/play
    videoEl.addEventListener("pause", updateModelContext);
    videoEl.addEventListener("play", updateModelContext);
    videoEl.addEventListener("seeked", updateModelContext);

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
  }

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
 * Get recent transcript segments around current time (last 60 seconds)
 */
function getRecentTranscript(currentTime: number, segments: TranscriptSegment[]): string {
  const windowStart = Math.max(0, currentTime - 60);
  const windowEnd = currentTime + 5; // Include a few seconds ahead

  const recentSegments = segments.filter(
    seg => seg.start_time >= windowStart && seg.start_time <= windowEnd
  );

  if (recentSegments.length === 0) return "";

  return recentSegments
    .map(seg => `[${formatTimestamp(seg.start_time)}] ${seg.text}`)
    .join("\n");
}

/**
 * Update model context with current playback state
 * This allows Claude to know what the user just watched
 */
function updateModelContext() {
  if (!videoEl || !currentVideoInfo) return;

  const caps = app.getHostCapabilities();
  if (!caps?.updateModelContext) return;

  const now = Date.now();
  if (now - lastContextUpdateTime < CONTEXT_UPDATE_INTERVAL) return;
  lastContextUpdateTime = now;

  const currentTime = videoEl.currentTime;
  const recentTranscript = getRecentTranscript(currentTime, currentTranscriptSegments);

  // Build structured markdown with YAML frontmatter
  const frontmatter = [
    "---",
    "tool: channel-chat-player",
    `video: "${currentVideoInfo.video_title}"`,
    `channel: "${currentVideoInfo.channel_name}"`,
    `current-time: ${formatTimestamp(Math.floor(currentTime))}`,
    `paused: ${videoEl.paused}`,
    "---",
  ].join("\n");

  let markdown = frontmatter;
  if (recentTranscript) {
    markdown += `\n\n## Recent transcript (last 60 seconds)\n\n${recentTranscript}`;
  }

  app.updateModelContext({
    content: [{ type: "text", text: markdown }],
  }).catch((e: unknown) => {
    console.warn("[Player] Failed to update model context:", e);
  });
}

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
    if (isOpenAIWidget) {
      const transcriptId = transcriptUri.replace(/^transcript:\/\//, "");
      const transcriptUrl = `https://channelmcp.com/transcript/${transcriptId}`;
      console.info("[Player] Fetching transcript:", transcriptUrl);
      const response = await fetch(transcriptUrl);
      if (!response.ok) {
        console.error("[Player] Transcript request failed:", response.status);
        return null;
      }
      return await response.json() as TranscriptData;
    }

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

async function renderShowVideo(showVideo: ShowVideoResult) {
  playerEl.classList.add("loading");

  // Store video info for model context
  currentVideoInfo = showVideo;

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
      // Format description with links and chapters
      videoDescriptionEl.innerHTML = formatDescription(showVideo.description!);
      videoDescriptionEl.style.display = "block";
      setupChapterClickHandlers();
    } else {
      videoDescriptionEl.style.display = "none";
    }
  } else {
    videoContextEl.style.display = "none";
  }

  if (isOpenAIWidget) {
    renderPlayer(showVideo.video_url, showVideo.video_id, showVideo.start_time, []);
    playerEl.classList.remove("loading");

    void fetchTranscript(showVideo.transcript_uri).then((transcript) => {
      if (!transcript || !transcript.segments.length) {
        currentTranscriptSegments = [];
        transcriptSegmentsEl.innerHTML = '<div class="transcript-segment"><span class="segment-text">Transcript not available.</span></div>';
        return;
      }

      currentTranscriptSegments = transcript.segments;
      renderTranscript(transcript.segments);
    });
    return;
  }

  // Fetch full transcript
  const transcript = await fetchTranscript(showVideo.transcript_uri);

  if (!transcript || !transcript.segments.length) {
    // Fallback: show video without transcript
    currentTranscriptSegments = [];
    renderPlayer(showVideo.video_url, showVideo.video_id, showVideo.start_time, []);
    transcriptSegmentsEl.innerHTML = '<div class="transcript-segment"><span class="segment-text">Transcript not available.</span></div>';
  } else {
    // Store segments for model context
    currentTranscriptSegments = transcript.segments;
    renderPlayer(showVideo.video_url, showVideo.video_id, showVideo.start_time, transcript.segments);
  }

  playerEl.classList.remove("loading");
}

app.ontoolresult = async (result) => {
  console.info("[Player] Tool result:", result);

  const showVideo = extractShowVideoResult(result);
  if (!showVideo) {
    titleEl.textContent = "Error";
    transcriptSegmentsEl.innerHTML = '<div class="transcript-segment"><span class="segment-text">Could not parse video data.</span></div>';
    playerEl.classList.remove("loading");
    return;
  }

  await renderShowVideo(showVideo);
};

app.ontoolcancelled = () => {
  console.info("[Player] Tool cancelled");
  playerEl.classList.remove("loading");
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

// Set up expand toggle button
expandBtn.addEventListener("click", toggleFullscreen);

// Set up description toggle - both button and entire context area
descriptionToggleEl.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDescriptionExpanded();
});

// Make entire context area clickable in non-expanded mode
videoContextEl.addEventListener("click", (e) => {
  // Don't toggle if clicking a link or chapter
  if ((e.target as HTMLElement).closest("a, .chapter")) return;
  // Only toggle in non-expanded mode
  if (currentDisplayMode !== "fullscreen") {
    toggleDescriptionExpanded();
  }
});

// Handle Escape key to exit fullscreen
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentDisplayMode === "fullscreen") {
    toggleFullscreen();
  }
});

function handleOpenAIWidget() {
  const applyToolOutput = () => {
    const globals = (window as unknown as { openai?: OpenAIWidgetGlobals }).openai;
    if (!globals?.toolOutput) return;
    void renderShowVideo(globals.toolOutput);
  };

  window.addEventListener("openai:set_globals", applyToolOutput);
  applyToolOutput();
}

// Connect to host
if (isOpenAIWidget) {
  handleOpenAIWidget();
} else {
  app.connect().then(() => {
    console.info("[Player] Connected to host");
    const ctx = app.getHostContext();
    if (ctx) {
      handleHostContextChanged(ctx);
    }
  });
}
