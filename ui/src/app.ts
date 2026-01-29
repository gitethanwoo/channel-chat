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
import { ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
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
  clip_resource_uri: string;
  cloudflare_video_url?: string;
  score: number;
}

interface ToolResultContent {
  results: SearchResult[];
  query: string;
}

// DOM Elements
const playerEl = document.querySelector(".video-player") as HTMLElement;
const titleEl = document.getElementById("video-title") as HTMLElement;
const channelEl = document.getElementById("channel-name") as HTMLElement;
const timestampEl = document.getElementById("timestamp") as HTMLElement;
const transcriptEl = document.getElementById("transcript-text") as HTMLElement;
const scoreEl = document.getElementById("score") as HTMLElement;
const fallbackEl = document.getElementById("youtube-fallback") as HTMLElement;

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

// Create MCP App
const app = new App({ name: "Channel Chat Player", version: "1.0.0" });

type VideoBlobContent = {
  uri: string;
  mimeType: string;
  blob: string;
};

async function loadClip(resourceUri: string): Promise<string> {
  const resourceResult = await app.request(
    { method: "resources/read", params: { uri: resourceUri } },
    ReadResourceResultSchema
  );
  const content = resourceResult.contents[0] as VideoBlobContent;
  return `data:${content.mimeType};base64,${content.blob}`;
}

// Render a search result as video player
async function renderResult(result: SearchResult) {
  const videoContainer = document.getElementById("thumbnail-wrapper") as HTMLElement;

  videoContainer.innerHTML = `<div class="loading"></div>`;
  fallbackEl.innerHTML = `<a href="${result.youtube_url}" target="_blank">Watch on YouTube</a>`;

  // Create video element
  videoContainer.innerHTML = `
    <video id="clip-player" controls autoplay playsinline></video>
  `;
  const clipPlayer = document.getElementById("clip-player") as HTMLVideoElement;

  // Always use MCP resources/read for video - direct HTTP URLs are blocked by sandbox CSP
  const dataUri = await loadClip(result.clip_resource_uri);
  clipPlayer.src = dataUri;

  // Seek to start time when metadata is loaded
  clipPlayer.addEventListener("loadedmetadata", () => {
    clipPlayer.currentTime = result.start_time;
  }, { once: true });

  // Optional: Pause at end_time (for clip-like behavior)
  const endTime = result.end_time;
  clipPlayer.addEventListener("timeupdate", () => {
    if (clipPlayer.currentTime >= endTime) {
      clipPlayer.pause();
    }
  });

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
  if (result.structuredContent) {
    return result.structuredContent as ToolResultContent;
  }

  const textContent = result.content?.find(
    (c): c is { type: "text"; text: string } => c.type === "text"
  );
  if (textContent) {
    return JSON.parse(textContent.text) as ToolResultContent;
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

// Register handlers BEFORE connecting
app.onteardown = async () => {
  console.info("[Player] Teardown");
  return {};
};

app.ontoolinput = (params) => {
  console.info("[Player] Tool input:", params);
  // Could show loading state here
  playerEl.classList.add("loading");
};

app.ontoolresult = async (result) => {
  console.info("[Player] Tool result:", result);

  const data = extractResults(result);
  if (data && data.results && data.results.length > 0) {
    // Show the best result (first one)
    await renderResult(data.results[0]);
  } else {
    titleEl.textContent = "No results found";
    transcriptEl.textContent = "Try a different search query.";
  }
  playerEl.classList.remove("loading");
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
