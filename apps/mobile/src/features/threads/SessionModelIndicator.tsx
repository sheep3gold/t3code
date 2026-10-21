import { type ServerModelRouteInfo } from "@t3tools/contracts";
import { Text, Pressable, type TextProps } from "react-native";
import { useTheme } from "@tamagui/core";

interface SessionModelIndicatorProps {
  readonly info: ServerModelRouteInfo | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly onRefresh?: () => void;
  readonly textStyle?: TextProps["style"];
}

/** 显示文本：glm/glm-5.3 (MEDIUM档) */
function formatSessionRouteLabel(input: {
  readonly provider: string;
  readonly model: string;
  readonly tier: string;
}): string {
  const { provider, model, tier } = input;
  const section = provider && model ? `${provider}/${model}` : "";
  return tier ? `${section} (${tier}档)` : section;
}

/**
 * 显示当前会话实际使用的模型（provider/model 和档位）。
 * 失败或加载中时显示占位符，点击可刷新。
 */
export function SessionModelIndicator({
  info,
  isLoading,
  error,
  onRefresh,
  textStyle,
}: SessionModelIndicatorProps) {
  const theme = useTheme();
  const label = info ? formatSessionRouteLabel(info) : null;
  const showPlaceholder = !label || isLoading;

  const handlePress = () => {
    if (onRefresh) {
      void onRefresh();
    }
  };

  if (showPlaceholder) {
    if (isLoading) {
      return <Text style={[textStyle, { color: theme.color11.value }]}>加载中...</Text>;
    }
    if (error) {
      return (
        <Pressable onPress={handlePress}>
          <Text style={[textStyle, { color: theme.color11.value }]}>模型信息不可用</Text>
        </Pressable>
      );
    }
    return null;
  }

  return (
    <Pressable onPress={handlePress}>
      <Text style={[textStyle, { color: theme.color11.value }]}>{label}</Text>
    </Pressable>
  );
}
