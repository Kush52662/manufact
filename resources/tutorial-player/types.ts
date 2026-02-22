import { z } from "zod";

export const chapterSchema = z.object({
  segment_id: z.string(),
  name: z.string(),
  start_s: z.number(),
  end_s: z.number(),
});

export const runCardSchema = z.object({
  run_id: z.string(),
  manifest_path: z.string().optional().default(""),
  created_at: z.string().optional().default(""),
  segment_count: z.number().optional().default(0),
  duration_sec: z.number().optional().default(0),
  poom_url: z.string().optional().default(""),
});

export const jobSchema = z.object({
  job_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  stage: z.string().optional().default("queued"),
  progress_pct: z.number().optional().default(0),
  message: z.string().optional().default(""),
  youtube_url: z.string().optional().default(""),
  run_name: z.string().optional().default(""),
  run_id: z.string().nullable().optional(),
  updated_at: z.string().optional().default(""),
  started_at: z.string().optional().default(""),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional().default(false),
    })
    .optional(),
});

export const propSchema = z.object({
  mode: z.enum(["hub", "player"]).optional().default("player"),
  run_id: z.string().optional().default(""),
  master_video_url: z.string().nullable().optional(),
  chapters_track_url: z.string().nullable().optional(),
  chapters: z.array(chapterSchema).optional().default([]),
  default_chapter: z.number().optional().default(0),
  quiz_mode: z.string().optional().default("lite"),
  runs: z.array(runCardSchema).optional().default([]),
  active_jobs: z.array(jobSchema).optional().default([]),
  hub_message: z.string().optional().default(""),
});

export type TutorialPlayerProps = z.infer<typeof propSchema>;
