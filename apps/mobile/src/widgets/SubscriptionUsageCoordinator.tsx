import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { Platform } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { withAndroidWidgetSnapshots } from "./androidSubscriptionUsageSnapshot";
import { resolveWidgetPreferences } from "./subscriptionWidgetPreferences";
import { mobilePreferencesAtom } from "../state/preferences";
import { createWidgetTheme } from "./widgetTheme";

// Isolate quota changes from the much busier thread/config presentation stream.
const snapshotAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsWithProvidersAtom);
  const snapshot = buildSubscriptionUsageSnapshot(
    presentations,
    Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
    Platform.OS === "android" ? Infinity : 6,
  );
  if (Platform.OS !== "android") return snapshot;
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? withAndroidWidgetSnapshots(
        { ...snapshot, androidWidgetUrl: Linking.createURL("settings/usage-widget") },
        presentations,
        resolveWidgetPreferences(preferences.value.subscriptionWidgets),
      )
    : null;
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export function SubscriptionUsageCoordinator() {
  const {
    themeMode,
    themeAppearance,
    themeVariablesByAppearance,
    isReady: appearanceReady,
  } = useAppearancePreferences();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const snapshot = useAtomValue(snapshotAtom);
  const androidAppearance = Platform.OS === "android" ? themeAppearance : null;
  useEffect(() => {
    if (!catalog.isReady || !appearanceReady || snapshot === null) return;
    void Promise.resolve()
      .then(() =>
        publishSubscriptionUsage({
          ...snapshot,
          theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
        }),
      )
      .catch((error: unknown) => {
        console.warn("Could not update subscription usage widget", error);
      });
  }, [
    catalog.isReady,
    appearanceReady,
    snapshot,
    themeMode,
    themeVariablesByAppearance,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Android stores resolved colors; System appearance changes must republish them.
    androidAppearance,
  ]);
  return null;
}
