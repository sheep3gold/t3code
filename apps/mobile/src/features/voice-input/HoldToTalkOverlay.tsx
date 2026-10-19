import { memo } from "react";
import { Text as SystemText, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { CompactVoiceWaveform } from "./ComposerDictationControl";

const OVERLAY_TIMING = {
  duration: 160,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
/** How far the finger may drift before the hint's arrow turns dim. */
const HINT_TOLERANCE = 40;

/**
 * WeChat-style recording overlay: waveform and elapsed time while held, with
 * the hint flipping to a red cancel state once the finger slides up past the
 * threshold. Non-interactive — the gesture that opened it keeps tracking the
 * finger through the translucent backdrop.
 */
export const HoldToTalkOverlay = memo(function HoldToTalkOverlay(props: {
  readonly audioLevels: SharedValue<number[]>;
  readonly cancelArmed: boolean;
  readonly elapsedSeconds: number;
  readonly gestureY: SharedValue<number>;
  readonly slideDistance: number;
}) {
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: withTiming(
      props.gestureY.value < -props.slideDistance + HINT_TOLERANCE ? 1 : 0.35,
      OVERLAY_TIMING,
    ),
  }));

  return (
    <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
      <View className="absolute inset-0 bg-black/40" />
      <Animated.View
        entering={ENTERING}
        exiting={EXITING}
        className={cn(
          "w-[264px] items-center gap-3 rounded-3xl border px-5 py-4",
          props.cancelArmed
            ? "border-danger-border bg-danger"
            : "border-border bg-card shadow-lg shadow-adaptive-black-a10-a25",
        )}
      >
        <View className="h-8 items-center justify-center" style={{ minWidth: 180 }}>
          {props.cancelArmed ? (
            <Text className="text-sm font-t3-semibold text-danger-foreground">
              Release to cancel
            </Text>
          ) : (
            <View className="flex-row items-center gap-3">
              <CompactVoiceWaveform audioLevels={props.audioLevels} />
              <SystemText
                className="text-xs text-foreground-muted"
                numberOfLines={1}
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {Math.floor(props.elapsedSeconds / 60)}:
                {String(props.elapsedSeconds % 60).padStart(2, "0")}
              </SystemText>
            </View>
          )}
        </View>
        {props.cancelArmed ? (
          <SymbolView
            name="xmark"
            size={22}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
        ) : (
          <View className="flex-row items-center gap-1.5">
            <Animated.View style={arrowStyle}>
              <SymbolView
                name="chevron.up"
                size={14}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            </Animated.View>
            <Text className="text-xs text-foreground-muted">Slide up to cancel</Text>
          </View>
        )}
      </Animated.View>
    </View>
  );
});
