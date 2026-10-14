import {
  flattenThemeColor,
  themeColorWithAlpha,
  themeColorWithContrast,
  type MobileThemeVariables,
} from "../../lib/mobileTheme";

/**
 * Tab selection colors for the compact bottom bar and the split-view sidebar
 * switch, which sits directly on the header surface.
 */
export function androidWorkspaceNavigationColors(colors: MobileThemeVariables, onHeader: boolean) {
  const header = flattenThemeColor(colors["--color-header"], colors["--color-screen"]);
  const containerColor = onHeader
    ? header
    : flattenThemeColor(themeColorWithAlpha(colors["--color-header-foreground"], 0.05), header);
  const indicatorColor = themeColorWithContrast(
    flattenThemeColor(colors["--color-secondary"], containerColor),
    containerColor,
    1.5,
  );
  return {
    containerColor,
    indicatorColor,
    selectedColor: themeColorWithContrast(
      flattenThemeColor(colors["--color-secondary-foreground"], indicatorColor),
      [indicatorColor, containerColor],
    ),
    unselectedColor: flattenThemeColor(colors["--color-header-foreground"], containerColor),
  };
}
