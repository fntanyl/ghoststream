export type VideoRow = {
  id: string;
  created_at: string;
  title_enc: string;
  duration_seconds: number;
  width: number | null;
  height: number | null;
  r2_bucket: string;
  r2_video_key: string;
  r2_thumb_key: string;
  published: boolean;
};


