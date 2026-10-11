import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { findMcpAppCall } from "../../lib/threadActivity";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { ThreadMcpApp } from "./McpAppWebView";

type McpAppFullscreenScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly conversationThreadId?: string;
  readonly toolCallId: string;
}>;

/**
 * An MCP App full screen (`ui/request-display-mode`), in a modal over the
 * thread. It is its own view of the app; closing it returns to the row. The
 * app is read from the thread's own stored call, never from the route, so a
 * navigation can only open an app that call really produced.
 */
export function McpAppFullscreenScreen({ route }: McpAppFullscreenScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // A plain goBack pops whatever is on top, so it only runs while this modal
  // is: an exit that lands while another screen covers it (after a teardown
  // wait) waits for the modal to be on top again, rather than popping that
  // screen or being lost.
  const focused = useIsFocused();
  const [exitRequested, setExitRequested] = useState(false);
  const onClose = useCallback(() => {
    if (navigation.isFocused()) navigation.goBack();
    else setExitRequested(true);
  }, [navigation]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const conversationThreadId = ThreadId.make(params.conversationThreadId ?? params.threadId);
  const stored = findMcpAppCall(useSelectedThreadDetail()?.activities ?? [], params.toolCallId);
  // One reference per app: a refetch returns new objects, and a new reference
  // would rebuild the app's host.
  const [call, setCall] = useState(stored);
  if (stored?.app.attachmentId !== call?.app.attachmentId) setCall(stored);
  // The approval or question the agent waits on renders on the thread this
  // modal covers, so the app steps aside for it.
  const requests = useSelectedThreadRequests();
  const awaitingUser =
    requests.activePendingApproval !== null || requests.activePendingUserInput !== null;
  useEffect(() => {
    if ((awaitingUser || exitRequested) && focused) navigation.goBack();
  }, [awaitingUser, exitRequested, focused, navigation]);

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <View className="h-11 flex-row items-center justify-between px-3">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {call?.app.server ?? "App"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit full screen"
          hitSlop={8}
          onPress={onClose}
        >
          <SymbolView name="xmark" size={18} tintColor="gray" />
        </Pressable>
      </View>
      <View
        className="flex-1"
        style={{ paddingBottom: insets.bottom }}
        onLayout={(event) =>
          setSize({
            width: Math.round(event.nativeEvent.layout.width),
            height: Math.round(event.nativeEvent.layout.height - insets.bottom),
          })
        }
      >
        {call === undefined ? (
          <Text className="m-6 text-sm text-foreground-muted">This app cannot be shown.</Text>
        ) : size.width > 0 ? (
          <ThreadMcpApp
            environmentId={environmentId}
            threadId={threadId}
            conversationThreadId={conversationThreadId}
            toolCallId={params.toolCallId}
            toolCall={call.toolCall}
            app={call.app}
            width={size.width}
            height={size.height}
            displayMode="fullscreen"
            onExitFullscreen={onClose}
          />
        ) : null}
      </View>
    </View>
  );
}
