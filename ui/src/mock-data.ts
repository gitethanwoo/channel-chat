/**
 * Mock data for standalone UI development.
 * This allows rapid iteration on the UI without needing the full MCP flow.
 */

export interface TranscriptSegment {
  start_time: number;
  end_time: number;
  text: string;
}

export interface ShowVideoResult {
  video_id: string;
  video_title: string;
  channel_name: string;
  video_url: string;
  start_time: number;
  transcript_uri: string;
  description: string | null;
  reason: string | null;
}

export interface TranscriptData {
  video_id: string;
  video_title: string;
  channel_name: string;
  segments: TranscriptSegment[];
}

export const MOCK_SHOW_VIDEO_RESULT: ShowVideoResult = {
  video_id: "dQw4w9WgXcQ",
  video_title: "The Future of Forward Deployed Engineering",
  channel_name: "Y Combinator",
  video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  start_time: 12,
  transcript_uri: "transcript://dQw4w9WgXcQ",
  description: `Bob McGrew helped build some of the most influential technologies of the past two decades. Bob was an early engineer at PayPal, an early executive at Palantir and was recently Chief Research Officer at OpenAI - where he led the development of ChatGPT, GPT-4 and the o1 reasoning model.

Apply to Y Combinator: https://www.ycombinator.com/apply
Work at a startup: https://www.ycombinator.com/jobs

Chapters:
00:29 - From PayPal to Palantir to OpenAI
02:19 - The Role of a Forward Deployed Engineer
03:19 - How Palantir Invented It
07:56 - Product Discovery in the Field vs. Sales
09:51 - Echo and Delta Teams Explained
13:34 - Training Ground for Founders`,
  reason: "This video discusses the FDE role at Palantir and how they bridge product and customer needs - directly relevant to your question about forward deployed engineering.",
};

export const MOCK_TRANSCRIPT: TranscriptData = {
  video_id: "dQw4w9WgXcQ",
  video_title: "The Future of Forward Deployed Engineering",
  channel_name: "Y Combinator",
  segments: [
    {
      start_time: 0,
      end_time: 5,
      text: "Welcome back to the channel. Today we're talking about a role that is often misunderstood.",
    },
    {
      start_time: 5,
      end_time: 12,
      text: "It's the Forward Deployed Engineer. A lot of people think it's just sales engineering, or maybe just support.",
    },
    {
      start_time: 12,
      end_time: 18,
      text: "But actually, at companies like Palantir or OpenAI, it's something entirely different.",
    },
    {
      start_time: 18,
      end_time: 25,
      text: "So when founders come to me and ask, 'How do I hire my first FDE?', I usually tell them to look for builders.",
    },
    {
      start_time: 25,
      end_time: 32,
      text: "You need someone who can write production code, but who also has that empathy to sit with a customer.",
    },
    {
      start_time: 32,
      end_time: 40,
      text: "I remember back in 2015, we had this massive issue deploying the model at a large enterprise client.",
    },
    {
      start_time: 40,
      end_time: 48,
      text: "The engineering team built something beautiful, but it didn't work in production. Classic story, right?",
    },
    {
      start_time: 48,
      end_time: 55,
      text: "That's when we realized we needed engineers who could bridge that gap between product and customer.",
    },
    {
      start_time: 55,
      end_time: 63,
      text: "The FDE role evolved from that need. It's not just about technical skills, it's about understanding context.",
    },
    {
      start_time: 63,
      end_time: 70,
      text: "You're essentially a consultant, a developer, and a product manager all rolled into one.",
    },
    {
      start_time: 70,
      end_time: 78,
      text: "And the best FDEs I've worked with, they don't just solve the problem in front of them.",
    },
    {
      start_time: 78,
      end_time: 85,
      text: "They think about how that solution can be generalized, brought back to the product team.",
    },
    {
      start_time: 85,
      end_time: 92,
      text: "That feedback loop is what makes companies like Palantir so effective at enterprise sales.",
    },
    {
      start_time: 92,
      end_time: 100,
      text: "So if you're thinking about this career path, ask yourself: do you like ambiguity? Do you like customers?",
    },
  ],
};
