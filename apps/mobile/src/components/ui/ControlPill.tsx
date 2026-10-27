import * as Haptics from "expo-haptics";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import { cn } from "../../lib/cn";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { IconButton } from "./IconButton";
import { Button } from "./Button";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly activateOnPressIn?: boolean;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
  /** Tighter Material composer control on Android. */
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const variant = props.variant ?? "circle";
  const isAndroid = Platform.OS === "android";
  const { smallIconSize } = useAndroidControlSizing();
  const activatedOnPressInRef = useRef(false);

  const invokeOnPress = () => {
    if (!props.onPress) return;
    if (isAndroid) {
      void Haptics.selectionAsync();
    }
    props.onPress();
  };

  const handlePressIn = () => {
    activatedOnPressInRef.current = true;
    invokeOnPress();
  };
  const handlePressOut = () => {
    // Defer reset: Pressability calls onPressOut before onPress for the same gesture.
    setTimeout(() => {
      activatedOnPressInRef.current = false;
    }, 0);
  };
  const handlePress = () => {
    if (activatedOnPressInRef.current) {
      return;
    }
    invokeOnPress();
  };

  const iconTintClassName =
    variant === "primary"
      ? props.disabled
        ? isAndroid
          ? "accent-accent-foreground"
          : "accent-icon-subtle"
        : "accent-primary-foreground"
      : variant === "danger"
        ? "accent-danger-foreground"
        : "accent-icon";

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);
  const containerClassName = cn(
    isCircle
      ? props.compact
        ? "h-10 w-10 items-center justify-center rounded-full"
        : "h-11 w-11 items-center justify-center rounded-full"
      : variant === "primary"
        ? "h-11 flex-row items-center justify-center gap-2 rounded-full px-5"
        : "h-11 flex-row items-center justify-center gap-2 rounded-full px-3.5",
    variant === "primary"
      ? props.disabled
        ? isAndroid
          ? "bg-primary-tonal"
          : "bg-subtle-strong"
        : "bg-primary"
      : variant === "danger"
        ? "bg-danger"
        : "bg-subtle",
    props.className,
  );
  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? isAndroid
          ? "text-accent-foreground"
          : "text-foreground-muted"
        : "text-primary-foreground"
      : variant === "danger"
        ? "text-danger-foreground"
        : "text-foreground",
  );

  if (
    Platform.OS === "android" &&
    (variant === "pill" || variant === "primary") &&
    props.label &&
    props.onPress &&
    !props.icon &&
    !props.iconNode &&
    !props.className &&
    !props.activateOnPressIn &&
    (!props.accessibilityLabel || props.accessibilityLabel === props.label)
  ) {
    return (
      <Button
        label={props.label}
        onPress={invokeOnPress}
        disabled={props.disabled}
        tone={variant === "primary" ? "primary" : "secondary"}
      />
    );
  }

  if (
    Platform.OS === "android" &&
    props.accessibilityLabel &&
    props.icon &&
    !props.iconNode &&
    !props.label &&
    !props.className &&
    !props.activateOnPressIn
  ) {
    return (
      <IconButton
        accessibilityLabel={props.accessibilityLabel}
        icon={props.icon}
        onPress={invokeOnPress}
        disabled={props.disabled}
        variant={variant === "primary" ? "primary" : variant === "danger" ? "danger" : "tonal"}
      />
    );
  }

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.activateOnPressIn ? handlePress : props.onPress ? invokeOnPress : undefined}
      onPressIn={props.activateOnPressIn ? handlePressIn : undefined}
      onPressOut={props.activateOnPressIn ? handlePressOut : undefined}
      disabled={props.disabled}
      className={containerClassName}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={smallIconSize}
          tintColorClassName={iconTintClassName}
          type="monochrome"
        />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </Pressable>
  );
}
