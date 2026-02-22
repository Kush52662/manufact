import { AppsSDKUIProvider } from "@openai/apps-sdk-ui/components/AppsSDKUIProvider";
import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import { MediaPlayer, MediaProvider, Track } from "@vidstack/react";
import { DefaultVideoLayout, defaultLayoutIcons } from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import React, { useRef } from "react";
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

const TutorialPlayer: React.FC = () => {
  const { props, isPending } = useWidget<TutorialPlayerProps>();
  const playerRef = useRef<any>(null);

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
            <MediaPlayer
              ref={playerRef}
              className="peazy-player"
              title={`Peazy Run ${props.run_id}`}
              src={props.master_video_url}
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
              <DefaultVideoLayout icons={defaultLayoutIcons} />
            </MediaPlayer>
          </div>
        </div>
      </AppsSDKUIProvider>
    </McpUseProvider>
  );
};

export default TutorialPlayer;
