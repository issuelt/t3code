import type { SubscriptionWidgetConfiguration } from "./subscriptionWidgetPreferences";

export interface AndroidSubscriptionUsageSnapshot {
  configuration: Pick<
    SubscriptionWidgetConfiguration,
    "density" | "theme" | "percentage" | "showBars" | "showResetTimes" | "showUpdatedAt"
  >;
  checkedAt: number;
  groups: Array<{
    id: string;
    name: string;
    detail: string;
    windows: Array<{
      id: string;
      label: string;
      remaining: number;
      reset: string;
      resetsAt: number | null;
      resetDisplay: SubscriptionWidgetConfiguration["resetDisplay"];
      expiresAt: number;
    }>;
    totalWindows: number;
  }>;
  emptyMessage: string;
}

export type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
