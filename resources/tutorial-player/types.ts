import { z } from "zod";

export const chapterSchema = z.object({
  segment_id: z.string(),
  name: z.string(),
  start_s: z.number(),
  end_s: z.number(),
});

export const propSchema = z.object({
  run_id: z.string(),
  master_video_url: z.string(),
  chapters_track_url: z.string().nullable().optional(),
  chapters: z.array(chapterSchema),
  default_chapter: z.number().optional().default(0),
  quiz_mode: z.string().optional().default("lite"),
});

export type TutorialPlayerProps = z.infer<typeof propSchema>;
