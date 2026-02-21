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
      resourceDomains: ["https://storage.googleapis.com", "https://*.googleapis.com"],
    },
  },
};

function formatSeconds(value: number) {
  const secs = Math.max(0, Math.floor(value || 0));
  const minutes = Math.floor(secs / 60);
  const rest = secs % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

const TutorialPlayer: React.FC = () => {
  const { props, isPending } = useWidget<TutorialPlayerProps>();
  const chapters = props?.chapters ?? [];
  const playerRef = useRef<any>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [position, setPosition] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      const player = playerRef.current;
      const current = Number(player?.currentTime ?? 0);
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
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [menuOpen]);

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
            <button
              className="peazy-gear"
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              title="Chapters"
              aria-label="Open chapter menu"
            >
              ⚙
            </button>

            {menuOpen ? (
              <div className="peazy-menu" ref={menuRef} role="menu" aria-label="Chapters menu">
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
                        onClick={() => {
                          const startAt = Number(chapter.start_s || 0);
                          const player = playerRef.current;
                          if (player) {
                            player.currentTime = startAt;
                            player.play?.().catch(() => {
                              // Autoplay can be blocked by browser policies; user can hit play manually.
                            });
                          }
                          setPosition(startAt);
                          setMenuOpen(false);
                        }}
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
              </div>
            ) : null}

            <MediaPlayer
              ref={playerRef}
              className="peazy-player"
              title={`Peazy Run ${props.run_id}`}
              src={props.master_video_url}
              controls
              playsInline
              muted
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
          </div>
        </div>
      </AppsSDKUIProvider>
    </McpUseProvider>
  );
};

export default TutorialPlayer;
