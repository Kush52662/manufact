import { MCPServer, error, object, text, widget } from "mcp-use/server";
import { z } from "zod";

type ToolError = {
  code: string;
  message: string;
  retryable: boolean;
};

function resolveAdkBaseUrl(): string {
  const raw = (process.env.ADK_API_BASE_URL ?? "").trim();
  const withScheme = raw
    ? (raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`)
    : "https://fixed-control-van-vocabulary.trycloudflare.com";
  return withScheme.replace(/\/+$/, "");
}

const ADK_API_BASE_URL = resolveAdkBaseUrl();
const ADK_API_TIMEOUT_MS = Number.parseInt(process.env.ADK_API_TIMEOUT_MS ?? "9000", 10);
const ADK_DEFAULT_RUN_ID = process.env.ADK_DEFAULT_RUN_ID?.trim() || undefined;
const MANIFEST_CACHE_TTL_MS = 30_000;
const ADK_FALLBACK_BASE_URLS = ["https://fixed-control-van-vocabulary.trycloudflare.com"];
const ADK_UPSTREAM_BASES = [ADK_API_BASE_URL, ...ADK_FALLBACK_BASE_URLS]
  .map((value) => value.replace(/\/+$/, ""))
  .filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);

const server = new MCPServer({
  name: "peazy-mcp-app",
  title: "Peazy Tutorial Player",
  version: "1.0.0",
  description: "Thin Manufact MCP app that renders a chaptered tutorial player from ADK runtime outputs.",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://manufact.com",
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

const RunInfoSchema = z.object({
  run_id: z.string(),
  manifest_path: z.string(),
  created_at: z.string(),
  segment_count: z.number(),
  duration_sec: z.number().optional().default(0),
});

const RunsResponseSchema = z.object({
  runs: z.array(RunInfoSchema),
});

const PipelineJobSchema = z.object({
  job_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  stage: z.string().optional().default("queued"),
  progress_pct: z.number().optional().default(0),
  message: z.string().optional().default(""),
  youtube_url: z.string().optional().default(""),
  run_name: z.string().optional().default(""),
  run_id: z.string().nullable().optional(),
  started_at: z.string().optional().default(""),
  updated_at: z.string().optional().default(""),
  completed_at: z.string().optional(),
  failed_at: z.string().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional().default(false),
    })
    .optional(),
});

const PipelineJobCreateSchema = z.object({
  job: PipelineJobSchema,
});

const PipelineJobsSchema = z.object({
  jobs: z.array(PipelineJobSchema),
});

const RunCardSchema = RunInfoSchema.extend({
  poom_url: z.string(),
});

const PoomDashboardSchema = z.object({
  active_jobs: z.array(PipelineJobSchema),
  runs: z.array(RunCardSchema),
});

const ChapterSchema = z.object({
  segment_id: z.string(),
  name: z.string(),
  start_s: z.number(),
  end_s: z.number(),
});

const SegmentSchema = z.object({
  segment_id: z.string(),
  name: z.string(),
  dub_script: z.string().optional().default(""),
  original_transcript_summary: z.string().optional().default(""),
  visual_description: z.string().optional().default(""),
  stt_indices: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
  video_stream_url: z.string().optional().default(""),
});

const ManifestSchema = z.object({
  run_id: z.string(),
  manifest_path: z.string(),
  updated_at: z.number(),
  segments: z.array(SegmentSchema),
  master: z.object({
    available: z.boolean(),
    video_stream_url: z.string().nullable().optional(),
    chapters_track_url: z.string().nullable().optional(),
    duration_s: z.number().optional().default(0),
    chapters: z.array(ChapterSchema).default([]),
    skipped_segments: z.array(z.object({}).passthrough()).optional().default([]),
  }),
  errors: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
});

const QuizSchema = z.object({
  run_id: z.string(),
  segment_id: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      options: z.array(z.string()),
      correct_index: z.number(),
      explanation: z.string(),
    })
  ),
});

const QuizScoreSchema = z.object({
  run_id: z.string(),
  segment_id: z.string(),
  score: z.number(),
  correct: z.number(),
  total: z.number(),
  details: z.array(
    z.object({
      id: z.string().optional(),
      is_correct: z.boolean(),
      expected_index: z.number().nullable().optional(),
      selected_index: z.number().nullable().optional(),
      explanation: z.string(),
    })
  ),
});

const manifestCache = new Map<string, { expiresAt: number; payload: z.infer<typeof ManifestSchema> }>();
const inflightManifest = new Map<string, Promise<z.infer<typeof ManifestSchema>>>();

function toPoomUrl(runId: string): string {
  return `poom://run/${encodeURIComponent(runId)}`;
}

function parsePoomRef(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const poomMatch = trimmed.match(/^poom:\/\/run\/(.+)$/i);
  if (poomMatch && poomMatch[1]) {
    return decodeURIComponent(poomMatch[1]);
  }
  const queryMatch = trimmed.match(/[?&]run_id=([^&#]+)/i);
  if (queryMatch && queryMatch[1]) {
    return decodeURIComponent(queryMatch[1]);
  }
  return trimmed;
}

function normalizeError(err: unknown): ToolError {
  if (typeof err === "object" && err !== null) {
    const maybe = err as Partial<ToolError>;
    if (typeof maybe.code === "string" && typeof maybe.message === "string") {
      return {
        code: maybe.code,
        message: maybe.message,
        retryable: Boolean(maybe.retryable),
      };
    }
  }

  if (err instanceof Error && err.name === "AbortError") {
    return {
      code: "UPSTREAM_TIMEOUT",
      message: `ADK runtime timeout after ${ADK_API_TIMEOUT_MS}ms (${ADK_API_BASE_URL})`,
      retryable: true,
    };
  }

  return {
    code: "UPSTREAM_TIMEOUT",
    message: `${err instanceof Error ? err.message : "Unknown upstream failure"} (${ADK_API_BASE_URL})`,
    retryable: true,
  };
}

function toolError(err: unknown) {
  const normalized = normalizeError(err);
  return error(`${normalized.code}: ${normalized.message}`);
}

function withCorrelationId(headers: HeadersInit | undefined) {
  const merged = new Headers(headers);
  merged.set("x-correlation-id", crypto.randomUUID());
  return merged;
}

async function fetchJson(
  path: string,
  init: RequestInit = {},
  attempt = 0,
  upstreamIndex = 0
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, ADK_API_TIMEOUT_MS));
  const upstreamBase = ADK_UPSTREAM_BASES[upstreamIndex] ?? ADK_API_BASE_URL;

  try {
    const response = await fetch(`${upstreamBase}${path}`, {
      ...init,
      headers: withCorrelationId(init.headers),
      signal: controller.signal,
    });

    if ((response.status === 502 || response.status === 503) && attempt < 1) {
      return fetchJson(path, init, attempt + 1, upstreamIndex);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstream = (data as { error?: ToolError }).error;
      if (upstream && upstream.code && upstream.message) {
        throw {
          code: upstream.code,
          message: upstream.message,
          retryable: Boolean(upstream.retryable),
        } satisfies ToolError;
      }

      throw {
        code: response.status === 404 ? "RUN_NOT_FOUND" : "UPSTREAM_TIMEOUT",
        message: `ADK runtime request failed (${response.status})`,
        retryable: response.status >= 500,
      } satisfies ToolError;
    }

    return data;
  } catch (err) {
    if (upstreamIndex + 1 < ADK_UPSTREAM_BASES.length) {
      return fetchJson(path, init, attempt, upstreamIndex + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchRuns(): Promise<z.infer<typeof RunsResponseSchema>> {
  const raw = await fetchJson("/runs");
  return RunsResponseSchema.parse(raw);
}

async function fetchPipelineJobs(): Promise<z.infer<typeof PipelineJobsSchema>> {
  const raw = await fetchJson("/pipeline/jobs");
  return PipelineJobsSchema.parse(raw);
}

async function fetchPipelineJob(jobId: string): Promise<z.infer<typeof PipelineJobSchema>> {
  const raw = await fetchJson(`/pipeline/jobs/${encodeURIComponent(jobId)}`);
  const parsed = z.object({ job: PipelineJobSchema }).parse(raw);
  return parsed.job;
}

async function fetchManifest(runId: string): Promise<z.infer<typeof ManifestSchema>> {
  const cached = manifestCache.get(runId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.payload;
  }

  const existing = inflightManifest.get(runId);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const raw = await fetchJson(`/runs/${encodeURIComponent(runId)}/manifest`);
    const parsed = ManifestSchema.parse(raw);
    manifestCache.set(runId, { expiresAt: now + MANIFEST_CACHE_TTL_MS, payload: parsed });
    return parsed;
  })();

  inflightManifest.set(runId, task);
  try {
    return await task;
  } finally {
    inflightManifest.delete(runId);
  }
}

async function resolveRunId(inputRunId?: string): Promise<string> {
  if (inputRunId) {
    return inputRunId;
  }

  if (ADK_DEFAULT_RUN_ID) {
    return ADK_DEFAULT_RUN_ID;
  }

  const runs = await fetchRuns();
  if (!runs.runs.length) {
    throw {
      code: "RUN_NOT_FOUND",
      message: "No tutorial runs are currently available",
      retryable: false,
    } satisfies ToolError;
  }

  return runs.runs[0].run_id;
}

function hubWidgetResponse(runs: z.infer<typeof RunInfoSchema>[], activeJobs: z.infer<typeof PipelineJobSchema>[]) {
  const runCards = runs.map((run) => ({
    ...run,
    poom_url: toPoomUrl(run.run_id),
  }));

  return widget({
    props: {
      mode: "hub",
      runs: runCards,
      active_jobs: activeJobs,
      hub_message: `Loaded ${runCards.length} POOM run(s).`,
    },
    output: text(`POOM hub ready with ${runCards.length} run(s) and ${activeJobs.length} active job(s).`),
  });
}

server.tool(
  {
    name: "list_runs",
    description: "List available ADK tutorial runs.",
    schema: z.object({}),
    widget: {
      name: "tutorial-player-v2",
      invoking: "Loading POOM hub",
      invoked: "POOM hub ready",
    },
  },
  async () => {
    try {
      const runs = await fetchRuns();
      return hubWidgetResponse(runs.runs, []);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  {
    name: "list_pooms",
    description: "List available POOM walkthroughs and active creation jobs.",
    schema: z.object({}),
    widget: {
      name: "tutorial-player-v2",
      invoking: "Loading POOM hub",
      invoked: "POOM hub ready",
    },
  },
  async () => {
    try {
      const [runs, jobs] = await Promise.all([fetchRuns(), fetchPipelineJobs()]);
      const activeJobs = jobs.jobs.filter((job) => job.status === "queued" || job.status === "running");
      return hubWidgetResponse(runs.runs, activeJobs);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  {
    name: "create_poom",
    description: "Create a new POOM from a public video URL and return a job id for progress polling.",
    schema: z.object({
      youtube_url: z.string().url().describe("Public video URL (YouTube/Loom/Zoom) to generate a POOM from."),
      run_id: z.string().optional().describe("Optional custom run id slug."),
    }),
    outputSchema: PipelineJobCreateSchema,
  },
  async ({ youtube_url, run_id }) => {
    try {
      const raw = await fetchJson("/pipeline/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ youtube_url, run_id }),
      });
      const created = PipelineJobCreateSchema.parse(raw);
      return object(created);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  {
    name: "get_poom_status",
    description: "Get POOM creation progress and current POOM library snapshot.",
    schema: z.object({
      job_id: z.string(),
    }),
    outputSchema: z.object({
      job: PipelineJobSchema,
      runs: z.array(RunCardSchema),
    }),
  },
  async ({ job_id }) => {
    try {
      const [job, runs] = await Promise.all([fetchPipelineJob(job_id), fetchRuns()]);
      return object({
        job,
        runs: runs.runs.map((run) => ({
          ...run,
          poom_url: toPoomUrl(run.run_id),
        })),
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  {
    name: "open_run_player",
    description: "Open the Vidstack tutorial player for a run using master video chapters.",
    schema: z.object({
      run_id: z.string().optional().describe("Optional run identifier; defaults to ADK_DEFAULT_RUN_ID or latest run."),
      poom_ref: z
        .string()
        .optional()
        .describe("Optional POOM reference (e.g. poom://run/<run_id> or URL containing run_id)."),
    }),
    widget: {
      name: "tutorial-player-v2",
      invoking: "Loading tutorial player",
      invoked: "Tutorial player ready",
    },
  },
  async ({ run_id, poom_ref }) => {
    try {
      const resolvedRunId = await resolveRunId(run_id || parsePoomRef(poom_ref));
      const manifest = await fetchManifest(resolvedRunId);

      if (!manifest.master.available || !manifest.master.video_stream_url) {
        throw {
          code: "MANIFEST_INVALID",
          message: `Run ${resolvedRunId} does not have a playable master video`,
          retryable: false,
        } satisfies ToolError;
      }

      const chaptersWithMeta = manifest.master.chapters.map((chapter, index) => {
        const seg = manifest.segments.find((row) => row.segment_id === chapter.segment_id);
        return {
          index: index + 1,
          segment_id: chapter.segment_id,
          name: chapter.name,
          start_s: chapter.start_s,
          end_s: chapter.end_s,
          dub_script: seg?.dub_script ?? "",
          original_transcript_summary: seg?.original_transcript_summary ?? "",
          visual_description: seg?.visual_description ?? "",
        };
      });

      const metadataLines = chaptersWithMeta.map((chapter) => {
        const summary = chapter.original_transcript_summary || "No summary";
        return `- ${chapter.index}. ${chapter.name} (${chapter.start_s.toFixed(1)}s-${chapter.end_s.toFixed(1)}s): ${summary}`;
      });

      return widget({
        props: {
          run_id: resolvedRunId,
          master_video_url: manifest.master.video_stream_url,
          chapters_track_url: manifest.master.chapters_track_url ?? null,
          chapters: manifest.master.chapters,
          default_chapter: 0,
          quiz_mode: "lite",
        },
        message: [
          `POOM ready: ${resolvedRunId}`,
          `POOM URL: ${toPoomUrl(resolvedRunId)}`,
          `Duration: ${manifest.master.duration_s.toFixed(2)}s`,
          `Chapters: ${manifest.master.chapters.length}`,
          `Manifest updated: ${new Date(manifest.updated_at * 1000).toISOString()}`,
          "",
          "Chapter metadata:",
          ...metadataLines,
        ].join("\n"),
      });
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  {
    name: "get_segment_quiz",
    description: "Fetch lightweight quiz questions for one run segment.",
    schema: z.object({
      run_id: z.string(),
      segment_id: z.string(),
    }),
    outputSchema: QuizSchema,
  },
  async ({ run_id, segment_id }) => {
    try {
      const raw = await fetchJson(`/quiz/${encodeURIComponent(run_id)}/${encodeURIComponent(segment_id)}`);
      return object(QuizSchema.parse(raw));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  {
    name: "submit_segment_quiz",
    description: "Submit quiz answers for a segment and get an immediate score.",
    schema: z.object({
      run_id: z.string(),
      segment_id: z.string(),
      answers: z.array(
        z.object({
          id: z.string(),
          selected_index: z.number(),
        })
      ),
    }),
    outputSchema: QuizScoreSchema,
  },
  async ({ run_id, segment_id, answers }) => {
    try {
      const raw = await fetchJson(
        `/quiz/${encodeURIComponent(run_id)}/${encodeURIComponent(segment_id)}/score`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ answers }),
        }
      );
      return object(QuizScoreSchema.parse(raw));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.listen().then(() => {
  console.log("MCP app server running");
});
