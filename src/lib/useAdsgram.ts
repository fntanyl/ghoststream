/**
 * useAdsgram - Custom React hook for Adsgram integration
 * Based on official documentation: https://docs.adsgram.ai/publisher/reward-interstitial-code-examples
 */

import { useCallback, useEffect, useRef } from "react";
import type { AdController, ShowPromiseResult } from "./adsgram.d";

interface UseAdsgramParams {
  /** Block ID from partner.adsgram.ai */
  blockId: string;
  /** Callback when ad is watched/closed successfully (interstitial format) */
  onComplete?: () => void;
  /** Callback when ad fails to load or errors occur */
  onError?: (result: ShowPromiseResult) => void;
}

/**
 * Hook to initialize and manage Adsgram ad controller
 * Returns a function to show the ad that returns a Promise
 */
export function useAdsgram({ blockId, onComplete, onError }: UseAdsgramParams) {
  const adControllerRef = useRef<AdController | undefined>(undefined);

  useEffect(() => {
    // Initialize Adsgram SDK if available
    adControllerRef.current = window.Adsgram?.init({ blockId });

    if (!adControllerRef.current) {
      console.warn("[GhostStream] ⚠️ Adsgram SDK not loaded");
    } else {
      console.log("[GhostStream] 📺 Adsgram initialized with blockId:", blockId);
    }

    // Cleanup on unmount
    return () => {
      adControllerRef.current?.destroy();
    };
  }, [blockId]);

  const showAd = useCallback(async (): Promise<boolean> => {
    if (!adControllerRef.current) {
      console.warn("[GhostStream] ⚠️ Adsgram not available, skipping ad");
      onError?.({
        error: true,
        done: false,
        state: "load",
        description: "Adsgram script not loaded",
      });
      return false;
    }

    try {
      console.log("[GhostStream] 📺 Showing ad...");
      const result = await adControllerRef.current.show();
      console.log("[GhostStream] ✅ Ad completed:", result.description);
      onComplete?.();
      return true;
    } catch (result) {
      // Ad failed or user got an error - this is expected behavior
      console.log("[GhostStream] ❌ Ad error/not available:", (result as ShowPromiseResult).description);
      onError?.(result as ShowPromiseResult);
      return false;
    }
  }, [onComplete, onError]);

  return showAd;
}
