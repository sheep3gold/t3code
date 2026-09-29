import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RequestActionButton } from "./RequestActionButton";

export function ThreadRetryCard(props: {
  readonly error: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <View className="gap-2.5 rounded-[20px] border border-danger-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-danger-foreground">
        Thread stopped
      </Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.error}
      </Text>
      <View className="flex-row">
        <RequestActionButton
          label={props.retrying ? "Retrying…" : "Retry"}
          disabled={props.retrying}
          onPress={props.onRetry}
        />
      </View>
    </View>
  );
}
