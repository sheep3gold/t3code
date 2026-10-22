import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";

interface SessionModelIndicatorProps {
  /** `provider/model` as the model gateway reports it, e.g. `minimax/MiniMax-M3.1-Flash`. */
  readonly model: string;
}

export function SessionModelIndicator({ model }: SessionModelIndicatorProps) {
  return (
    <View accessibilityLabel={`auto model: ${model}`} className="max-w-full self-start">
      <AppText className="text-xs text-foreground" numberOfLines={1}>
        auto → {model}
      </AppText>
    </View>
  );
}
