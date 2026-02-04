import { describe, it, expect, beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import {
  upsertChannel,
  getChannel,
  listChannels,
  upsertVideo,
  getVideo,
  listVideos,
  insertChunk,
  updateChunkVectorizeId,
  getChunksByVectorizeIds,
  getVideoChunks,
  deleteVideoChunks,
  deleteVideo,
  getStats,
} from "../db";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("D1 Database Operations", () => {
  // --- Channel operations ---

  describe("channels", () => {
    it("upsertChannel → getChannel roundtrip", async () => {
      await upsertChannel(env.DB, {
        id: "__test__ch_1",
        name: "Test Channel",
        url: "https://youtube.com/@test",
      });

      const ch = await getChannel(env.DB, "__test__ch_1");
      expect(ch).not.toBeNull();
      expect(ch!.id).toBe("__test__ch_1");
      expect(ch!.name).toBe("Test Channel");
      expect(ch!.url).toBe("https://youtube.com/@test");
      expect(ch!.indexed_at).toBeTruthy();
    });

    it("upsertChannel updates name on conflict", async () => {
      await upsertChannel(env.DB, {
        id: "__test__ch_1",
        name: "Updated Channel Name",
        url: "https://youtube.com/@test",
      });

      const ch = await getChannel(env.DB, "__test__ch_1");
      expect(ch!.name).toBe("Updated Channel Name");
    });

    it("listChannels returns results ordered by indexed_at DESC", async () => {
      // Insert channels with explicit timestamps to guarantee ordering
      await env.DB
        .prepare("INSERT OR REPLACE INTO channels (id, name, url, indexed_at) VALUES (?, ?, ?, ?)")
        .bind("__test__ch_a", "Channel A", "https://youtube.com/@a", "2024-01-01T00:00:00Z")
        .run();
      await env.DB
        .prepare("INSERT OR REPLACE INTO channels (id, name, url, indexed_at) VALUES (?, ?, ?, ?)")
        .bind("__test__ch_b", "Channel B", "https://youtube.com/@b", "2024-06-01T00:00:00Z")
        .run();
      await env.DB
        .prepare("INSERT OR REPLACE INTO channels (id, name, url, indexed_at) VALUES (?, ?, ?, ?)")
        .bind("__test__ch_c", "Channel C", "https://youtube.com/@c", "2024-12-01T00:00:00Z")
        .run();

      const channels = await listChannels(env.DB);
      expect(channels.length).toBeGreaterThanOrEqual(3);
      // Most recent indexed_at should come first (DESC order)
      const ids = channels.map((c) => c.id);
      const idxC = ids.indexOf("__test__ch_c");
      const idxB = ids.indexOf("__test__ch_b");
      const idxA = ids.indexOf("__test__ch_a");
      expect(idxC).toBeLessThan(idxB);
      expect(idxB).toBeLessThan(idxA);
    });
  });

  // --- Video operations ---

  describe("videos", () => {
    beforeAll(async () => {
      await upsertChannel(env.DB, {
        id: "__test__ch_vid",
        name: "Video Test Channel",
        url: "https://youtube.com/@vidtest",
      });
    });

    it("upsertVideo → getVideo roundtrip with all fields", async () => {
      await upsertVideo(env.DB, {
        id: "__test__vid_1",
        channel_id: "__test__ch_vid",
        title: "Test Video Title",
        description: "A test description",
        duration: 300,
        published_at: "2024-01-01T00:00:00Z",
        thumbnail_url: "https://img.youtube.com/vi/test/0.jpg",
        transcript_source: "youtube",
        r2_video_key: "videos/__test__vid_1.mp4",
        r2_transcript_key: "transcripts/__test__vid_1.json",
      });

      const v = await getVideo(env.DB, "__test__vid_1");
      expect(v).not.toBeNull();
      expect(v!.id).toBe("__test__vid_1");
      expect(v!.channel_id).toBe("__test__ch_vid");
      expect(v!.title).toBe("Test Video Title");
      expect(v!.description).toBe("A test description");
      expect(v!.duration).toBe(300);
      expect(v!.published_at).toBe("2024-01-01T00:00:00Z");
      expect(v!.thumbnail_url).toBe(
        "https://img.youtube.com/vi/test/0.jpg"
      );
      expect(v!.transcript_source).toBe("youtube");
      expect(v!.r2_video_key).toBe("videos/__test__vid_1.mp4");
      expect(v!.r2_transcript_key).toBe("transcripts/__test__vid_1.json");
    });

    it("listVideos returns all videos", async () => {
      // Each test has isolated storage, so insert both videos here
      await upsertVideo(env.DB, {
        id: "__test__vid_list_1",
        channel_id: "__test__ch_vid",
        title: "First List Video",
        description: null,
        duration: null,
        published_at: "2024-01-01T00:00:00Z",
        thumbnail_url: null,
        transcript_source: "youtube",
        r2_video_key: null,
        r2_transcript_key: null,
      });
      await upsertVideo(env.DB, {
        id: "__test__vid_list_2",
        channel_id: "__test__ch_vid",
        title: "Second List Video",
        description: null,
        duration: null,
        published_at: "2024-02-01T00:00:00Z",
        thumbnail_url: null,
        transcript_source: "elevenlabs",
        r2_video_key: null,
        r2_transcript_key: null,
      });

      const all = await listVideos(env.DB);
      const testVids = all.filter((v) => v.id.startsWith("__test__vid_list_"));
      expect(testVids.length).toBe(2);
    });

    it("listVideos with channel filter", async () => {
      await upsertVideo(env.DB, {
        id: "__test__vid_filter_1",
        channel_id: "__test__ch_vid",
        title: "Filtered Video",
        description: null,
        duration: null,
        published_at: "2024-01-01T00:00:00Z",
        thumbnail_url: null,
        transcript_source: "youtube",
        r2_video_key: null,
        r2_transcript_key: null,
      });

      const filtered = await listVideos(env.DB, "__test__ch_vid");
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered.every((v) => v.channel_id === "__test__ch_vid")).toBe(
        true
      );
    });
  });

  // --- Chunk operations ---

  describe("chunks", () => {
    beforeAll(async () => {
      await upsertChannel(env.DB, {
        id: "__test__ch_chunk",
        name: "Chunk Test Channel",
        url: "https://youtube.com/@chunktest",
      });
      await upsertVideo(env.DB, {
        id: "__test__vid_chunk",
        channel_id: "__test__ch_chunk",
        title: "Chunk Test Video",
        description: null,
        duration: 600,
        published_at: null,
        thumbnail_url: null,
        transcript_source: "youtube",
        r2_video_key: "videos/__test__vid_chunk.mp4",
        r2_transcript_key: null,
      });
    });

    it("insertChunk returns auto-incremented id", async () => {
      const id = await insertChunk(env.DB, {
        video_id: "__test__vid_chunk",
        seq: 0,
        start_time: 0,
        end_time: 10.5,
        text: "Hello world, this is chunk zero.",
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("insertChunk → getVideoChunks roundtrip", async () => {
      // Clear any existing chunks from previous test run
      await deleteVideoChunks(env.DB, "__test__vid_chunk");

      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await insertChunk(env.DB, {
          video_id: "__test__vid_chunk",
          seq: i,
          start_time: i * 10,
          end_time: (i + 1) * 10,
          text: `Chunk number ${i} text content.`,
        });
        ids.push(id);
      }

      const chunks = await getVideoChunks(env.DB, "__test__vid_chunk");
      expect(chunks.length).toBe(3);
      // Verify order by seq
      expect(chunks[0].seq).toBe(0);
      expect(chunks[1].seq).toBe(1);
      expect(chunks[2].seq).toBe(2);
      expect(chunks[0].text).toBe("Chunk number 0 text content.");
    });

    it("updateChunkVectorizeId updates the vectorize_id", async () => {
      await deleteVideoChunks(env.DB, "__test__vid_chunk");
      const id = await insertChunk(env.DB, {
        video_id: "__test__vid_chunk",
        seq: 0,
        start_time: 0,
        end_time: 10,
        text: "Test chunk for vectorize id update.",
      });

      await updateChunkVectorizeId(env.DB, id, `chunk_${id}`);

      const chunks = await getVideoChunks(env.DB, "__test__vid_chunk");
      expect(chunks[0].vectorize_id).toBe(`chunk_${id}`);
    });

    it("getChunksByVectorizeIds JOINs video and channel data", async () => {
      await deleteVideoChunks(env.DB, "__test__vid_chunk");

      const id1 = await insertChunk(env.DB, {
        video_id: "__test__vid_chunk",
        seq: 0,
        start_time: 0,
        end_time: 10,
        text: "First chunk for join test.",
      });
      const id2 = await insertChunk(env.DB, {
        video_id: "__test__vid_chunk",
        seq: 1,
        start_time: 10,
        end_time: 20,
        text: "Second chunk for join test.",
      });

      await updateChunkVectorizeId(env.DB, id1, `test_vec_${id1}`);
      await updateChunkVectorizeId(env.DB, id2, `test_vec_${id2}`);

      const results = await getChunksByVectorizeIds(env.DB, [
        `test_vec_${id1}`,
        `test_vec_${id2}`,
      ]);

      expect(results.length).toBe(2);
      expect(results[0].video_title).toBe("Chunk Test Video");
      expect(results[0].channel_name).toBe("Chunk Test Channel");
      expect(results[0].channel_id).toBe("__test__ch_chunk");
      expect(results[0].r2_video_key).toBe("videos/__test__vid_chunk.mp4");
    });

    it("getChunksByVectorizeIds with empty array returns []", async () => {
      const results = await getChunksByVectorizeIds(env.DB, []);
      expect(results).toEqual([]);
    });

    it("deleteVideoChunks removes all chunks for a video", async () => {
      // Ensure we have chunks
      await insertChunk(env.DB, {
        video_id: "__test__vid_chunk",
        seq: 99,
        start_time: 0,
        end_time: 5,
        text: "To be deleted.",
      });

      const before = await getVideoChunks(env.DB, "__test__vid_chunk");
      expect(before.length).toBeGreaterThan(0);

      await deleteVideoChunks(env.DB, "__test__vid_chunk");

      const after = await getVideoChunks(env.DB, "__test__vid_chunk");
      expect(after.length).toBe(0);
    });
  });

  // --- Delete video ---

  describe("deleteVideo", () => {
    it("removes the video row", async () => {
      await upsertChannel(env.DB, {
        id: "__test__ch_del",
        name: "Delete Test Channel",
        url: "https://youtube.com/@deltest",
      });
      await upsertVideo(env.DB, {
        id: "__test__vid_del",
        channel_id: "__test__ch_del",
        title: "To Be Deleted",
        description: null,
        duration: null,
        published_at: null,
        thumbnail_url: null,
        transcript_source: "youtube",
        r2_video_key: null,
        r2_transcript_key: null,
      });

      const before = await getVideo(env.DB, "__test__vid_del");
      expect(before).not.toBeNull();

      await deleteVideo(env.DB, "__test__vid_del");

      const after = await getVideo(env.DB, "__test__vid_del");
      expect(after).toBeNull();
    });
  });

  // --- Stats ---

  describe("getStats", () => {
    it("returns correct counts after insertions", async () => {
      // Insert data in this isolated scope
      await upsertChannel(env.DB, {
        id: "__test__ch_stats",
        name: "Stats Channel",
        url: "https://youtube.com/@stats",
      });
      await upsertVideo(env.DB, {
        id: "__test__vid_stats",
        channel_id: "__test__ch_stats",
        title: "Stats Video",
        description: null,
        duration: null,
        published_at: null,
        thumbnail_url: null,
        transcript_source: "youtube",
        r2_video_key: null,
        r2_transcript_key: null,
      });
      await insertChunk(env.DB, {
        video_id: "__test__vid_stats",
        seq: 0,
        start_time: 0,
        end_time: 10,
        text: "Stats test chunk.",
      });

      const stats = await getStats(env.DB);
      expect(typeof stats.channels).toBe("number");
      expect(typeof stats.videos).toBe("number");
      expect(typeof stats.chunks).toBe("number");
      expect(stats.channels).toBeGreaterThan(0);
      expect(stats.videos).toBeGreaterThan(0);
      expect(stats.chunks).toBeGreaterThan(0);
    });
  });
});
