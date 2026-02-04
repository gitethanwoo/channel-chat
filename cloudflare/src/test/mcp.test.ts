import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, applyD1Migrations } from "cloudflare:test";

/** Helper to send a JSON-RPC request to /mcp */
async function mcpCall(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("MCP JSON-RPC Protocol", () => {
  it("initialize returns protocol version and capabilities", async () => {
    const { status, body } = await mcpCall({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
    });

    expect(status).toBe(200);
    const result = body.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: Record<string, unknown>; resources: Record<string, unknown> };
    };
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.serverInfo.name).toBe("channel-chat");
    expect(result.serverInfo.version).toBe("1.0.0");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
  });

  it("tools/list includes required tools", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "tools-1",
      method: "tools/list",
    });

    const result = body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    expect(result.tools.length).toBeGreaterThanOrEqual(4);
    const names = new Set(result.tools.map((t) => t.name));
    for (const required of [
      "get_stats",
      "list_indexed_channels",
      "search_transcripts",
      "show_video",
    ]) {
      expect(names.has(required)).toBe(true);
    }
    // Verify each tool has inputSchema
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("resources/list includes required resources", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "res-1",
      method: "resources/list",
    });

    const result = body.result as { resources: Array<{ uri?: string; uriTemplate?: string; name: string }> };
    expect(result.resources.length).toBeGreaterThanOrEqual(3);
    const names = new Set(result.resources.map((r) => r.name));
    for (const required of [
      "Video Clip",
      "Video Player",
      "Video Transcript",
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });

  it("ping returns empty result", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "ping-1",
      method: "ping",
    });

    expect(body.result).toEqual({});
  });

  it("tools/call search_transcripts with empty query returns error", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "search-err",
      method: "tools/call",
      params: {
        name: "search_transcripts",
        arguments: { query: "" },
      },
    });

    const error = body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
  });

  it("tools/call show_video with nonexistent video returns error", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "show-err",
      method: "tools/call",
      params: {
        name: "show_video",
        arguments: { video_id: "nonexistent_video_xyz" },
      },
    });

    const error = body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
  });

  it("tools/call list_indexed_channels succeeds", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "channels-1",
      method: "tools/call",
      params: {
        name: "list_indexed_channels",
        arguments: {},
      },
    });

    const result = body.result as { structuredContent: { channels: unknown[] } };
    expect(result.structuredContent).toBeDefined();
    expect(Array.isArray(result.structuredContent.channels)).toBe(true);
  });

  it("tools/call get_stats returns numeric counts", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "stats-1",
      method: "tools/call",
      params: {
        name: "get_stats",
        arguments: {},
      },
    });

    const result = body.result as { structuredContent: { channels: number; videos: number; chunks: number } };
    expect(typeof result.structuredContent.channels).toBe("number");
    expect(typeof result.structuredContent.videos).toBe("number");
    expect(typeof result.structuredContent.chunks).toBe("number");
  });

  it("tools/call unknown_tool returns -32602", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "unknown-1",
      method: "tools/call",
      params: {
        name: "totally_fake_tool",
        arguments: {},
      },
    });

    const error = body.error as { code: number };
    expect(error.code).toBe(-32602);
  });

  it("invalid JSON returns -32700 parse error", async () => {
    const res = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json {{{",
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("missing jsonrpc version returns -32600", async () => {
    const { body } = await mcpCall({
      id: "bad-1",
      method: "ping",
    });

    const error = body.error as { code: number };
    expect(error.code).toBe(-32600);
  });

  it("unknown method returns -32601", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "unknown-method-1",
      method: "completely/unknown",
    });

    const error = body.error as { code: number };
    expect(error.code).toBe(-32601);
  });

  it("resources/read for player UI returns HTML", async () => {
    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "res-read-1",
      method: "resources/read",
      params: { uri: "ui://channel-chat/player.html" },
    });

    const result = body.result as { contents: Array<{ uri: string; mimeType: string; text: string }> };
    expect(result.contents.length).toBe(1);
    expect(result.contents[0].mimeType).toContain("text/html");
    expect(result.contents[0].text).toContain("<"); // It's HTML
  });

  it("resources/read for transcript falls back to chunks", async () => {
    // Insert test data so transcript resource can resolve
    await env.DB.prepare(
      "INSERT OR REPLACE INTO channels (id, name, url, indexed_at) VALUES (?, ?, ?, ?)"
    ).bind("__test__mcp_ch", "MCP Test Channel", "https://youtube.com/@mcp", new Date().toISOString()).run();

    await env.DB.prepare(
      "INSERT OR REPLACE INTO videos (id, channel_id, title, transcript_source) VALUES (?, ?, ?, ?)"
    ).bind("__test__mcp_vid", "__test__mcp_ch", "MCP Test Video", "youtube").run();

    await env.DB.prepare(
      "INSERT INTO chunks (video_id, seq, start_time, end_time, text) VALUES (?, ?, ?, ?, ?)"
    ).bind("__test__mcp_vid", 0, 0, 10, "Test transcript segment").run();

    const { body } = await mcpCall({
      jsonrpc: "2.0",
      id: "res-read-2",
      method: "resources/read",
      params: { uri: "transcript://__test__mcp_vid" },
    });

    const result = body.result as { contents: Array<{ uri: string; mimeType: string; text: string }> };
    expect(result.contents.length).toBe(1);
    expect(result.contents[0].mimeType).toBe("application/json");
    const transcript = JSON.parse(result.contents[0].text);
    expect(transcript.video_id).toBe("__test__mcp_vid");
    expect(transcript.segments.length).toBeGreaterThan(0);
  });
});
