import { Button, Cell, Placeholder, Spinner } from "@telegram-apps/telegram-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
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

type Props = {
  haptics: Haptics;
};

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function FeedPage({ haptics }: Props) {
  const nav = useNavigate();
  const [tag, setTag] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextCursor, setNextCursor] = useState<{ cursorCreatedAt: string; cursorId: string } | null>(
    null,
  );

  const normalizedTag = useMemo(() => tag.trim().toLowerCase(), [tag]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getFeed({
        limit: 20,
        ...(normalizedTag ? { tag: normalizedTag } : {}),
      });
      if (!res.ok) throw new Error(res.error.message);
      setItems(res.items);
      setNextCursor(res.nextCursor);
    } catch (e) {
      const msg =
        e instanceof HttpError ? e.message : e instanceof Error ? e.message : "Unknown error";
      setError(msg);
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [normalizedTag]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await getFeed({
        limit: 20,
        ...(normalizedTag ? { tag: normalizedTag } : {}),
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
  }, [loadingMore, nextCursor, normalizedTag]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const onOpen = useCallback(
    (id: string) => {
      if (haptics.impactOccurred.isAvailable()) haptics.impactOccurred("medium");
      nav(`/video/${id}`);
    },
    [haptics, nav],
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
              void loadFirstPage();
            }
          }}
        />
        <Button
          size="m"
          onClick={() => {
            if (haptics.selectionChanged.isAvailable()) haptics.selectionChanged();
            void loadFirstPage();
          }}
        >
          Filter
        </Button>
      </div>

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
          {items.map((it) => (
            <Cell
              key={it.id}
              onClick={() => onOpen(it.id)}
              before={
                <img
                  alt=""
                  src={it.thumbUrl}
                  style={{
                    width: 72,
                    height: 72,
                    objectFit: "cover",
                    borderRadius: 12,
                    background: "rgba(0,0,0,0.08)",
                  }}
                />
              }
              subtitle={
                <span className="gs-small">
                  {formatDuration(it.durationSeconds)} ·{" "}
                  {it.height ? `${it.height}p` : "MP4"} · {new Date(it.createdAt).toLocaleDateString()}
                </span>
              }
            >
              {it.title}
            </Cell>
          ))}

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


