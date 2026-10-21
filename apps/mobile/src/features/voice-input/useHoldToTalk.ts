import { useCallback, useMemo, useRef, useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import type { useVoiceInputController } from "./useVoiceInputController";

/** Finger travel that arms slide-to-cancel, measured from the press start. */
export const CANCEL_SLIDE_DISTANCE = 80;
/** Hold duration before recording starts; a quicker lift is a tap. */
const HOLD_ACTIVATE_MS = 280;
/** Keeps the long press alive while the finger slides to arm cancel. */
const HOLD_MAX_DRIFT = 400;

type VoiceInputController = ReturnType<typeof useVoiceInputController>;

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

/**
 * WeChat-style hold-to-talk over the dictation controller: holding the mic
 * starts recording, releasing transcribes, and sliding the held finger up
 * arms cancel. A quick tap still starts the legacy click-driven session, so
 * voice-over users keep a path that does not depend on sustaining a press.
 */
export function useHoldToTalk(voice: VoiceInputController, disabled = false) {
  const [held, setHeld] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const heldRef = useRef(false);
  // session.start() is async, so the phase is still idle for a render or two
  // after the hold begins; only a hold that has seen a busy phase can go stale.
  const [sawBusy, setSawBusy] = useState(false);
  const cancelArmedRef = useRef(false);
  const startYRef = useRef<number | null>(null);
  const gestureY = useSharedValue(0);
  // The controller object changes every render; reading it through a ref keeps
  // the gesture identity stable so an in-flight press keeps its callbacks.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const clearHold = useCallback(() => {
    heldRef.current = false;
    cancelArmedRef.current = false;
    setSawBusy(false);
    setHeld(false);
    setCancelArmed(false);
  }, []);

  const gesture = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(HOLD_ACTIVATE_MS)
        .maxDistance(HOLD_MAX_DRIFT)
        .runOnJS(true)
        .onBegin(() => {
          startYRef.current = null;
        })
        .onTouchesMove((event) => {
          const y = event.allTouches[0]?.y;
          if (y === undefined) return;
          if (startYRef.current === null) startYRef.current = y;
          gestureY.value = y - startYRef.current;
          const armed = gestureY.value < -CANCEL_SLIDE_DISTANCE;
          if (armed !== cancelArmedRef.current) {
            cancelArmedRef.current = armed;
            setCancelArmed(armed);
            if (armed) selectionHaptic();
          }
        })
        .onStart(() => {
          const current = voiceRef.current;
          if (disabledRef.current || !current.isAvailable || heldRef.current) return;
          selectionHaptic();
          heldRef.current = true;
          cancelArmedRef.current = false;
          setSawBusy(false);
          setCancelArmed(false);
          setHeld(true);
          current.start();
        })
        // Fires on both a clean release and a cancelled press; a no-op unless
        // the hold already activated.
        .onFinalize(() => {
          if (!heldRef.current) return;
          const current = voiceRef.current;
          const cancelled = cancelArmedRef.current;
          clearHold();
          if (cancelled) {
            current.cancel();
          } else if (current.state.phase === "recording") {
            current.stop();
          } else {
            // Released before recording began (or after an error): too short to
            // transcribe, so drop the attempt instead of wedging in preparing.
            current.cancel();
          }
        }),
    [clearHold, gestureY],
  );

  // A stale hold (backgrounding, interruption, owner switch) must not leave
  // the overlay up with no finger to release it.
  const phase = voice.state.phase;
  const busy = phase === "preparing" || phase === "recording" || phase === "transcribing";
  if (held && busy && !sawBusy) setSawBusy(true);
  const showOverlay = held && busy;
  if (held && !busy && (sawBusy || phase === "error")) {
    clearHold();
  }

  return {
    gesture,
    held,
    cancelArmed,
    showOverlay,
    gestureY,
    slideDistance: CANCEL_SLIDE_DISTANCE,
  };
}
