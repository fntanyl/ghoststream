import { Button, Placeholder, Spinner } from "@telegram-apps/telegram-ui";
import { useCallback, useEffect, useRef, useState } from "react";
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

import { getFeed, getVideoUrl } from "../lib/api";
import type { FeedItem, VideoUrlResponse } from "../lib/types";
import { HttpError } from "../lib/http";
import { msUntilRefresh } from "../lib/urlRefresh";

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

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
  const [suggestedVideos, setSuggestedVideos] = useState<FeedItem[]>([]);
  const [suggestedCursor, setSuggestedCursor] = useState<{ cursorCreatedAt: string; cursorId: string } | null>(null);
  const [loadingSuggested, setLoadingSuggested] = useState(false);

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

  // Load suggested videos
  useEffect(() => {
    async function loadSuggested() {
      setLoadingSuggested(true);
      try {
        const res = await getFeed({ limit: 6 });
        if (res.ok) {
          // Filter out the current video
          const filtered = res.items.filter((item) => item.id !== videoId);
          setSuggestedVideos(filtered);
          setSuggestedCursor(res.nextCursor);
        }
      } catch {
        // Silently fail - suggested videos are not critical
      } finally {
        setLoadingSuggested(false);
      }
    }
    void loadSuggested();
  }, [videoId]);

  const loadMoreSuggested = useCallback(async () => {
    if (!suggestedCursor || loadingSuggested) return;
    setLoadingSuggested(true);
    try {
      const res = await getFeed({
        limit: 6,
        cursorCreatedAt: suggestedCursor.cursorCreatedAt,
        cursorId: suggestedCursor.cursorId,
      });
      if (res.ok) {
        const filtered = res.items.filter((item) => item.id !== videoId);
        setSuggestedVideos((prev) => [...prev, ...filtered]);
        setSuggestedCursor(res.nextCursor);
      }
    } catch {
      // Silently fail
    } finally {
      setLoadingSuggested(false);
    }
  }, [suggestedCursor, loadingSuggested, videoId]);

  const onSuggestedClick = useCallback(
    (id: string) => {
      if (haptics.impactOccurred.isAvailable()) haptics.impactOccurred("medium");
      nav(`/video/${id}`);
    },
    [haptics, nav],
  );

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
    <div className="gs-player-page">
      <div className="gs-video-container">
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
      </div>

      <div className="gs-video-meta">
        <h2 className="gs-video-title-large">{data.title}</h2>
      </div>

      <div className="gs-suggested-section">
        <h3 className="gs-suggested-header">More videos</h3>
        {loadingSuggested && suggestedVideos.length === 0 ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spinner size="m" />
          </div>
        ) : suggestedVideos.length > 0 ? (
          <>
            <div className="gs-suggested-list">
              {suggestedVideos.map((video) => (
                <div
                  key={video.id}
                  className="gs-suggested-card"
                  onClick={() => onSuggestedClick(video.id)}
                >
                  <div className="gs-suggested-thumb-container">
                    <img
                      alt=""
                      src={video.thumbUrl}
                      className="gs-suggested-thumb"
                    />
                    <span className="gs-video-duration">{formatDuration(video.durationSeconds)}</span>
                  </div>
                  <div className="gs-suggested-info">
                    <span className="gs-suggested-title">{video.title}</span>
                  </div>
                </div>
              ))}
            </div>
            {suggestedCursor && (
              <div style={{ marginTop: 16 }}>
                <Button
                  stretched
                  mode="outline"
                  loading={loadingSuggested}
                  onClick={() => {
                    if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
                    void loadMoreSuggested();
                  }}
                >
                  Load more videos
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="gs-suggested-empty">No other videos available</div>
        )}
      </div>
    </div>
  );
}


