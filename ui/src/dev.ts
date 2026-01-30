/**
 * Dev mode entry point for standalone UI development.
 * Renders the player with mock data for rapid iteration.
 */
import "./styles.css";
import { MOCK_SHOW_VIDEO_RESULT, MOCK_TRANSCRIPT, type TranscriptSegment } from "./mock-data.js";

// DOM Elements
const playerEl = document.querySelector(".video-player") as HTMLElement;
const titleEl = document.getElementById("video-title") as HTMLElement;
const channelEl = document.getElementById("channel-name") as HTMLElement;
const fallbackEl = document.getElementById("youtube-fallback") as HTMLElement;
const videoWrapper = document.getElementById("video-wrapper") as HTMLElement;
const transcriptSegmentsEl = document.getElementById("transcript-segments") as HTMLElement;
const expandBtn = document.getElementById("expand-btn") as HTMLButtonElement;

let videoEl: HTMLVideoElement | null = null;
let currentSegmentIndex = -1;
let isExpanded = false;

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
 * Render the video player
 */
function renderPlayer(videoUrl: string, startTime: number, segments: TranscriptSegment[]) {
  // For dev mode, use a sample video
  videoWrapper.innerHTML = `
    <video id="video-player" controls playsinline>
      <source src="https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4" type="video/mp4">
    </video>
  `;

  videoEl = document.getElementById("video-player") as HTMLVideoElement;

  // Set up time tracking for segment highlighting
  videoEl.addEventListener("timeupdate", () => {
    if (videoEl) {
      updateCurrentSegment(videoEl.currentTime, segments);
    }
  });

  // Render transcript
  renderTranscript(segments);
}

/**
 * Toggle expanded layout (side-by-side vs vertical)
 */
function toggleExpanded() {
  isExpanded = !isExpanded;
  playerEl.classList.toggle("expanded", isExpanded);
  expandBtn.title = isExpanded ? "Collapse view" : "Expand view";
  console.log("[Dev] Layout toggled:", isExpanded ? "expanded" : "collapsed");
}

/**
 * Initialize dev mode
 */
function init() {
  const result = MOCK_SHOW_VIDEO_RESULT;
  const transcript = MOCK_TRANSCRIPT;

  // Update video info
  titleEl.textContent = result.video_title;
  channelEl.textContent = result.channel_name;
  fallbackEl.innerHTML = `<a href="https://youtube.com/watch?v=${result.video_id}" target="_blank">Watch on YouTube</a>`;

  // Render player with transcript
  renderPlayer(result.video_url, result.start_time, transcript.segments);

  // In dev mode, always show expand button (no MCP host to check)
  expandBtn.classList.add("available");

  // Set up expand button
  expandBtn.addEventListener("click", toggleExpanded);

  console.log("[Dev] UI initialized with mock data");
  console.log("[Dev] Click expand button to toggle side-by-side layout");
}

// Initialize on load
init();
