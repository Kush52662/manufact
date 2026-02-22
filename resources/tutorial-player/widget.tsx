import { AppsSDKUIProvider } from "@openai/apps-sdk-ui/components/AppsSDKUIProvider";
import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import { MediaPlayer, MediaProvider, Track } from "@vidstack/react";
import "@vidstack/react/player/styles/default/theme.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import "../styles.css";
import "./widget.css";
import type { TutorialPlayerProps } from "./types";
import { propSchema } from "./types";

export const widgetMetadata: WidgetMetadata = {
  description: "Single-surface tutorial player with chapter menu and radio selection.",
  props: propSchema,
  exposeAsTool: false,
  metadata: {
    prefersBorder: false,
    invoking: "Loading tutorial player...",
    invoked: "Tutorial player ready",
    csp: {
      connectDomains: [
        "https://fixed-control-van-vocabulary.trycloudflare.com",
        "https://storage.googleapis.com",
        "https://*.googleapis.com",
      ],
      resourceDomains: [
        "https://storage.googleapis.com",
        "https://*.googleapis.com",
        "https://fixed-control-van-vocabulary.trycloudflare.com",
      ],
    },
  },
};

function formatSeconds(value: number): string {
  const total = Math.max(0, Math.floor(value || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const TutorialPlayer: React.FC = () => {
  const { props, isPending } = useWidget<TutorialPlayerProps>();
  const chapters = props?.chapters ?? [];
  const playerRef = useRef<any>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [lastInteraction, setLastInteraction] = useState("");

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
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!lastInteraction) {
      return;
    }
    const timer = setTimeout(() => setLastInteraction(""), 2200);
    return () => clearTimeout(timer);
  }, [lastInteraction]);

  const activeIndex = useMemo(() => {
    if (!chapters.length) {
      return -1;
    }
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

  const jumpToChapter = (index: number) => {
    if (index < 0 || index >= chapters.length) {
      return;
    }
    const chapter = chapters[index];
    const startAt = Number(chapter.start_s || 0);
    const player = playerRef.current;
    if (player) {
      player.currentTime = startAt;
      const playPromise = player.play?.();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          // User gesture may be required before playback starts in some clients.
        });
      }
    }
    setPosition(startAt);
    setLastInteraction(`Jumped to: ${chapter.name}`);
    setMenuOpen(false);
  };

  const jumpRelative = (delta: number) => {
    if (!chapters.length) {
      return;
    }
    const current = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.max(0, Math.min(chapters.length - 1, current + delta));
    jumpToChapter(next);
  };

  if (isPending) {
    return <div className="peazy-loading">Loading tutorial player...</div>;
  }

  if (!props?.master_video_url) {
    return <div className="peazy-loading">No playable master video was provided.</div>;
  }

  return (
    <McpUseProvider>
      <AppsSDKUIProvider linkComponent={Link}>
        <div className="peazy-shell">
          <div className="peazy-video-wrap">
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

            <MediaPlayer
              ref={playerRef}
              className="peazy-player"
              title={`Peazy Run ${props.run_id}`}
              src={props.master_video_url}
              controls
              playsInline
              crossOrigin=""
            >
              <MediaProvider />
              {props.chapters_track_url ? (
                <Track
                  kind="chapters"
                  src={props.chapters_track_url}
                  lang="en"
                  label="Chapters"
                  default
                />
              ) : null}
            </MediaPlayer>

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
        </div>
      </AppsSDKUIProvider>
    </McpUseProvider>
  );
};

export default TutorialPlayer;
