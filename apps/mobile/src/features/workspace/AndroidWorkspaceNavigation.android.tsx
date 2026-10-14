import { requireNativeView } from "expo";
import { processColor, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";

import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useSelectAndroidWorkspaceTab } from "./useAndroidWorkspaceSelection";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

interface NativeNavigationProps extends ViewProps {
  readonly selectedTab: WorkspaceTab;
  readonly dark: boolean;
  readonly textScale: number;
  readonly containerColor: number;
  readonly selectedColor: number;
  readonly indicatorColor: number;
  readonly unselectedColor: number;
  readonly onTabSelected: (event: NativeSyntheticEvent<{ readonly tab: WorkspaceTab }>) => void;
}

const NativeNavigation = requireNativeView<NativeNavigationProps>("T3WorkspaceNavigation");

function nativeColor(value: string) {
  const color = processColor(value);
  return typeof color === "number" ? color : 0;
}

/** Compact Android bottom bar. Split view switches tabs from the sidebar header instead. */
export function AndroidWorkspaceNavigation() {
  const workspace = useWorkspaceTabs()!;
  const selectTab = useSelectAndroidWorkspaceTab();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale } = useAndroidControlSizing();
  const { containerColor, indicatorColor, selectedColor, unselectedColor } =
    androidWorkspaceNavigationColors(colors, false);
  if (keyboardVisible) return null;

  return (
    <View style={{ backgroundColor: containerColor, paddingBottom: insets.bottom }}>
      <NativeNavigation
        selectedTab={workspace.state.selectedTab}
        dark={themeAppearance === "dark"}
        textScale={scale}
        containerColor={nativeColor(containerColor)}
        selectedColor={nativeColor(selectedColor)}
        indicatorColor={nativeColor(indicatorColor)}
        unselectedColor={nativeColor(unselectedColor)}
        onTabSelected={(event) => selectTab(event.nativeEvent.tab)}
        style={{ height: 80 * Math.max(1, scale) }}
      />
    </View>
  );
}
