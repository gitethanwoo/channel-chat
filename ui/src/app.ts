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
  clip_url: string;
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

// Store current result for click handler
let currentResult: SearchResult | null = null;

// Render a search result as video player
function renderResult(result: SearchResult) {
  currentResult = result;
  const videoContainer = document.querySelector(".video-container") as HTMLElement;

  // Use native video player with clip URL, fallback to YouTube link
  if (result.clip_url) {
    videoContainer.innerHTML = `
      <video id="clip-player" controls autoplay playsinline>
        <source src="${result.clip_url}" type="video/mp4">
        Your browser does not support video playback.
      </video>
      <div class="youtube-fallback">
        <a href="${result.youtube_url}" target="_blank">Watch on YouTube</a>
      </div>
    `;
  } else {
    // Fallback: YouTube link card
    videoContainer.innerHTML = `
      <div class="video-card" id="video-card">
        <div class="play-button">
          <svg viewBox="0 0 68 48" width="68" height="48">
            <path d="M66.52,7.74c-0.78-2.93-2.49-5.41-5.42-6.19C55.79,.13,34,0,34,0S12.21,.13,6.9,1.55 C3.97,2.33,2.27,4.81,1.48,7.74C0.06,13.05,0,24,0,24s0.06,10.95,1.48,16.26c0.78,2.93,2.49,5.41,5.42,6.19 C12.21,47.87,34,48,34,48s21.79-0.13,27.1-1.55c2.93-0.78,4.64-3.26,5.42-6.19C67.94,34.95,68,24,68,24S67.94,13.05,66.52,7.74z" fill="#f00"/>
            <path d="M 45,24 27,14 27,34" fill="#fff"/>
          </svg>
        </div>
        <div class="watch-text">Click to watch on YouTube</div>
      </div>
    `;
    const card = document.getElementById("video-card");
    if (card) {
      card.onclick = () => {
        if (currentResult) {
          window.open(currentResult.youtube_url, "_blank");
        }
      };
    }
  }

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
  currentResult = null;
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
