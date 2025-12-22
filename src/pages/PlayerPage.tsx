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
  const isFetching = useRef<boolean>(false); // Prevent concurrent fetches
  const lastErrorTime = useRef<number>(0); // Debounce video errors

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimer.current != null) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const fetchAndSet = useCallback(
    async (opts?: { keepPlaybackTime?: boolean; autoplay?: boolean }) => {
      // Prevent concurrent fetches (fixes infinite loop)
      if (isFetching.current) {
        console.log("[GhostStream] ⏳ Fetch already in progress, skipping...");
        return;
      }

      if (!videoId) {
        setError("Missing video id");
        setLoading(false);
        return;
      }

      isFetching.current = true;
      setError(null);
      console.log("[GhostStream] 🎥 Fetching video URL...");

      try {
        const keepT = opts?.keepPlaybackTime ?? true;
        const autoplay = opts?.autoplay ?? false;
        const prevTime = keepT ? videoEl.current?.currentTime ?? 0 : 0;
        const wasPaused = videoEl.current?.paused ?? true;

        const res = await getVideoUrl(videoId);
        if (!res.ok) throw new Error(res.error.message);

        console.log("[GhostStream] ✅ Video URL received");
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
        console.error("[GhostStream] ❌ Video URL error:", msg);
        setError(msg);
        setData(null);
      } finally {
        setLoading(false);
        isFetching.current = false;
      }
    },
    [videoId],
  );

  // Store fetchAndSet in a ref to avoid dependency issues in useEffect
  const fetchAndSetRef = useRef(fetchAndSet);
  fetchAndSetRef.current = fetchAndSet;

  const scheduleRefresh = useCallback(() => {
    clearRefreshTimer();
    if (!data) return;

    const delayMs = msUntilRefresh({
      expiresAtIso: data.videoUrlExpiresAt,
      refreshSkewSeconds,
    });

    console.log("[GhostStream] ⏰ Scheduling URL refresh in", Math.round(delayMs / 1000), "seconds");

    refreshTimer.current = window.setTimeout(() => {
      // Refresh URL in background; keep current playback time.
      void fetchAndSetRef.current({ keepPlaybackTime: true, autoplay: true });
    }, delayMs);
  }, [clearRefreshTimer, data, refreshSkewSeconds]);

  // Initial load - runs ONCE on mount (videoId is stable)
  useEffect(() => {
    console.log("[GhostStream] 🚀 PlayerPage mounted, loading video...");
    setLoading(true);
    void fetchAndSetRef.current({ keepPlaybackTime: false, autoplay: true });
    return () => {
      clearRefreshTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]); // Only re-run if videoId changes

  // Refresh scheduling when data changes
  useEffect(() => {
    if (data) {
      scheduleRefresh();
    }
  }, [data, scheduleRefresh]);

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
        void fetchAndSetRef.current({ keepPlaybackTime: true, autoplay: true });
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [data, refreshSkewSeconds]);

  // Debounced video error handler
  const handleVideoError = useCallback(() => {
    const now = Date.now();
    // Prevent rapid-fire error handling (min 5 seconds between retries)
    if (now - lastErrorTime.current < 5000) {
      console.log("[GhostStream] ⏳ Video error debounced");
      return;
    }
    lastErrorTime.current = now;
    console.log("[GhostStream] 🔄 Video error, refreshing URL...");
    void fetchAndSetRef.current({ keepPlaybackTime: true, autoplay: true });
  }, []);

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
        onError={handleVideoError}
      />

      <div className="gs-page">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{data.title}</div>
      </div>
    </div>
  );
}


