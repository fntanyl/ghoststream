// Conservative CORS for a Telegram Mini App:
// - Telegram WebView origins vary; for API endpoints that only return signed URLs
//   after Telegram initData verification, it's acceptable to allow all origins.
// - If you want stricter CORS, restrict `Access-Control-Allow-Origin` to your
//   known web app origins.

export const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-init-data",
  "Access-Control-Max-Age": "86400",
};


