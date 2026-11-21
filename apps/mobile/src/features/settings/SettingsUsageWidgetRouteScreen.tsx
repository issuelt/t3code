import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";
import { Alert, AppState, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Menu as ControlPillMenu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildAndroidSubscriptionUsageSnapshot,
  collectSubscriptionWidgetQuotas,
  subscriptionWidgetAccountId,
  subscriptionWidgetAccountName,
} from "../../widgets/androidSubscriptionUsageSnapshot";
import {
  DEFAULT_WIDGET_CONFIGURATION,
  resolveWidgetPreferences,
  toggleWidgetSelection,
  type SubscriptionWidgetConfiguration,
} from "../../widgets/subscriptionWidgetPreferences";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { UsageWidgetPreview } from "./components/UsageWidgetPreview";

const PERIODS = [
  { id: "all", title: msg("All quotas") },
  { id: "session", title: msg("Session") },
  { id: "weekly", title: msg("Weekly") },
  { id: "monthly", title: msg("Monthly") },
  { id: "tightest", title: msg("Lowest remaining") },
] as const;

const RESET_DISPLAYS = [
  { id: "reset", title: msg("Next reset only") },
  { id: "both", title: msg("Reset + time left") },
  { id: "remaining", title: msg("Time left only") },
] as const;

