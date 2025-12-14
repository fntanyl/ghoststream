export type ApiError = {
  message: string;
};

export type FeedItem = {
  id: string;
  createdAt: string;
  title: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  thumbUrl: string;
  thumbUrlExpiresAt: string;
};

export type FeedResponse =
  | {
      ok: true;
      serverTime: string;
      urlTtlSeconds: number;
      refreshSkewSeconds: number;
      items: FeedItem[];
      nextCursor: { cursorCreatedAt: string; cursorId: string } | null;
    }
  | { ok: false; error: ApiError };

export type VideoUrlResponse =
  | {
      ok: true;
      serverTime: string;
      urlTtlSeconds: number;
      refreshSkewSeconds: number;
      video: {
        id: string;
        title: string;
        durationSeconds: number;
        width: number | null;
        height: number | null;
        videoUrl: string;
        videoUrlExpiresAt: string;
      };
    }
  | { ok: false; error: ApiError };


