import { Button, Placeholder, Spinner } from "@telegram-apps/telegram-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

type Haptics = {
  impactOccurred: ((style: "light" | "medium" | "heavy" | "rigid" | "soft") => void) & {
    isAvailable: () => boolean;
  };
  notificationOccurred: ((type: "error" | "success" | "warning") => void) & {
    isAvailable: () => boolean;
  };
  selectionChanged: (() => void) & { isAvailable: () => boolean };
};

import { getFeed } from "../lib/api";
import type { FeedItem } from "../lib/types";
import { HttpError } from "../lib/http";
import { useAdsgram } from "../lib/useAdsgram";
import { shouldShowAd } from "../lib/adManager";

type Props = {
  haptics: Haptics;
};

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Adsgram Block ID - Replace with your actual block ID from partner.adsgram.ai
const ADSGRAM_BLOCK_ID = "int-19609";

export function FeedPage({ haptics }: Props) {
  console.log("[GhostStream] 🎬 FeedPage rendering...");
  const nav = useNavigate();
  const [tag, setTag] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<{ cursorCreatedAt: string; cursorId: string } | null>(
    null,
  );
  
  // State for pending video navigation after ad
  const [pendingVideoId, setPendingVideoId] = useState<string | null>(null);

  // Initialize Adsgram with interstitial ad format
  const showAd = useAdsgram({
    blockId: ADSGRAM_BLOCK_ID,
    onComplete: () => {
      console.log("[GhostStream] 📺 Ad completed successfully");
    },
    onError: (result) => {
      // Log error but don't block user - video will play anyway
      console.log("[GhostStream] 📺 Ad error/unavailable:", result.description);
    },
  });

  const normalizedTag = useMemo(() => tag.trim().toLowerCase(), [tag]);
  const [debouncedTag, setDebouncedTag] = useState(normalizedTag);
  const isFirstMount = useRef(true);

  // Debounce tag changes - wait 500ms after user stops typing
  useEffect(() => {
    // Skip debounce on first mount to load feed immediately
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedTag(normalizedTag);
    }, 500);
    return () => clearTimeout(timer);
  }, [normalizedTag]);

  const loadFirstPage = useCallback(async () => {
    console.log("[GhostStream] 📡 Loading feed...");
    setLoading(true);
    setError(null);
    try {
      const res = await getFeed({
        limit: 20,
        ...(debouncedTag ? { tag: debouncedTag } : {}),
      });
      console.log("[GhostStream] 📦 Feed response:", res);
      if (!res.ok) throw new Error(res.error.message);
      setItems(res.items);
      setNextCursor(res.nextCursor);
      console.log("[GhostStream] ✅ Feed loaded, items:", res.items.length);
    } catch (e) {
      const msg =
        e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Unknown error";
      console.error("[GhostStream] ❌ Feed error:", msg, e);
      setError(msg);
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [debouncedTag]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await getFeed({
        limit: 20,
        ...(debouncedTag ? { tag: debouncedTag } : {}),
        cursorCreatedAt: nextCursor.cursorCreatedAt,
        cursorId: nextCursor.cursorId,
      });
      if (!res.ok) throw new Error(res.error.message);
      setItems((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      const msg =
        e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, debouncedTag]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  /**
   * Navigate to video player after ad logic is handled
   */
  const navigateToVideo = useCallback(
    (id: string) => {
      nav(`/video/${id}`);
    },
    [nav],
  );

  /**
   * Handle video click with ad frequency logic
   * 
   * Business Logic:
   * 1. Increment click counter
   * 2. Every 3rd click: Show interstitial ad first, then navigate
   * 3. Other clicks: Navigate immediately
   * 4. If ad fails: Navigate anyway (never block user)
   */
  const onOpen = useCallback(
    async (id: string) => {
      if (haptics.impactOccurred.isAvailable()) haptics.impactOccurred("medium");

      // Check if we should show an ad (every 3rd video click)
      if (shouldShowAd()) {
        console.log("[GhostStream] 📺 Showing interstitial ad before video...");
        setPendingVideoId(id);
        
        try {
          // Show ad - whether it succeeds or fails, we navigate after
          await showAd();
        } catch {
          // Ad failed - continue to video anyway
          console.log("[GhostStream] 📺 Ad failed, continuing to video");
        } finally {
          // Always navigate to video after ad attempt
          setPendingVideoId(null);
          navigateToVideo(id);
        }
      } else {
        // No ad needed - navigate immediately
        navigateToVideo(id);
      }
    },
    [haptics, showAd, navigateToVideo],
  );

  return (
    <div className="gs-page">
      <div className="gs-row" style={{ marginBottom: 12 }}>
        <input
          className="gs-input"
          inputMode="search"
          placeholder="Search by tag (exact match)…"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
              // Immediately update debounced tag and trigger search
              setDebouncedTag(normalizedTag);
            }
          }}
        />
        <Button
          size="m"
          onClick={() => {
            if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
            // Immediately update debounced tag and trigger search
            setDebouncedTag(normalizedTag);
          }}
        >
          Filter
        </Button>
      </div>

      {/* Loading overlay while ad is playing */}
      {pendingVideoId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <Spinner size="l" />
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
          <Spinner size="l" />
        </div>
      ) : error ? (
        <Placeholder
          header="Couldn’t load your feed"
          description={error}
          action={
            <Button
              size="l"
              stretched
              onClick={() => {
                if (haptics.notificationOccurred.isAvailable())
                  haptics.notificationOccurred("warning");
                void loadFirstPage();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <Placeholder
          header="No videos"
          description={normalizedTag ? `No results for tag "${normalizedTag}".` : "Feed is empty."}
        />
      ) : (
        <>
          <div className="gs-feed">
            {items.map((it) => (
              <div
                key={it.id}
                className="gs-video-card"
                onClick={() => onOpen(it.id)}
              >
                <div className="gs-video-thumb-container">
                  <img
                    alt=""
                    src={it.thumbUrl}
                    className="gs-video-thumb"
                  />
                  <span className="gs-video-duration">{formatDuration(it.durationSeconds)}</span>
                </div>
                <div className="gs-video-info">
                  <div className="gs-video-title">{it.title}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ paddingTop: 12 }}>
            {nextCursor ? (
              <Button
                stretched
                loading={loadingMore}
                onClick={() => {
                  if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
                  void loadMore();
                }}
              >
                Load more
              </Button>
            ) : (
              <div className="gs-small" style={{ textAlign: "center", padding: 8 }}>
                End of feed
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}


