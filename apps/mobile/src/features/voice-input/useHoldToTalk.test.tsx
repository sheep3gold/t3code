// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  voice: null as unknown,
  handlers: {} as Record<string, (arg?: unknown) => void>,
}));

vi.mock("react-native-gesture-handler", () => ({
  Gesture: {
    LongPress: () => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const builder: Record<string, unknown> = {
        minDuration: () => builder,
        maxDistance: () => builder,
        runOnJS: () => builder,
      };
      for (const name of ["onBegin", "onStart", "onEnd", "onFinalize", "onTouchesMove"]) {
        builder[name] = (handler: (arg?: unknown) => void) => {
          handlers[name] = handler;
          return builder;
        };
      }
      harness.handlers = handlers;
      return builder;
    },
  },
}));

vi.mock("react-native-reanimated", async () => {
  const { useState } = await import("react");
  // Shared values keep their identity across renders, like Reanimated's.
  return { useSharedValue: (initial: number) => useState(() => ({ value: initial }))[0] };
});

vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: "medium" },
}));

vi.mock("./useVoiceInputController", () => ({
  useVoiceInputController: () => harness.voice,
}));

import { CANCEL_SLIDE_DISTANCE, useHoldToTalk } from "./useHoldToTalk";

function makeVoice(phase: string, isAvailable = true) {
  const voice = {
    isAvailable,
    state: { phase, error: null, errorAction: null },
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
    audioLevels: { value: [0, 0] },
    elapsedSeconds: 0,
  };
  harness.voice = voice;
  return voice;
}

let root: Root | null = null;
let lastHold: ReturnType<typeof useHoldToTalk> | null = null;

function renderProbe(phase: string, isAvailable = true, disabled = false) {
  const voice = makeVoice(phase, isAvailable);
  function Probe() {
    lastHold = useHoldToTalk(voice as never, disabled);
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Probe />));
  return voice;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.voice = null;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useHoldToTalk", () => {
  it("starts recording on hold begin and cancels a release that never recorded", () => {
    // preparing: the hold is active but the recorder has not started yet.
    const voice = renderProbe("preparing");
    act(() => {
      harness.handlers.onStart!();
    });
    expect(voice.start).toHaveBeenCalledTimes(1);

    act(() => {
      harness.handlers.onFinalize!();
    });
    // The probe's phase never reached recording, so the release cancels
    // rather than transcribing a hold that never recorded.
    expect(voice.cancel).toHaveBeenCalledTimes(1);
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it("cancels when the finger slides past the cancel distance before release", () => {
    const voice = renderProbe("recording");
    act(() => {
      harness.handlers.onBegin!();
      harness.handlers.onStart!();
    });
    expect(voice.start).toHaveBeenCalledTimes(1);
    expect(lastHold!.showOverlay).toBe(true);

    const touchesMove = harness.handlers.onTouchesMove as (event: {
      allTouches: Array<{ y: number }>;
    }) => void;
    act(() => {
      touchesMove({ allTouches: [{ y: 100 }] });
      touchesMove({ allTouches: [{ y: 100 - CANCEL_SLIDE_DISTANCE - 1 }] });
    });
    expect(lastHold!.cancelArmed).toBe(true);

    act(() => {
      harness.handlers.onFinalize!();
    });
    expect(voice.cancel).toHaveBeenCalledTimes(1);
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it("stops on release after the phase moves from idle to recording mid-hold", () => {
    // The controller object is recreated each render, as in the real composer.
    let phase = "idle";
    const start = vi.fn();
    const stop = vi.fn();
    const cancel = vi.fn();
    function Probe() {
      lastHold = useHoldToTalk({
        isAvailable: true,
        state: { phase, error: null, errorAction: null },
        start,
        stop,
        cancel,
      } as never);
      return null;
    }
    root = createRoot(document.createElement("div"));
    const rerender = () => act(() => root!.render(<Probe />));
    rerender();
    const gesture = lastHold!.gesture;

    act(() => {
      harness.handlers.onBegin!();
      harness.handlers.onStart!();
    });
    // session.start() has not reported preparing yet; the hold must survive.
    expect(lastHold!.held).toBe(true);
    phase = "preparing";
    rerender();
    phase = "recording";
    rerender();
    expect(lastHold!.showOverlay).toBe(true);
    expect(lastHold!.gesture).toBe(gesture);

    act(() => {
      harness.handlers.onFinalize!();
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(lastHold!.held).toBe(false);

    // A second finalize (cancelled press after end) does nothing.
    act(() => {
      harness.handlers.onFinalize!();
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("drops a hold whose session ended without a release", () => {
    let phase = "recording";
    function Probe() {
      lastHold = useHoldToTalk({
        isAvailable: true,
        state: { phase, error: null, errorAction: null },
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
      } as never);
      return null;
    }
    root = createRoot(document.createElement("div"));
    const rerender = () => act(() => root!.render(<Probe />));
    rerender();
    act(() => {
      harness.handlers.onStart!();
    });
    expect(lastHold!.showOverlay).toBe(true);
    phase = "idle";
    rerender();
    expect(lastHold!.held).toBe(false);
    expect(lastHold!.showOverlay).toBe(false);
  });

  it("ignores holds when voice input is unavailable", () => {
    const voice = renderProbe("idle", false);
    act(() => {
      harness.handlers.onStart!();
    });
    expect(voice.start).not.toHaveBeenCalled();
  });
});
