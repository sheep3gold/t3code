import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  SECRET_REQUEST_PRIVACY_NOTE,
  secretRequestAnswerInput,
  secretRequestFailureMessage,
  type SecretRequestCard as SecretRequestCardModel,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "./RequestActionButton";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };

/**
 * Feed card for a secret an agent asked the user for. The typed value lives
 * only in this component's state and the RPC payload: it is never logged,
 * alerted, or persisted, and the field clears once the answer is sent.
 */
export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly card: SecretRequestCardModel;
}) {
  const { card } = props;
  const answer = useAtomCommand(orchestrationEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(card, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      // The card switches to its answered row once the activity lands.
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  // Same hierarchy as web: what is asked, why, the field, then the promise
  // about where the value goes.
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{card.label}</Text>
        {card.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{card.reason}</Text>
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={card.label}
        placeholder={card.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
        value={secret}
        onChangeText={setSecret}
        editable={!submitting}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={() => void send({ type: "save", secret })}
      />
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <RequestActionButton
        label="Save securely"
        disabled={submitting || secret.trim().length === 0}
        onPress={() => void send({ type: "save", secret })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView name={LOCK_SYMBOL} size={13} type="monochrome" />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {SECRET_REQUEST_PRIVACY_NOTE}
          </Text>
        </View>
        {/* Quiet like the web card's: the field and Save are the action. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: submitting }}
          disabled={submitting}
          hitSlop={8}
          className="px-1 py-1 active:opacity-60 disabled:opacity-50"
          onPress={() => void send({ type: "decline" })}
        >
          <Text className="font-sans text-xs text-foreground-muted">Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}
