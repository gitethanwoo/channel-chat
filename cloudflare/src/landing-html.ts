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

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,650;9..144,800&family=Figtree:wght@400;500;650;750&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />

    <style>
      :root {
        --bg: #faf7f0;
        --paper: #fffdf7;
        --ink: #121212;
        --muted: rgba(18, 18, 18, 0.72);
        --line: rgba(18, 18, 18, 0.14);
        --shadow: 0 28px 80px rgba(18, 18, 18, 0.14);
        --radius: 18px;
        --max: 1080px;

        --teal: #0b766c;
        --teal2: #0a5e57;
        --citrus: #f59e0b;
        --rose: #f97316;

        --serif: "Fraunces", ui-serif, Georgia, serif;
        --sans: "Figtree", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto,
          Arial, sans-serif;
        --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
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
        background: radial-gradient(
            1200px 680px at 12% 12%,
            rgba(11, 118, 108, 0.14),
            transparent 58%
          ),
          radial-gradient(
            980px 640px at 78% 18%,
            rgba(245, 158, 11, 0.16),
            transparent 60%
          ),
          radial-gradient(
            880px 520px at 60% 82%,
            rgba(249, 115, 22, 0.08),
            transparent 58%
          ),
          var(--bg);
        font-family: var(--sans);
        line-height: 1.4;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0.12;
        mix-blend-mode: multiply;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E");
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
        background: rgba(250, 247, 240, 0.78);
        border-bottom: 1px solid rgba(18, 18, 18, 0.06);
        transition: border-color 160ms ease, background 160ms ease;
      }
      header.scrolled {
        border-bottom-color: rgba(18, 18, 18, 0.14);
        background: rgba(250, 247, 240, 0.9);
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
        font-family: var(--serif);
        font-weight: 800;
        letter-spacing: -0.02em;
        font-size: 20px;
      }

      .brand .tag {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--muted);
        border: 1px solid var(--line);
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.58);
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
        padding: 44px 0 76px;
      }

      .hero {
        display: grid;
        grid-template-columns: 1.08fr 0.92fr;
        gap: 22px;
        align-items: start;
      }

      @media (max-width: 920px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }

      h1 {
        margin: 0;
        font-family: var(--serif);
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

      .lede strong {
        color: rgba(18, 18, 18, 0.88);
        font-weight: 750;
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
        background: linear-gradient(180deg, rgba(11, 118, 108, 0.95), var(--teal2));
        border-color: rgba(7, 49, 46, 0.38);
        color: #f6fffd;
        box-shadow: 0 18px 34px rgba(11, 118, 108, 0.22);
      }

      .btn:hover {
        transform: translateY(-1px);
      }
      .btn:active {
        transform: translateY(0px);
      }

      .card {
        background: rgba(255, 253, 247, 0.72);
        border: 1px solid rgba(18, 18, 18, 0.16);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        overflow: hidden;
        position: relative;
      }

      .card .pad {
        padding: 18px;
      }

      .kicker {
        font-family: var(--mono);
        font-size: 12px;
        letter-spacing: 0.1em;
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
        border-top: 1px solid rgba(18, 18, 18, 0.16);
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
        font-family: var(--mono);
        font-size: 0.95em;
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid var(--line);
        padding: 2px 6px;
        border-radius: 8px;
      }

      .terminal {
        margin-top: 10px;
        border-radius: 14px;
        border: 1px solid rgba(18, 18, 18, 0.18);
        background: rgba(18, 18, 18, 0.93);
        color: rgba(255, 255, 255, 0.9);
        padding: 12px 12px 14px;
        box-shadow: 0 18px 40px rgba(18, 18, 18, 0.18);
      }

      .terminal .dots {
        display: flex;
        gap: 6px;
        margin-bottom: 10px;
      }
      .terminal .dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        opacity: 0.85;
      }
      .terminal .dot.r {
        background: #ef4444;
      }
      .terminal .dot.y {
        background: #f59e0b;
      }
      .terminal .dot.g {
        background: #22c55e;
      }

      .terminal pre {
        margin: 0;
        font-family: var(--mono);
        font-size: 12.5px;
        line-height: 1.45;
        white-space: pre-wrap;
      }

      .reveal {
        opacity: 0;
        transform: translateY(10px);
        animation: reveal 600ms ease forwards;
      }
      .reveal.d1 {
        animation-delay: 60ms;
      }
      .reveal.d2 {
        animation-delay: 130ms;
      }
      .reveal.d3 {
        animation-delay: 200ms;
      }
      @keyframes reveal {
        to {
          opacity: 1;
          transform: translateY(0px);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .reveal {
          opacity: 1;
          transform: none;
          animation: none;
        }
        .btn:hover,
        .btn:active {
          transform: none;
        }
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
          <div class="reveal d1">
            <h1>Semantic search for YouTube channels, built for MCP.</h1>
          </div>
          <p class="lede reveal d2">
            Index a channel once, then query it like a knowledge base. Find the right segment
            by <strong>meaning</strong> (not just keywords), and jump straight to the part you
            need.
          </p>

          <div class="ctaRow reveal d3">
            <a class="btn primary" href="https://www.youtube.com/watch?v=apAQ9YaV4cs">
              Watch how it was built
            </a>
            <a class="btn" href="#video">Watch on this page</a>
            <a class="btn" href="/ui">Open the player</a>
          </div>
        </div>

        <div class="card reveal d2">
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
              <div class="terminal" role="group" aria-label="Quick start commands">
                <div class="dots" aria-hidden="true">
                  <div class="dot r"></div>
                  <div class="dot y"></div>
                  <div class="dot g"></div>
                </div>
                <pre>$ channel-chat add "https://youtube.com/@channelname"
$ channel-chat search "where do they explain vector databases?"</pre>
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