function WidgetMenu<Value extends string>(props: {
  label: string;
  subtitle?: string;
  value: Value;
  options: readonly { id: Value; title: string }[];
  disabled: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <ListRowLayout
      icon="slider.horizontal.3"
      label={props.label}
      description={props.subtitle}
      disabled={props.disabled}
      accessory={
        <ControlPillMenu
          title={props.label}
          actions={props.options.map((option) => ({
            ...option,
            state: option.id === props.value ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            if (props.disabled) return;
            const option = props.options.find((option) => option.id === nativeEvent.event);
            if (option) props.onChange(option.id);
          }}
        >
          <Pressable
            disabled={props.disabled}
            accessibilityRole="button"
            accessibilityLabel={props.subtitle ? `${props.subtitle} · ${props.label}` : props.label}
            className="rounded-full bg-subtle px-3 py-2"
          >
            <Text className="text-sm text-foreground">
              {props.options.find((option) => option.id === props.value)?.title}
            </Text>
          </Pressable>
        </ControlPillMenu>
      }
    />
  );
}

export function SettingsUsageWidgetRouteScreen() {
  const gt = useGT();
  const messages = useMessages();
  const periods = PERIODS.map((period) => ({ ...period, title: messages(period.title) }));
  const resetDisplays = RESET_DISPLAYS.map((display) => ({
    ...display,
    title: messages(display.title),
  }));
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<{ Widget: { widgetId?: string } | undefined }, "Widget">>();
  const focused = useIsFocused();
  const result = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const ready = AsyncResult.isSuccess(result) && !result.waiting;
  const preferences = resolveWidgetPreferences(
    AsyncResult.isSuccess(result) ? result.value.subscriptionWidgets : undefined,
  );
  const native = requireOptionalNativeModule<{
    getWidgetIds: () => number[];
    pinWidget: () => boolean;
  }>("T3WidgetExpiry");
  const [widgetIds, setWidgetIds] = useState(() => native?.getWidgetIds() ?? []);
  const [selection, setSelection] = useState(() => ({
    params: route.params,
    target: route.params?.widgetId ?? "defaults",
  }));
  if (selection.params !== route.params) {
    setSelection({ params: route.params, target: route.params?.widgetId ?? "defaults" });
  }
  const { target } = selection;
  const setTarget = (target: string) => setSelection({ params: route.params, target });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- widgets added from the home screen show up only after the app returns to the foreground
  useEffect(() => {
    if (!focused) return;
    const update = () => setWidgetIds(native?.getWidgetIds() ?? []);
    update();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") update();
    });
    return () => listener.remove();
  }, [focused, native]);
  const isDefault = target === "defaults";
  const exists = isDefault || widgetIds.includes(Number(target));
  const configuration = preferences.widgets[target] ?? preferences.defaults;
  const disabled = !ready || !exists;
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => account.driver === "codex" || account.driver === "claudeAgent",
  );
  const preview = buildAndroidSubscriptionUsageSnapshot(presentations, configuration);
  const quotas = collectSubscriptionWidgetQuotas(presentations, configuration);
  const availableAccounts = accounts.map(subscriptionWidgetAccountId);
  const availableEnvironments = [...presentations.keys()];
  const save = (patch: Partial<SubscriptionWidgetConfiguration> | null) => {
    void savePreferences({
      transform: (current) => {
        const latest = resolveWidgetPreferences(current.subscriptionWidgets);
        if (isDefault)
          return {
            subscriptionWidgets: {
              ...latest,
              defaults:
                patch === null ? DEFAULT_WIDGET_CONFIGURATION : { ...latest.defaults, ...patch },
            },
          };
        const widgets = { ...latest.widgets };
        if (patch === null) delete widgets[target];
        else widgets[target] = { ...(widgets[target] ?? latest.defaults), ...patch };
        return { subscriptionWidgets: { ...latest, widgets } };
      },
    }).catch(() => Alert.alert(gt("Could not save widget settings"), gt("Please try again.")));
  };
  return (
    <SettingsScreen title={gt("Usage widget")}>
      <UsageWidgetPreview
        snapshot={preview}
        target={
          isDefault
            ? "Default settings"
            : exists
              ? `Home screen widget ${widgetIds.indexOf(Number(target)) + 1}`
              : "Removed widget"
        }
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          <T>
            Choose what appears on your home screen. Each widget can have its own settings. Changes
            apply immediately.
          </T>
        </Text>
        <SettingsSection title={gt("Widget")}>
          <WidgetMenu
            label={gt("Configure")}
            value={target}
            options={[
              { id: "defaults", title: gt("Default settings") },
              ...widgetIds.map((id, index) => ({
                id: String(id),
                title: gt("Home screen widget {number}", { number: index + 1 }),
              })),
            ]}
            disabled={!ready}
            onChange={setTarget}
          />
          {!isDefault ? (
            <SettingsSwitchRow
              icon="arrow.clockwise"
              label={gt("Use default settings")}
              value={!preferences.widgets[target]}
              disabled={disabled}
              onValueChange={(enabled) => save(enabled ? null : configuration)}
            />
          ) : null}
          <SettingsActionRow
            icon="plus"
            label={gt("Add to home screen")}
            disabled={!native || !ready}
            onPress={() => {
              if (!native?.pinWidget())
                Alert.alert(
                  gt("Add the widget from your launcher"),
                  gt("Open your home screen's widget gallery and choose Subscription usage."),
                );
            }}
          />
          <SettingsActionRow
            icon="chart.bar.xaxis"
            label={gt("Open usage limits")}
            onPress={() => navigation.navigate("SettingsUsage")}
          />
        </SettingsSection>
        {!exists ? (
          <Text className="text-sm text-danger-foreground">
            <T>This widget was removed. Choose Default settings or another home screen widget.</T>
          </Text>
        ) : null}
        <SettingsSection title={gt("Providers")}>
          {(
            [
              { id: "codex", label: "Codex" },
              { id: "claudeAgent", label: "Claude" },
            ] as const
          ).map((provider) => (
            <SettingsSwitchRow
              key={provider.id}
              icon="person.crop.circle"
              label={provider.label}
              disabled={disabled}
              value={configuration.providers.includes(provider.id)}
              onValueChange={(enabled) =>
                save({
                  providers: enabled
                    ? [...configuration.providers, provider.id]
                    : configuration.providers.filter((id) => id !== provider.id),
                })
              }
            />
          ))}
        </SettingsSection>
        <SettingsSection title={gt("Accounts")}>
          <SettingsSwitchRow
            icon="person.2"
            label={gt("All accounts")}
            subtitle={gt("Include new accounts automatically.")}
            disabled={disabled}
            value={configuration.accountIds === null}
            onValueChange={(enabled) => save({ accountIds: enabled ? null : availableAccounts })}
          />
          {accounts.map((account) => (
            <SettingsSwitchRow
              key={account.key}
              icon="person.crop.circle"
              label={subscriptionWidgetAccountName(account)}
              subtitle={`${account.driver === "codex" ? "Codex" : "Claude"} · ${account.environments.map((e) => e.label).join(", ") || account.sourceLabel || "Usage source"}`}
              disabled={disabled}
              value={
                configuration.accountIds === null ||
                configuration.accountIds.includes(subscriptionWidgetAccountId(account))
              }
              onValueChange={() =>
                save({
                  accountIds: toggleWidgetSelection(
                    configuration.accountIds,
                    availableAccounts,
                    subscriptionWidgetAccountId(account),
                  ),
                })
              }
            />
          ))}
          {accounts.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              <T>Connect an environment and refresh Usage → Limits to choose accounts.</T>
            </Text>
          ) : null}
          {configuration.accountIds?.some((id) => !availableAccounts.includes(id)) ? (
            <Text className="p-4 text-sm text-foreground-muted">
              <T>
                Some selected accounts are unavailable. They will return when their environment
                reconnects and reports limits.
              </T>
            </Text>
          ) : null}
        </SettingsSection>
        <SettingsSection title={gt("Environments")}>
          <SettingsSwitchRow
            icon="server.rack"
            label={gt("All environments")}
            subtitle={gt("Include new environments automatically.")}
            disabled={disabled}
            value={configuration.environmentIds === null}
            onValueChange={(enabled) =>
              save({ environmentIds: enabled ? null : availableEnvironments })
            }
          />
          {[...presentations].map(([id, presentation]) => (
            <SettingsSwitchRow
              key={id}
              icon="server.rack"
              label={presentation.entry.target.label}
              disabled={disabled}
              value={
                configuration.environmentIds === null || configuration.environmentIds.includes(id)
              }
              onValueChange={() =>
                save({
                  environmentIds: toggleWidgetSelection(
                    configuration.environmentIds,
                    availableEnvironments,
                    id,
                  ),
                })
              }
            />
          ))}
        </SettingsSection>
        <SettingsSection title={gt("Quotas")}>
          <WidgetMenu
            label={gt("Account view")}
            value={configuration.grouping}
            options={[
              { id: "accounts", title: gt("Separate accounts") },
              { id: "pooled", title: gt("Combined by provider") },
            ]}
            disabled={disabled}
            onChange={(grouping) => save({ grouping })}
          />
          <WidgetMenu
            label={gt("Codex quotas")}
            value={configuration.codexPeriod}
            options={periods}
            disabled={disabled}
            onChange={(codexPeriod) => save({ codexPeriod })}
          />
          <WidgetMenu
            label={gt("Claude quotas")}
            value={configuration.claudePeriod}
            options={periods}
            disabled={disabled}
            onChange={(claudePeriod) => save({ claudePeriod })}
          />
          <WidgetMenu
            label={gt("Quotas per account")}
            value={String(configuration.windowsPerAccount)}
            options={[
              { id: "0", title: gt("All · scroll to see more") },
              { id: "1", title: gt("1") },
              { id: "2", title: gt("2") },
              { id: "3", title: gt("3") },
            ]}
            disabled={disabled}
            onChange={(value) =>
              save({
                windowsPerAccount: value === "1" ? 1 : value === "2" ? 2 : value === "3" ? 3 : 0,
              })
            }
          />
          <WidgetMenu
            label={gt("Sort accounts")}
            value={configuration.sort}
            options={[
              { id: "provider", title: gt("Provider") },
              { id: "name", title: gt("Name") },
              { id: "remaining", title: gt("Lowest remaining") },
              { id: "reset", title: gt("Next reset") },
            ]}
            disabled={disabled}
            onChange={(sort) => save({ sort })}
          />
        </SettingsSection>
        <SettingsSection title={gt("Appearance")}>
          <WidgetMenu
            label={gt("Density")}
            value={configuration.density}
            options={[
              { id: "comfortable", title: gt("Comfortable") },
              { id: "compact", title: gt("Compact") },
            ]}
            disabled={disabled}
            onChange={(density) => save({ density })}
          />
          <WidgetMenu
            label={gt("Percentage")}
            value={configuration.percentage}
            options={[
              { id: "remaining", title: gt("Remaining") },
              { id: "used", title: gt("Used") },
            ]}
            disabled={disabled}
            onChange={(percentage) => save({ percentage })}
          />
          <WidgetMenu
            label={gt("Theme")}
            value={configuration.theme}
            options={[
              { id: "system", title: gt("System") },
              { id: "light", title: gt("Light") },
              { id: "dark", title: gt("Dark") },
            ]}
            disabled={disabled}
            onChange={(theme) => save({ theme })}
          />
          <SettingsSwitchRow
            icon="chart.bar.xaxis"
            label={gt("Progress bars")}
            disabled={disabled}
            value={configuration.showBars}
            onValueChange={(showBars) => save({ showBars })}
          />
          <WidgetMenu
            label={gt("Environment names")}
            subtitle={gt("Auto hides names with one connected environment.")}
            disabled={disabled}
            value={
              configuration.showEnvironment === "auto"
                ? "auto"
                : configuration.showEnvironment
                  ? "show"
                  : "hide"
            }
            options={[
              { id: "auto", title: gt("Auto") },
              { id: "show", title: gt("Always show") },
              { id: "hide", title: gt("Always hide") },
            ]}
            onChange={(value) =>
              save({ showEnvironment: value === "auto" ? "auto" : value === "show" })
            }
          />
          <SettingsSwitchRow
            icon="clock"
            label={gt("Last updated")}
            disabled={disabled}
            value={configuration.showUpdatedAt}
            onValueChange={(showUpdatedAt) => save({ showUpdatedAt })}
          />
        </SettingsSection>
        <SettingsSection title={gt("Reset display")}>
          <SettingsSwitchRow
            icon="clock"
            label={gt("Show reset details")}
            disabled={disabled}
            value={configuration.showResetTimes}
            onValueChange={(showResetTimes) => save({ showResetTimes })}
          />
          <WidgetMenu
            label={gt("Default display")}
            value={configuration.resetDisplay}
            options={resetDisplays}
            disabled={disabled || !configuration.showResetTimes}
            onChange={(resetDisplay) => save({ resetDisplay })}
          />
          {quotas.map((quota) => (
            <WidgetMenu
              key={quota.id}
              label={quota.label}
              subtitle={quota.account}
              value={configuration.quotaResetDisplays[quota.id] ?? "default"}
              options={[{ id: "default", title: gt("Use default") }, ...resetDisplays]}
              disabled={disabled || !configuration.showResetTimes}
              onChange={(value) => {
                const quotaResetDisplays = { ...configuration.quotaResetDisplays };
                if (value === "default") delete quotaResetDisplays[quota.id];
                else quotaResetDisplays[quota.id] = value;
                save({ quotaResetDisplays });
              }}
            />
          ))}
        </SettingsSection>
        <SettingsSection>
          <SettingsActionRow
            icon="arrow.clockwise"
            label={isDefault ? gt("Reset default settings") : gt("Reset to default settings")}
            disabled={disabled}
            onPress={() => save(null)}
          />
        </SettingsSection>
        <Text className="text-sm text-foreground-muted">
          <T>
            Scroll the widget to see additional accounts and quotas. Open T3 to refresh readings;
            readings expire after 15 minutes or when a quota resets.
          </T>
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
