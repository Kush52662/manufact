import { AppsSDKUIProvider } from "@openai/apps-sdk-ui/components/AppsSDKUIProvider";
import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import { MediaPlayer, MediaProvider, Track } from "@vidstack/react";
import "@vidstack/react/player/styles/default/theme.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import "../styles.css";
import "./widget.css";
import type { TutorialPlayerProps } from "./types";
import { propSchema } from "./types";

export const widgetMetadata: WidgetMetadata = {
  description: "Single-surface POOM hub + tutorial player.",
  props: propSchema,
  exposeAsTool: false,
  metadata: {
    prefersBorder: false,
    invoking: "Loading tutorial player...",
    invoked: "Tutorial player ready",
    csp: {
      connectDomains: [
        "https://storage.googleapis.com",
        "https://storage.cloud.google.com",
        "https://*.googleapis.com",
        "https://*.run.app",
      ],
      resourceDomains: [
        "https://storage.googleapis.com",
        "https://storage.cloud.google.com",
        "https://*.googleapis.com",
        "https://*.run.app",
      ],
    },
  },
};

type RunCard = {
  run_id: string;
  run_title?: string;
  created_at?: string;
  segment_count?: number;
  duration_sec?: number;
  poom_url?: string;
};

type PoomJob = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  stage?: string;
  progress_pct?: number;
  message?: string;
  run_id?: string | null;
  error?: { message?: string };
};

function formatSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatWhen(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function formatRunTitle(run: RunCard): string {
  if (run.run_title && run.run_title.trim()) {
    return run.run_title.trim();
  }
  const normalized = run.run_id.replace(/^runs-yc-/i, "").replace(/-\d{8}-[a-f0-9]{8}$/i, "");
  return normalized
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

const TutorialPlayer: React.FC = () => {
  const { props, isPending, requestDisplayMode, displayMode, isAvailable, callTool } = useWidget<TutorialPlayerProps>();

  const [isHubMode, setIsHubMode] = useState<boolean>(props?.mode === "hub" || !props?.master_video_url);
  const [hubRuns, setHubRuns] = useState<RunCard[]>(props?.runs ?? []);
  const [hubJobs, setHubJobs] = useState<PoomJob[]>(props?.active_jobs ?? []);
  const [hubMessage, setHubMessage] = useState<string>(props?.hub_message ?? "POOM hub ready.");
  const [inputUrl, setInputUrl] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const [playerRunId, setPlayerRunId] = useState(props?.run_id ?? "");
  const [playerVideoUrl, setPlayerVideoUrl] = useState(props?.master_video_url ?? "");
  const [playerTrackUrl, setPlayerTrackUrl] = useState<string | null>(props?.chapters_track_url ?? null);
  const [chapters, setChapters] = useState(props?.chapters ?? []);

  const playerRef = useRef<any>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [lastInteraction, setLastInteraction] = useState("");
  const [modePending, setModePending] = useState<"inline" | "fullscreen" | "pip" | null>(null);

  useEffect(() => {
    setHubRuns(props?.runs ?? []);
    setHubJobs(props?.active_jobs ?? []);
    if (props?.hub_message) {
      setHubMessage(props.hub_message);
    }

    const incomingUrl = props?.master_video_url ?? "";
    if (incomingUrl) {
      setPlayerRunId(props?.run_id ?? "");
      setPlayerVideoUrl(incomingUrl);
      setPlayerTrackUrl(props?.chapters_track_url ?? null);
      setChapters(props?.chapters ?? []);
      if (props?.mode !== "hub") {
        setIsHubMode(false);
      }
    } else if (props?.mode === "hub") {
      setIsHubMode(true);
    }
  }, [props]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = Number(playerRef.current?.currentTime ?? 0);
      if (Number.isFinite(current) && current >= 0) {
        setPosition(current);
      }
    }, 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!lastInteraction) return;
    const timer = setTimeout(() => setLastInteraction(""), 2400);
    return () => clearTimeout(timer);
  }, [lastInteraction]);

  useEffect(
    () => () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    },
    []
  );

  const activeIndex = useMemo(() => {
    if (!chapters.length) return -1;
    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      const start = Number(chapter.start_s || 0);
      const end = Number(chapter.end_s || 0);
      if (position >= start && position < end) {
        return index;
      }
    }
    return chapters.length - 1;
  }, [chapters, position]);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const applyPlayerPayload = (payload: any) => {
    const videoUrl = typeof payload?.master_video_url === "string" ? payload.master_video_url : "";
    if (!videoUrl) {
      setHubMessage("No playable master video was returned for this run.");
      return;
    }

    setPlayerRunId(typeof payload?.run_id === "string" ? payload.run_id : "");
    setPlayerVideoUrl(videoUrl);
    setPlayerTrackUrl(typeof payload?.chapters_track_url === "string" ? payload.chapters_track_url : null);
    setChapters(asArray(payload?.chapters));
    setPosition(0);
    setMenuOpen(false);
    setIsHubMode(false);
  };

  const refreshHub = useCallback(async () => {
    setIsWorking(true);
    try {
      const response = await callTool("list_pooms", {});
      const data = (response?.structuredContent ?? {}) as any;
      setHubRuns(asArray<RunCard>(data.runs));
      setHubJobs(asArray<PoomJob>(data.active_jobs));
      setHubMessage(`Loaded ${asArray<RunCard>(data.runs).length} POOM runs.`);
    } catch (err) {
      setHubMessage(`Failed to load runs: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setIsWorking(false);
    }
  }, [callTool]);

  const openRun = useCallback(
    async (runId: string) => {
      if (!runId) return;
      setIsWorking(true);
      try {
        const response = await callTool("open_run_player", { run_id: runId });
        applyPlayerPayload(response?.structuredContent ?? {});
        setHubMessage(`Opened run: ${runId}`);
      } catch (err) {
        setHubMessage(`Failed to open run: ${err instanceof Error ? err.message : "unknown error"}`);
      } finally {
        setIsWorking(false);
      }
    },
    [callTool]
  );

  const pollJob = useCallback(
    async (jobId: string) => {
      try {
        const response = await callTool("get_poom_status", { job_id: jobId });
        const data = (response?.structuredContent ?? {}) as any;
        const job = data?.job as PoomJob | undefined;
        const runs = asArray<RunCard>(data?.runs);
        setHubRuns(runs);

        if (job) {
          setHubJobs((prev) => [job, ...prev.filter((row) => row.job_id !== job.job_id)].slice(0, 8));
          const pct = Number(job.progress_pct ?? 0);
          setHubMessage(`${job.status.toUpperCase()} · ${job.stage ?? ""} · ${pct}%`);

          if (job.status === "completed") {
            stopPolling();
            if (job.run_id) {
              await openRun(job.run_id);
            } else {
              setHubMessage("POOM completed but run_id is missing. Refresh and open manually.");
            }
            return;
          }

          if (job.status === "failed") {
            stopPolling();
            const detail = job.error?.message || job.message || "Unknown failure";
            setHubMessage(`POOM failed: ${detail}`);
            return;
          }
        }

        pollTimerRef.current = window.setTimeout(() => {
          void pollJob(jobId);
        }, 3500);
      } catch (err) {
        stopPolling();
        setHubMessage(`Polling failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    },
    [callTool, openRun]
  );

  const createPoom = useCallback(async () => {
    const url = inputUrl.trim();
    if (!url) {
      setHubMessage("Paste a video URL first.");
      return;
    }

    setIsWorking(true);
    try {
      const response = await callTool("create_poom", { youtube_url: url });
      const data = (response?.structuredContent ?? {}) as any;
      const jobsFromPayload = asArray<PoomJob>(data?.active_jobs);
      const runsFromPayload = asArray<RunCard>(data?.runs);
      const job =
        (data?.latest_job as PoomJob | undefined) ||
        (data?.job as PoomJob | undefined) ||
        (jobsFromPayload.length ? jobsFromPayload[0] : undefined);

      if (runsFromPayload.length) {
        setHubRuns(runsFromPayload);
      }
      if (jobsFromPayload.length) {
        setHubJobs(jobsFromPayload);
      }
      if (typeof data?.hub_message === "string" && data.hub_message.trim()) {
        setHubMessage(data.hub_message);
      }

      if (!job?.job_id) {
        setHubMessage("POOM creation response was missing a job id.");
        return;
      }

      if (!jobsFromPayload.length) {
        setHubJobs((prev) => [job, ...prev.filter((row) => row.job_id !== job.job_id)].slice(0, 8));
      }
      if (!(typeof data?.hub_message === "string" && data.hub_message.trim())) {
        setHubMessage(`POOM queued: ${job.job_id}`);
      }
      stopPolling();
      pollTimerRef.current = window.setTimeout(() => {
        void pollJob(job.job_id);
      }, 1200);
    } catch (err) {
      setHubMessage(`Create failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setIsWorking(false);
    }
  }, [callTool, inputUrl, pollJob]);

  const jumpToChapter = (index: number) => {
    if (index < 0 || index >= chapters.length) return;
    const chapter = chapters[index];
    const startAt = Number(chapter.start_s || 0);
    const player = playerRef.current;
    if (player) {
      player.currentTime = startAt;
      const playPromise = player.play?.();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {});
      }
    }
    setPosition(startAt);
    setLastInteraction(`Jumped to: ${chapter.name}`);
    setMenuOpen(false);
  };

  const jumpRelative = (delta: number) => {
    if (!chapters.length) return;
    const current = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.max(0, Math.min(chapters.length - 1, current + delta));
    jumpToChapter(next);
  };

  const changeDisplayMode = useCallback(
    async (mode: "inline" | "fullscreen" | "pip") => {
      if (!isAvailable) {
        setLastInteraction("Display mode controls unavailable in this host.");
        return;
      }
      try {
        setModePending(mode);
        const result = await requestDisplayMode(mode);
        setLastInteraction(`Display mode: ${result.mode}`);
      } catch {
        setLastInteraction(`Unable to switch to ${mode}`);
      } finally {
        setModePending(null);
      }
    },
    [isAvailable, requestDisplayMode]
  );

  if (isPending) {
    return <div className="peazy-loading">Loading POOM hub...</div>;
  }

  return (
    <McpUseProvider>
      <AppsSDKUIProvider linkComponent={Link}>
        <div className="peazy-shell">
          {isHubMode ? (
            <div className="peazy-hub">
              <div className="peazy-hub-head">
                <h3>POOM Hub</h3>
                <button type="button" className="peazy-nav-btn" onClick={() => void refreshHub()} disabled={isWorking}>
                  Refresh
                </button>
              </div>

              <div className="peazy-hub-create">
                <input
                  className="peazy-url-input"
                  type="url"
                  placeholder="Paste YouTube URL to create a POOM"
                  value={inputUrl}
                  onChange={(event) => setInputUrl(event.target.value)}
                />
                <button type="button" className="peazy-nav-btn" onClick={() => void createPoom()} disabled={isWorking}>
                  Create POOM
                </button>
              </div>

              <div className="peazy-hub-message">{hubMessage}</div>

              <div className="peazy-hub-grid">
                <section className="peazy-panel">
                  <h4>Active Jobs</h4>
                  {hubJobs.length === 0 ? <p className="peazy-muted">No active jobs.</p> : null}
                  {hubJobs.map((job) => (
                    <div key={job.job_id} className="peazy-row">
                      <div>
                        <strong>{job.status.toUpperCase()}</strong> · {job.stage ?? ""} · {Math.floor(Number(job.progress_pct ?? 0))}%
                      </div>
                      <div className="peazy-muted">{job.job_id}</div>
                    </div>
                  ))}
                </section>

                <section className="peazy-panel">
                  <h4>POOM Runs</h4>
                  {hubRuns.length === 0 ? <p className="peazy-muted">No valid runs yet.</p> : null}
                  {hubRuns.map((run) => (
                    <div key={run.run_id} className="peazy-row peazy-run-row">
                      <div>
                        <div><strong>{formatRunTitle(run)}</strong></div>
                        <div className="peazy-muted">{run.run_id}</div>
                        <div className="peazy-muted">
                          {formatWhen(run.created_at)} · {run.segment_count ?? 0} segments · {(run.duration_sec ?? 0).toFixed(1)}s
                        </div>
                      </div>
                      <button type="button" className="peazy-nav-btn" onClick={() => void openRun(run.run_id)} disabled={isWorking}>
                        Open
                      </button>
                    </div>
                  ))}
                </section>
              </div>
            </div>
          ) : (
            <div className="peazy-video-wrap">
              <div className="peazy-overlay-actions">
                <button
                  className="peazy-mode-btn"
                  type="button"
                  onClick={() => setIsHubMode(true)}
                  aria-label="Return to POOM hub"
                >
                  Hub
                </button>
                {displayMode !== "inline" ? (
                  <button
                    className="peazy-mode-btn"
                    type="button"
                    onClick={() => void changeDisplayMode("inline")}
                    disabled={modePending !== null}
                    aria-label="Return to inline mode"
                  >
                    Inline
                  </button>
                ) : null}
                <button
                  className="peazy-mode-btn"
                  type="button"
                  onClick={() => void changeDisplayMode("fullscreen")}
                  disabled={modePending !== null}
                  aria-label="Expand to fullscreen"
                >
                  Expand
                </button>
                <button
                  className="peazy-mode-btn"
                  type="button"
                  onClick={() => void changeDisplayMode("pip")}
                  disabled={modePending !== null}
                  aria-label="Open picture-in-picture"
                >
                  PiP
                </button>
              </div>

              {chapters.length > 0 ? (
                <div className="peazy-active-pill">
                  {activeIndex >= 0 ? `Chapter ${activeIndex + 1}: ${chapters[activeIndex].name}` : "Chapter list ready"}
                </div>
              ) : null}

              <button
                className="peazy-gear"
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                title="Chapters"
                aria-label="Open chapters menu"
              >
                ⚙
              </button>

              {menuOpen ? (
                <div className="peazy-menu" ref={menuRef} role="menu" aria-label="Chapter jump menu">
                  <div className="peazy-menu-head">
                    <span>Chapters</span>
                    <span>{chapters.length}</span>
                  </div>
                  <div className="peazy-menu-list" role="radiogroup" aria-label="Chapter choices">
                    {chapters.map((chapter, index) => {
                      const selected = index === activeIndex;
                      return (
                        <button
                          key={`${chapter.segment_id}-${index}`}
                          type="button"
                          className={`peazy-chapter${selected ? " active" : ""}`}
                          role="radio"
                          aria-checked={selected}
                          onClick={() => jumpToChapter(index)}
                        >
                          <span className="peazy-radio" />
                          <span className="peazy-name">{index + 1}. {chapter.name}</span>
                          <span className="peazy-time">
                            {formatSeconds(chapter.start_s)} - {formatSeconds(chapter.end_s)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="peazy-menu-actions">
                    <button type="button" className="peazy-nav-btn" onClick={() => jumpRelative(-1)}>
                      Prev
                    </button>
                    <button type="button" className="peazy-nav-btn" onClick={() => jumpRelative(1)}>
                      Next
                    </button>
                  </div>
                </div>
              ) : null}

              {playerVideoUrl ? (
                <MediaPlayer
                  ref={playerRef}
                  className="peazy-player"
                  title={`Peazy Run ${playerRunId}`}
                  src={playerVideoUrl}
                  controls
                  playsInline
                >
                  <MediaProvider />
                  {playerTrackUrl ? (
                    <Track
                      kind="chapters"
                      src={playerTrackUrl}
                      lang="en"
                      label="Chapters"
                      default
                    />
                  ) : null}
                </MediaPlayer>
              ) : (
                <div className="peazy-loading">No playable master video was provided.</div>
              )}

              <div className="peazy-jump-controls">
                <button type="button" className="peazy-nav-btn" onClick={() => jumpRelative(-1)}>
                  Prev Chapter
                </button>
                <button type="button" className="peazy-nav-btn" onClick={() => jumpRelative(1)}>
                  Next Chapter
                </button>
              </div>

              {lastInteraction ? <div className="peazy-interaction">{lastInteraction}</div> : null}
            </div>
          )}
        </div>
      </AppsSDKUIProvider>
    </McpUseProvider>
  );
};

export default TutorialPlayer;
