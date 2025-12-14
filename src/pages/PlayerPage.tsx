import { Button, Placeholder, Spinner } from "@telegram-apps/telegram-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

type Haptics = {
  impactOccurred: ((style: "light" | "medium" | "heavy" | "rigid" | "soft") => void) & {
    isAvailable: () => boolean;
  };
  notificationOccurred: ((type: "error" | "success" | "warning") => void) & {
    isAvailable: () => boolean;
  };
  selectionChanged: (() => void) & { isAvailable: () => boolean };
};

import { getVideoUrl } from "../lib/api";
import type { VideoUrlResponse } from "../lib/types";
import { HttpError } from "../lib/http";
import { msUntilRefresh } from "../lib/urlRefresh";

type Props = {
  haptics: Haptics;
};

type VideoState = Extract<VideoUrlResponse, { ok: true }>["video"];

export function PlayerPage({ haptics }: Props) {
  const nav = useNavigate();
  const { id } = useParams<{ id: string }>();
  const videoId = (id ?? "").trim();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<VideoState | null>(null);
  const [refreshSkewSeconds, setRefreshSkewSeconds] = useState<number>(10 * 60);

  const videoEl = useRef<HTMLVideoElement | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const expiresAt = useMemo(() => data?.videoUrlExpiresAt ?? null, [data]);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current != null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const fetchAndSet = useCallback(
    async (opts?: { keepPlaybackTime?: boolean; autoplay?: boolean }) => {
      if (!videoId) {
        setError("Missing video id");
        setLoading(false);
        return;
      }

      setError(null);
      try {
        const keepT = opts?.keepPlaybackTime ?? true;
        const autoplay = opts?.autoplay ?? false;
        const prevTime = keepT ? videoEl.current?.currentTime ?? 0 : 0;
        const wasPaused = videoEl.current?.paused ?? true;

        const res = await getVideoUrl(videoId);
        if (!res.ok) throw new Error(res.error.message);

        setData(res.video);
        setRefreshSkewSeconds(res.refreshSkewSeconds);

        // Update <video> src; attempt to preserve playback time if possible.
        const v = videoEl.current;
        if (v) {
          v.src = res.video.videoUrl;
          if (keepT) {
            try {
              v.currentTime = prevTime;
            } catch {
              // ignore (some WebViews block seeking before metadata load)
            }
          }
          if (autoplay || (!wasPaused && keepT)) {
            void v.play().catch(() => {
              // Autoplay may be blocked; user can tap play.
            });
          }
        }
      } catch (e) {
        const msg =
          e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Unknown error";
        setError(msg);
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [videoId],
  );

  const scheduleRefresh = useCallback(() => {
    clearRefreshTimer();
    if (!data) return;

    const delayMs = msUntilRefresh({
      expiresAtIso: data.videoUrlExpiresAt,
      refreshSkewSeconds,
    });

    refreshTimer.current = window.setTimeout(() => {
      // Refresh URL in background; keep current playback time.
      void fetchAndSet({ keepPlaybackTime: true, autoplay: true });
    }, delayMs);
  }, [clearRefreshTimer, data, fetchAndSet, refreshSkewSeconds]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    void fetchAndSet({ keepPlaybackTime: false, autoplay: true });
    return () => {
      clearRefreshTimer();
    };
  }, [clearRefreshTimer, fetchAndSet]);

  // Refresh scheduling when expiresAt changes
  useEffect(() => {
    scheduleRefresh();
  }, [expiresAt, scheduleRefresh]);

  // When returning from background: if we're near expiry, refresh immediately.
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState !== "visible") return;
      if (!data) return;
      const ms = msUntilRefresh({
        expiresAtIso: data.videoUrlExpiresAt,
        refreshSkewSeconds,
      });
      if (ms <= 1000) {
        void fetchAndSet({ keepPlaybackTime: true, autoplay: true });
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [data, fetchAndSet, refreshSkewSeconds]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spinner size="l" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="gs-page">
        <Placeholder
          header="Couldn’t open video"
          description={error ?? "Unknown error"}
          action={
            <div className="gs-row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
              <Button
                size="l"
                onClick={() => {
                  if (haptics.notificationOccurred.isAvailable())
                    haptics.notificationOccurred("warning");
                  setLoading(true);
                  void fetchAndSet({ keepPlaybackTime: false, autoplay: true });
                }}
              >
                Retry
              </Button>
              <Button
                size="l"
                mode="plain"
                onClick={() => {
                  if (haptics.impactOccurred.isAvailable()) haptics.impactOccurred("light");
                  nav(-1);
                }}
              >
                Back
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ height: "100%" }}>
      <video
        ref={(el) => {
          videoEl.current = el;
        }}
        className="gs-player"
        controls
        playsInline
        preload="metadata"
        src={data.videoUrl}
        onPlay={() => {
          if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
        }}
        onError={() => {
          // If playback fails (expired URL or network), force refresh.
          void fetchAndSet({ keepPlaybackTime: true, autoplay: true });
        }}
      />

      <div className="gs-page">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{data.title}</div>
        <div className="gs-small">
          URL expires at: {new Date(data.videoUrlExpiresAt).toLocaleString()}
        </div>

        <div style={{ marginTop: 12 }}>
          <Button
            stretched
            onClick={() => {
              if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
              void fetchAndSet({ keepPlaybackTime: true, autoplay: true });
            }}
          >
            Refresh link now
          </Button>
        </div>
      </div>
    </div>
  );
}


