import "@telegram-apps/telegram-ui/dist/styles.css";
import "./styles.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";

import { init } from "@telegram-apps/sdk";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Initialize Telegram Mini Apps SDK.
// In a normal browser (outside Telegram), some environments may throw; we fail-open
// so the UI can still render an explanatory screen.
try {
  init();
} catch (e) {
  // Keep console log small but useful for debugging blank screens.
  console.warn("[GhostStream] Telegram SDK init failed (likely not in Telegram WebView).", e);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);


