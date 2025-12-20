/**
 * Adsgram SDK TypeScript Types
 * Based on official documentation: https://docs.adsgram.ai/publisher/typescript
 */

export interface ShowPromiseResult {
  /** true if user watched ad till the end or closed it (interstitial), otherwise false */
  done: boolean;
  /** Event description */
  description: string;
  /** Banner state at time of event */
  state: "load" | "render" | "playing" | "destroy";
  /** true if event was emitted due to error, otherwise false */
  error: boolean;
}

type BannerType = "RewardedVideo" | "FullscreenMedia";

export interface AdsgramInitParams {
  /** Block ID from partner.adsgram.ai */
  blockId: string;
  /** Enable debug mode */
  debug?: boolean;
  /** Banner type for debug mode */
  debugBannerType?: BannerType;
}

type EventType =
  | "onReward"
  | "onComplete"
  | "onStart"
  | "onSkip"
  | "onBannerNotFound"
  | "onNonStopShow"
  | "onTooLongSession"
  | "onError";

type HandlerType = () => void;

export interface AdController {
  /** Show the ad banner. Returns a Promise that resolves when ad completes or rejects on error */
  show(): Promise<ShowPromiseResult>;
  /** Add event listener for ad lifecycle events */
  addEventListener(event: EventType, handler: HandlerType): void;
  /** Remove event listener */
  removeEventListener(event: EventType, handler: HandlerType): void;
  /** Destroy the ad controller instance */
  destroy(): void;
}

declare global {
  interface Window {
    Adsgram?: {
      init(params: AdsgramInitParams): AdController;
    };
  }
}
