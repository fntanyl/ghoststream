import { apiFetchJson } from "./http";
import type { FeedResponse, VideoUrlResponse } from "./types";

export async function getFeed(params: {
  limit?: number;
  cursorCreatedAt?: string;
  cursorId?: string;
  tag?: string;
}): Promise<FeedResponse> {
  const body = {
    limit: params.limit,
    cursorCreatedAt: params.cursorCreatedAt,
    cursorId: params.cursorId,
    tag: params.tag,
  };
  return apiFetchJson<FeedResponse>("/get-feed", { method: "POST", body: JSON.stringify(body) });
}

export async function getVideoUrl(videoId: string): Promise<VideoUrlResponse> {
  return apiFetchJson<VideoUrlResponse>("/get-video-url", {
    method: "POST",
    body: JSON.stringify({ videoId }),
  });
}


