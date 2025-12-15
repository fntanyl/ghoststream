import { AppRoot, List, Section } from "@telegram-apps/telegram-ui";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";

import { backButton, hapticFeedback } from "@telegram-apps/sdk";

import { FeedPage } from "./pages/FeedPage";
import { PlayerPage } from "./pages/PlayerPage";

const haptics = hapticFeedback;

function useTelegramBackButton() {
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    // In a normal browser, BackButton may be unavailable; fail-open.
    try {
      backButton.mount();
    } catch {
      // ignore
    }

    const isRoot = loc.pathname === "/";
    if (!isRoot) {
      backButton.show.ifAvailable();
    } else {
      backButton.hide.ifAvailable();
    }

    let off: (() => void) | null = null;
    try {
      off = backButton.onClick(() => {
        if (haptics.impactOccurred.isAvailable()) haptics.impactOccurred("light");
        nav(-1);
      });
    } catch {
      off = null;
    }

    return () => {
      if (off) off();
    };
  }, [loc.pathname, nav]);
}

export function App() {
  console.log("[GhostStream] 🏠 App component rendering...");
  
  try {
    useTelegramBackButton();
    console.log("[GhostStream] ✅ useTelegramBackButton OK");
  } catch (e) {
    console.error("[GhostStream] ❌ useTelegramBackButton error:", e);
  }

  console.log("[GhostStream] 🎨 Rendering AppRoot...");
  
  // Use Telegram UI primitives to ensure Telegram-native look.
  return (
    <AppRoot>
      <List>
        <Section>
          <Routes>
            <Route path="/" element={<FeedPage haptics={haptics} />} />
            <Route path="/video/:id" element={<PlayerPage haptics={haptics} />} />
          </Routes>
        </Section>
      </List>
    </AppRoot>
  );
}


