import { MCPServer, error, object, widget } from "mcp-use/server";
import { z } from "zod";

type ToolError = {
  code: string;
  message: string;
  retryable: boolean;
};

const ADK_API_BASE_URL = (process.env.ADK_API_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const ADK_API_TIMEOUT_MS = Number.parseInt(process.env.ADK_API_TIMEOUT_MS ?? "9000", 10);
const ADK_DEFAULT_RUN_ID = process.env.ADK_DEFAULT_RUN_ID?.trim() || undefined;
const MANIFEST_CACHE_TTL_MS = 30_000;

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
      message: `ADK runtime timeout after ${ADK_API_TIMEOUT_MS}ms`,
      retryable: true,
    };
  }

  return {
    code: "UPSTREAM_TIMEOUT",
    message: err instanceof Error ? err.message : "Unknown upstream failure",
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
  attempt = 0
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(1000, ADK_API_TIMEOUT_MS));

  try {
    const response = await fetch(`${ADK_API_BASE_URL}${path}`, {
      ...init,
      headers: withCorrelationId(init.headers),
      signal: controller.signal,
    });

    if ((response.status === 502 || response.status === 503) && attempt < 1) {
      return fetchJson(path, init, attempt + 1);
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
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchRuns(): Promise<z.infer<typeof RunsResponseSchema>> {
  const raw = await fetchJson("/runs");
  return RunsResponseSchema.parse(raw);
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

server.tool(
  {
    name: "list_runs",
    description: "List available ADK tutorial runs.",
    schema: z.object({}),
    outputSchema: RunsResponseSchema,
  },
  async () => {
    try {
      const runs = await fetchRuns();
      return object(runs);
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
    }),
    widget: {
      name: "tutorial-player",
      invoking: "Loading tutorial player",
      invoked: "Tutorial player ready",
    },
  },
  async ({ run_id }) => {
    try {
      const resolvedRunId = await resolveRunId(run_id);
      const manifest = await fetchManifest(resolvedRunId);

      if (!manifest.master.available || !manifest.master.video_stream_url) {
        throw {
          code: "MANIFEST_INVALID",
          message: `Run ${resolvedRunId} does not have a playable master video`,
          retryable: false,
        } satisfies ToolError;
      }

      return widget({
        props: {
          run_id: resolvedRunId,
          master_video_url: manifest.master.video_stream_url,
          chapters_track_url: manifest.master.chapters_track_url ?? null,
          chapters: manifest.master.chapters,
          default_chapter: 0,
          quiz_mode: "lite",
        },
        message: JSON.stringify(
          {
            run_id: resolvedRunId,
            chapter_count: manifest.master.chapters.length,
            duration_s: manifest.master.duration_s,
          },
          null,
          2
        ),
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
