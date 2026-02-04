import { describe, it, expect, beforeAll, vi } from "vitest";
import { env, SELF, applyD1Migrations } from "cloudflare:test";

vi.mock("../vectorize", async () => {
  const { createVectorizeModuleMock } = await import(
    "./vectorize-test-helpers"
  );
  return createVectorizeModuleMock();
});

const TEST_CHANNEL = {
  id: "__test__int_channel",
  name: "Integration Test Channel",
  url: "https://youtube.com/@integration-test",
};

const TEST_VIDEO_ID = "__test__int_video_abc";

const TEST_CHUNKS = [
  {
    seq: 0,
    start_time: 0,
    end_time: 30,
    text: "Machine learning is a subset of artificial intelligence that focuses on building systems that learn from data.",
  },
  {
    seq: 1,
    start_time: 30,
    end_time: 60,
    text: "Neural networks are inspired by the biological structure of the human brain and consist of layers of interconnected nodes.",
  },
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("Integration: Full HTTP Flow", () => {
  // Each it() gets isolated D1 storage, so the full sequential flow
  // (index → search → stats → show → delete) must be in one test.
  it("index → search → stats → channels → videos → show_video → delete lifecycle", async () => {
    // --- Index a video ---
    const indexRes = await SELF.fetch("http://localhost/api/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: TEST_CHANNEL,
        video: {
          id: TEST_VIDEO_ID,
          title: "Integration Test: ML Basics",
          description: "A test video about machine learning",
          duration: 60,
          published_at: "2024-06-01T00:00:00Z",
          transcript_source: "youtube",
        },
        chunks: TEST_CHUNKS,
      }),
    });

    expect(indexRes.status).toBe(200);
    const indexBody = (await indexRes.json()) as {
      success: boolean;
      chunks_indexed: number;
    };
    expect(indexBody.success).toBe(true);
    expect(indexBody.chunks_indexed).toBe(2);

    // --- Search endpoint works (mocked Vectorize is deterministic) ---
    const searchRes = await SELF.fetch("http://localhost/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "artificial intelligence machine learning",
        limit: 5,
      }),
    });
    expect(searchRes.status).toBe(200);
    type SearchResult = {
      video_id: string;
      score: number;
      youtube_url: string;
      clip_resource_uri: string;
    };
    const searchBody = (await searchRes.json()) as {
      query: string;
      results: SearchResult[];
    };
    // Verify response shape — the production index has data
    expect(searchBody.query).toBe("artificial intelligence machine learning");
    expect(Array.isArray(searchBody.results)).toBe(true);
    expect(searchBody.results.length).toBeGreaterThan(0);
    for (const result of searchBody.results) {
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.youtube_url).toContain(
        `youtube.com/watch?v=${TEST_VIDEO_ID}`
      );
      expect(result.clip_resource_uri).toContain(
        `video://clip/${TEST_VIDEO_ID}`
      );
    }

    // --- Stats reflect indexed data ---
    const statsRes = await SELF.fetch("http://localhost/api/stats");
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      channels: number;
      videos: number;
      chunks: number;
    };
    expect(statsBody.channels).toBeGreaterThanOrEqual(1);
    expect(statsBody.videos).toBeGreaterThanOrEqual(1);
    expect(statsBody.chunks).toBeGreaterThanOrEqual(2);

    // --- Channels list includes test channel ---
    const channelsRes = await SELF.fetch("http://localhost/api/channels");
    expect(channelsRes.status).toBe(200);
    const channelsBody = (await channelsRes.json()) as Array<{ id: string }>;
    expect(channelsBody.find((c) => c.id === TEST_CHANNEL.id)).toBeDefined();

    // --- Videos list includes test video ---
    const videosRes = await SELF.fetch("http://localhost/api/videos");
    expect(videosRes.status).toBe(200);
    const videosBody = (await videosRes.json()) as string[];
    expect(videosBody).toContain(TEST_VIDEO_ID);

    // --- show_video via MCP ---
    const showRes = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "show-1",
        method: "tools/call",
        params: {
          name: "show_video",
          arguments: { video_id: TEST_VIDEO_ID },
        },
      }),
    });

    expect(showRes.status).toBe(200);
    const showBody = (await showRes.json()) as {
      result: {
        structuredContent: { video_title: string; transcript_uri: string };
      };
    };
    expect(showBody.result.structuredContent.video_title).toBe(
      "Integration Test: ML Basics"
    );
    expect(showBody.result.structuredContent.transcript_uri).toContain(
      "transcript://"
    );

    // --- Delete video ---
    const deleteRes = await SELF.fetch(
      `http://localhost/api/video/${TEST_VIDEO_ID}`,
      { method: "DELETE" }
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { success: boolean };
    expect(deleteBody.success).toBe(true);

    // Verify video is gone
    const videosRes2 = await SELF.fetch("http://localhost/api/videos");
    const videosBody2 = (await videosRes2.json()) as string[];
    expect(videosBody2).not.toContain(TEST_VIDEO_ID);
  });

  it("R2 transcript roundtrip", async () => {
    // Set up video in D1 for this isolated test
    await env.DB
      .prepare(
        "INSERT INTO channels (id, name, url, indexed_at) VALUES (?, ?, ?, ?)"
      )
      .bind("__test__r2_ch", "R2 Test Channel", "https://youtube.com/@r2", new Date().toISOString())
      .run();

    await env.DB
      .prepare(
        "INSERT INTO videos (id, channel_id, title, transcript_source, r2_transcript_key) VALUES (?, ?, ?, ?, ?)"
      )
      .bind("__test__r2_vid", "__test__r2_ch", "R2 Test Video", "youtube", "transcripts/__test__r2_vid.json")
      .run();

    // Upload transcript to R2
    const segments = [
      { text: "Hello world", start_time: 0, end_time: 5 },
      { text: "This is a test", start_time: 5, end_time: 10 },
    ];
    await env.R2.put(
      "transcripts/__test__r2_vid.json",
      JSON.stringify(segments),
      { httpMetadata: { contentType: "application/json" } }
    );

    // Fetch via HTTP
    const res = await SELF.fetch("http://localhost/transcript/__test__r2_vid");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ text: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0].text).toBe("Hello world");
  });

  it("CORS: OPTIONS returns 204 with correct headers", async () => {
    const res = await SELF.fetch("http://localhost/api/search", {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("CORS: responses include Access-Control-Allow-Origin", async () => {
    const res = await SELF.fetch("http://localhost/api/stats");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
