/**
 * Ad Frequency Manager for GhostStream
 * 
 * Implements the "1 ad per 3 video plays" rule to comply with
 * Adsgram UX policy and avoid annoying users.
 * 
 * Business Logic:
 * - Track video click count globally
 * - Show ad only on every 3rd video click (when count % 3 === 0)
 * - Counter persists in sessionStorage for tab session
 */

const STORAGE_KEY = "gs_video_click_count";

/**
 * Get current video click count from sessionStorage
 */
function getClickCount(): number {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? parseInt(stored, 10) : 0;
  } catch {
    // sessionStorage may be unavailable in some contexts
    return 0;
  }
}

/**
 * Save video click count to sessionStorage
 */
function setClickCount(count: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(count));
  } catch {
    // Silently fail if sessionStorage unavailable
  }
}

/**
 * Increment video click count and determine if ad should be shown
 * 
 * @returns true if ad should be shown (every 3rd click), false otherwise
 */
export function shouldShowAd(): boolean {
  const currentCount = getClickCount();
  const newCount = currentCount + 1;
  setClickCount(newCount);

  const shouldShow = newCount % 3 === 0;
  
  console.log(
    `[GhostStream] 📊 Video click #${newCount} - ${shouldShow ? "Show ad" : "Skip ad"}`
  );
  
  return shouldShow;
}

/**
 * Reset the click counter (for testing or special cases)
 */
export function resetClickCount(): void {
  setClickCount(0);
  console.log("[GhostStream] 📊 Video click counter reset");
}

/**
 * Get current click count (for debugging/display)
 */
export function getCurrentClickCount(): number {
  return getClickCount();
}
