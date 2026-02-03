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
        --bg: #fbf8f1;
        --paper: #fffdf7;
        --ink: #121212;
        --muted: rgba(18, 18, 18, 0.72);
        --line: rgba(18, 18, 18, 0.14);
        --hairline: rgba(18, 18, 18, 0.08);
        --shadow: 0 30px 90px rgba(18, 18, 18, 0.14);
        --shadowTight: 0 16px 42px rgba(18, 18, 18, 0.14);
        --radius: 18px;
        --radiusSm: 14px;
        --max: 1120px;

        --teal: #0b766c;
        --teal2: #0a5e57;
        --amber: #f59e0b;
        --inkOnTeal: #f2fffd;

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
            1200px 720px at 10% 12%,
            rgba(11, 118, 108, 0.16),
            transparent 60%
          ),
          radial-gradient(
            980px 620px at 78% 16%,
            rgba(245, 158, 11, 0.18),
            transparent 60%
          ),
          radial-gradient(
            900px 700px at 70% 84%,
            rgba(11, 118, 108, 0.08),
            transparent 62%
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
        opacity: 0.10;
        mix-blend-mode: multiply;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.35'/%3E%3C/svg%3E");
      }

      .grid {
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: 0.55;
        background-image: linear-gradient(to right, rgba(18, 18, 18, 0.04) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(18, 18, 18, 0.04) 1px, transparent 1px);
        background-size: 44px 44px;
        mask-image: radial-gradient(900px 620px at 30% 14%, black 50%, transparent 72%);
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
        border-bottom: 1px solid var(--hairline);
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
        gap: 12px;
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
        padding: 48px 0 84px;
      }

      .hero {
        display: grid;
        grid-template-columns: 1fr;
        gap: 18px;
      }

      @media (max-width: 920px) {
        .hero {
          grid-template-columns: 1fr;
        }
      }

      h1 {
        margin: 0;
        font-family: var(--serif);
        font-size: clamp(42px, 6vw, 68px);
        line-height: 1.01;
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
        background: linear-gradient(180deg, rgba(11, 118, 108, 0.98), var(--teal2));
        border-color: rgba(7, 49, 46, 0.42);
        color: var(--inkOnTeal);
        box-shadow: 0 22px 44px rgba(11, 118, 108, 0.24);
      }

      .btn:hover {
        transform: translateY(-1px);
      }
      .btn:active {
        transform: translateY(0px);
      }

      .kicker {
        font-family: var(--mono);
        font-size: 12px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--muted);
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
        border: 1px solid rgba(18, 18, 18, 0.16);
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

      .layout {
        margin-top: 24px;
        display: grid;
        grid-template-columns: 1.12fr 0.88fr;
        gap: 18px;
        align-items: start;
      }

      @media (max-width: 980px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }

      .frame {
        position: relative;
        border-radius: var(--radius);
        border: 1px solid rgba(18, 18, 18, 0.16);
        background: rgba(255, 253, 247, 0.74);
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .frame::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(
          720px 420px at 18% 10%,
          rgba(11, 118, 108, 0.14),
          transparent 62%
        );
      }

      .frameHead {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(18, 18, 18, 0.12);
        background: rgba(255, 255, 255, 0.52);
      }

      .frameHead .title {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 800;
        letter-spacing: -0.01em;
      }

      .chipRow {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }

      .chip {
        font-family: var(--mono);
        font-size: 12px;
        color: rgba(18, 18, 18, 0.78);
        border: 1px solid rgba(18, 18, 18, 0.14);
        background: rgba(255, 255, 255, 0.55);
        padding: 6px 10px;
        border-radius: 999px;
      }

      .chip.emph {
        border-color: rgba(11, 118, 108, 0.38);
        color: rgba(7, 49, 46, 0.95);
        box-shadow: 0 12px 22px rgba(11, 118, 108, 0.12);
      }

      .videoFrame {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: rgba(0, 0, 0, 0.08);
      }

      .videoFrame iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
      }

      .stamp {
        position: absolute;
        left: 14px;
        bottom: 14px;
        transform: rotate(-2deg);
        border-radius: 14px;
        padding: 10px 12px;
        border: 1px solid rgba(18, 18, 18, 0.18);
        background: rgba(255, 255, 255, 0.78);
        box-shadow: var(--shadowTight);
        backdrop-filter: blur(8px);
      }

      .stamp b {
        display: block;
        font-family: var(--mono);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .stamp span {
        display: block;
        color: var(--muted);
        font-size: 13px;
        margin-top: 4px;
      }

      .sidebar {
        display: grid;
        gap: 12px;
      }

      .panel {
        border-radius: var(--radius);
        border: 1px solid rgba(18, 18, 18, 0.16);
        background: rgba(255, 253, 247, 0.62);
        box-shadow: var(--shadowTight);
        padding: 16px;
      }

      .panel h2 {
        margin: 10px 0 0;
        font-size: 18px;
        letter-spacing: -0.01em;
      }

      .panel ul {
        margin: 10px 0 0;
        padding: 0 0 0 18px;
        color: var(--muted);
      }

      .panel li {
        margin: 8px 0;
      }

      .linksRow {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
        margin-top: 10px;
        color: var(--muted);
        font-weight: 650;
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
    <div class="grid" aria-hidden="true"></div>
    <header id="top">
      <div class="wrap">
        <nav>
          <div class="brand">
            <div class="name">channel-chat</div>
            <div class="tag">MCP + YouTube search</div>
          </div>
          <div class="navlinks">
            <a href="#build">Build video</a>
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
            <a class="btn primary" href="#build">Watch the build video</a>
            <a class="btn" href="/ui">Open the player</a>
            <a class="btn" href="https://www.youtube.com/watch?v=apAQ9YaV4cs">YouTube</a>
          </div>
        </div>
      </section>

      <section id="build" class="layout">
        <div class="frame reveal d2">
          <div class="frameHead">
            <div class="title">
              <span class="kicker">Build video</span>
              <span style="font-family: var(--sans); font-weight: 800">How this works</span>
            </div>
            <div class="chipRow">
              <span class="chip emph">MCP</span>
              <span class="chip">Workers</span>
              <span class="chip">R2</span>
              <span class="chip">Vectorize</span>
            </div>
          </div>
          <div class="videoFrame" aria-label="Build video">
            <iframe
              src="https://www.youtube-nocookie.com/embed/apAQ9YaV4cs?rel=0"
              title="How channel-chat was built"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowfullscreen
            ></iframe>
            <div class="stamp" aria-hidden="true">
              <b>Build log</b>
              <span>Watch the full walkthrough, then try the player.</span>
            </div>
          </div>
        </div>

        <div class="sidebar reveal d3">
          <div class="panel">
            <div class="kicker">What You Get</div>
            <h2>Find the right moment fast</h2>
            <ul>
              <li>Ask: “Where do they explain X?” and get pointed to the best segments</li>
              <li>Search by meaning across an entire channel (not exact-match keywords)</li>
              <li>Jump from query to relevant videos with timestamps and context</li>
            </ul>
          </div>

          <div class="panel">
            <div class="kicker">Quick Start</div>
            <h2>Index once, query forever</h2>
            <div style="color: var(--muted); margin-top: 8px">
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
            <div class="linksRow">
              <a href="/ui">Open player</a>
              <span aria-hidden="true">•</span>
              <a href="https://www.youtube.com/watch?v=apAQ9YaV4cs">Watch on YouTube</a>
            </div>
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
