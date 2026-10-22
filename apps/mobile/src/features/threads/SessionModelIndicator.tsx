import type { ServerModelRouteInfo } from "@t3tools/contracts";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";

interface SessionModelIndicatorProps {
  readonly info: ServerModelRouteInfo | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly onRefresh: () => void;
}

export function SessionModelIndicator({
  info,
  isLoading,
  error,
  onRefresh,
}: SessionModelIndicatorProps) {
  const label =
    info?.provider && info.model
      ? `${info.provider}/${info.model}${info.tier ? ` (${info.tier})` : ""}`
      : null;
  if (!label && !isLoading && !error) return null;

  return (
    <Pressable
      onPress={onRefresh}
      accessibilityRole="button"
      accessibilityLabel={
        label ? `Current model: ${label}. Refresh` : "Model information unavailable. Retry"
      }
      className="min-h-12 justify-center self-start"
    >
      <AppText className="text-xs text-muted-foreground" numberOfLines={1}>
        {label ?? (isLoading ? "Checking model…" : "Model information unavailable · Retry")}
      </AppText>
    </Pressable>
  );
}
