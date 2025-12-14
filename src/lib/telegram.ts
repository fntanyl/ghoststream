import { initData } from "@telegram-apps/sdk";

type TelegramWebApp = {
  initData?: string;
};

type TelegramWindow = Window & {
  Telegram?: { WebApp?: TelegramWebApp };
};

/**
 * Returns raw initData in the **query-string** format required by the backend verifier.
 *
 * Security note:
 * - initData is NOT a secret; it is signed by Telegram and verified server-side with the bot token.
 * - We still treat it carefully and only send it to our own backend.
 */
export function getRawInitData(): string | null {
  const sdkRaw = initData.raw();
  if (sdkRaw && sdkRaw.trim()) return sdkRaw.trim();

  const w = window as TelegramWindow;
  const webAppRaw = w.Telegram?.WebApp?.initData;
  if (webAppRaw && webAppRaw.trim()) return webAppRaw.trim();

  const dev = import.meta.env.VITE_DEV_INIT_DATA;
  if (dev && dev.trim()) return dev.trim();

  return null;
}


