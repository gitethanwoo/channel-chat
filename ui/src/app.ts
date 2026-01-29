/**
 * Channel Chat Video Player - MCP App
 *
 * Displays YouTube video clips with transcript from search results.
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

// Search result from our MCP tool
interface SearchResult {
  text: string;
  video_title: string;
  video_id: string;
  channel_name: string;
  start_time: number;
  end_time: number;
  youtube_url: string;
  score: number;
}

interface ToolResultContent {
  results: SearchResult[];
  query: string;
}

// DOM Elements
const playerEl = document.querySelector(".video-player") as HTMLElement;
const iframeEl = document.getElementById("youtube-player") as HTMLIFrameElement;
const titleEl = document.getElementById("video-title") as HTMLElement;
const channelEl = document.getElementById("channel-name") as HTMLElement;
const timestampEl = document.getElementById("timestamp") as HTMLElement;
const transcriptEl = document.getElementById("transcript-text") as HTMLElement;
const scoreEl = document.getElementById("score") as HTMLElement;

// Format seconds to MM:SS or HH:MM:SS
function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// Render a search result as video player
function renderResult(result: SearchResult) {
  // Build YouTube embed URL with start time
  // End time requires YouTube IFrame API for precise control, using start for now
  const startSeconds = Math.floor(result.start_time);
  const endSeconds = Math.floor(result.end_time);

  // Use embed URL with start parameter and enable JS API
  const embedUrl = `https://www.youtube.com/embed/${result.video_id}?start=${startSeconds}&end=${endSeconds}&autoplay=1&rel=0&enablejsapi=1`;

  iframeEl.src = embedUrl;

  // Update info
  titleEl.textContent = result.video_title;
  channelEl.textContent = result.channel_name;
  timestampEl.textContent = `${formatTimestamp(result.start_time)} - ${formatTimestamp(result.end_time)}`;

  // Clean transcript text (remove title prefix if present)
  let text = result.text;
  if (text.includes("|")) {
    text = text.split("|").slice(1).join("|").trim();
  }
  transcriptEl.textContent = text;

  // Show score
  scoreEl.textContent = `${Math.round(result.score * 100)}% match`;
}

// Extract results from tool output
function extractResults(result: CallToolResult): ToolResultContent | null {
  try {
    // Check structuredContent first
    if (result.structuredContent) {
      return result.structuredContent as ToolResultContent;
    }

    // Try to parse from text content
    const textContent = result.content?.find((c: any) => c.type === "text");
    if (textContent && "text" in textContent) {
      return JSON.parse(textContent.text);
    }
  } catch (e) {
    console.error("Failed to extract results:", e);
  }
  return null;
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
}

// Create MCP App
const app = new App({ name: "Channel Chat Player", version: "1.0.0" });

// Register handlers BEFORE connecting
app.onteardown = async () => {
  console.info("[Player] Teardown");
  iframeEl.src = "";
  return {};
};

app.ontoolinput = (params) => {
  console.info("[Player] Tool input:", params);
  // Could show loading state here
  playerEl.classList.add("loading");
};

app.ontoolresult = (result) => {
  console.info("[Player] Tool result:", result);
  playerEl.classList.remove("loading");

  const data = extractResults(result);
  if (data && data.results && data.results.length > 0) {
    // Show the best result (first one)
    renderResult(data.results[0]);
  } else {
    titleEl.textContent = "No results found";
    transcriptEl.textContent = "Try a different search query.";
  }
};

app.ontoolcancelled = () => {
  console.info("[Player] Tool cancelled");
  playerEl.classList.remove("loading");
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

// Connect to host
app.connect().then(() => {
  console.info("[Player] Connected to host");
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
