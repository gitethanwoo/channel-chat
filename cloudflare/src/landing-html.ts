// Lightweight landing page HTML served at GET /
// Keep this dependency-free (single string) so it deploys with the Worker.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      name="description"
      content="channel-chat: semantic search for YouTube channels via MCP."
    />
    <title>channel-chat</title>

    <style>
      :root {
        --bg: #fbf7f0;
        --panel: rgba(255, 255, 255, 0.7);
        --ink: #141414;
        --muted: rgba(20, 20, 20, 0.72);
        --line: rgba(20, 20, 20, 0.14);
        --shadow: 0 18px 50px rgba(20, 20, 20, 0.12);
        --radius: 18px;
        --max: 1024px;
        --accent: #0f766e;
        --accentInk: #07312e;
      }

      * {
        box-sizing: border-box;
      }

      html {
        scroll-behavior: smooth;
      }

      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(
              1100px 650px at 15% 10%,
              rgba(15, 118, 110, 0.12),
              transparent 55%
            ),
          radial-gradient(
              900px 520px at 82% 18%,
              rgba(217, 119, 6, 0.12),
              transparent 58%
            ),
          var(--bg);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial,
          sans-serif;
        line-height: 1.4;
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      a:hover {
        text-decoration: underline;
        text-underline-offset: 4px;
      }

      .wrap {
        max-width: var(--max);
        margin: 0 auto;
        padding: 24px;
      }

      header {
        position: sticky;
        top: 0;
        z-index: 3;
        backdrop-filter: blur(10px);
        background: rgba(251, 247, 240, 0.78);
        border-bottom: 1px solid transparent;
        transition: border-color 160ms ease;
      }
      header.scrolled {
        border-bottom-color: var(--line);
      }

      nav {
        display: flex;
        gap: 14px;
        align-items: center;
        justify-content: space-between;
        padding: 14px 0;
      }

      .brand {
        display: flex;
        gap: 10px;
        align-items: baseline;
      }

      .brand .name {
        font-weight: 750;
        letter-spacing: -0.01em;
        font-size: 18px;
      }

      .brand .tag {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        color: var(--muted);
        border: 1px solid var(--line);
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.62);
      }

      .navlinks {
        display: flex;
        gap: 10px;
        align-items: center;
        color: var(--muted);
        font-weight: 650;
      }

      .navlinks a {
        padding: 8px 10px;
        border-radius: 12px;
      }

      .navlinks a:hover {
        background: rgba(20, 20, 20, 0.05);
        text-decoration: none;
      }

      main {
        padding: 38px 0 70px;
      }

      .hero {
        display: grid;
        grid-template-columns: 1.15fr 0.85fr;
        gap: 20px;
        align-items: start;
      }

      @media (max-width: 920px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }

      h1 {
        margin: 0;
        font-size: clamp(38px, 5vw, 56px);
        line-height: 1.04;
        letter-spacing: -0.02em;
      }

      .lede {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 18px;
        max-width: 64ch;
      }

      .ctaRow {
        margin-top: 18px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        border-radius: 999px;
        padding: 11px 14px;
        font-weight: 750;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.62);
        box-shadow: 0 1px 0 rgba(20, 20, 20, 0.06);
        cursor: pointer;
      }

      .btn.primary {
        background: linear-gradient(180deg, rgba(15, 118, 110, 0.9), var(--accent));
        border-color: rgba(7, 49, 46, 0.35);
        color: #f6fffd;
        box-shadow: 0 14px 30px rgba(15, 118, 110, 0.22);
      }

      .btn:hover {
        transform: translateY(-1px);
      }
      .btn:active {
        transform: translateY(0px);
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .card .pad {
        padding: 18px;
      }

      .kicker {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .bullets {
        margin: 10px 0 0;
        padding: 0 0 0 18px;
        color: var(--muted);
      }

      .bullets li {
        margin: 8px 0;
      }

      .section {
        margin-top: 26px;
      }

      .section h2 {
        margin: 0 0 10px;
        font-size: 18px;
        letter-spacing: -0.01em;
      }

      .video {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: rgba(0, 0, 0, 0.06);
        border-top: 1px solid var(--line);
      }

      .video iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
      }

      footer {
        margin-top: 34px;
        color: var(--muted);
        font-size: 13px;
      }

      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        font-size: 0.95em;
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid var(--line);
        padding: 2px 6px;
        border-radius: 8px;
      }
    </style>
  </head>

  <body>
    <header id="top">
      <div class="wrap">
        <nav>
          <div class="brand">
            <div class="name">channel-chat</div>
            <div class="tag">MCP + YouTube search</div>
          </div>
          <div class="navlinks">
            <a href="#video">Build video</a>
            <a href="/ui">Player</a>
          </div>
        </nav>
      </div>
    </header>

    <main class="wrap">
      <section class="hero">
        <div>
          <h1>Semantic search for YouTube channels, built for MCP.</h1>
          <p class="lede">
            Index a channel once, then query it like a knowledge base. Find the right video
            segment by meaning (not just keywords), and jump straight to the part you
            need.
          </p>

          <div class="ctaRow">
            <a class="btn primary" href="https://www.youtube.com/watch?v=apAQ9YaV4cs">
              Watch how it was built
            </a>
            <a class="btn" href="#video">Watch on this page</a>
            <a class="btn" href="/ui">Open the player</a>
          </div>
        </div>

        <div class="card">
          <div class="pad">
            <div class="kicker">What You Get</div>
            <ul class="bullets">
              <li>Ask in plain language: “Where do they explain X?”</li>
              <li>Search by meaning across a whole channel</li>
              <li>Jump from query to relevant videos (and why)</li>
              <li>Designed for Claude + MCP tool workflows</li>
            </ul>

            <div class="section">
              <h2>Quick Start</h2>
              <div style="color: var(--muted)">
                Use the CLI to index a channel, then query via MCP.
              </div>
              <div style="margin-top: 10px">
                <code>channel-chat add &quot;https://youtube.com/@channelname&quot;</code>
              </div>
            </div>
          </div>

          <div id="video" class="video" aria-label="Build video">
            <iframe
              src="https://www.youtube-nocookie.com/embed/apAQ9YaV4cs?rel=0"
              title="How channel-chat was built"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
            ></iframe>
          </div>
        </div>
      </section>

      <footer>
        <div>
          <a href="#top">Back to top</a>
          <span aria-hidden="true"> • </span>
          <a href="/ui">Player</a>
          <span aria-hidden="true"> • </span>
          <a href="https://www.youtube.com/watch?v=apAQ9YaV4cs">YouTube</a>
        </div>
      </footer>
    </main>

    <script>
      (function () {
        var header = document.getElementById("top");
        function onScroll() {
          if (!header) return;
          header.classList.toggle("scrolled", window.scrollY > 6);
        }
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
      })();
    </script>
  </body>
</html>`;

