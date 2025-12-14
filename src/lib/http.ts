import { getRawInitData } from "./telegram";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export async function apiFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = import.meta.env.VITE_FUNCTIONS_BASE_URL;
  if (!base) {
    throw new Error(
      "⚠️ VITE_FUNCTIONS_BASE_URL not configured.\n\n" +
        "Create a .env file in the project root with:\n" +
        "VITE_FUNCTIONS_BASE_URL=https://<your-project>.supabase.co/functions/v1",
    );
  }

  const initData = getRawInitData();
  if (!initData) {
    throw new Error(
      "⚠️ Telegram initData missing.\n\n" +
        "This app must be opened inside Telegram as a Mini App.\n" +
        "If developing, set VITE_DEV_INIT_DATA in .env (not recommended for prod).",
    );
  }

  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("x-telegram-init-data", initData);

  const res = await fetch(joinUrl(base, path), {
    ...init,
    headers,
    cache: "no-store",
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const message =
      (typeof json === "object" && json && "error" in json &&
        typeof (json as { error?: { message?: unknown } }).error?.message === "string" &&
        (json as { error: { message: string } }).error.message) ||
      `HTTP ${res.status}`;
    throw new HttpError(res.status, message);
  }

  return json as T;
}


