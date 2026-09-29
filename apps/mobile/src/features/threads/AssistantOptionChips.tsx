import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { isOptionSelected } from "./assistant-options";

export interface AssistantOptionChipsProps {
  readonly options: ReadonlyArray<string>;
  readonly prompt: string;
  readonly onToggle: (label: string) => void;
  readonly onSend: (label: string) => void;
  readonly disabled?: boolean;
}

export function AssistantOptionChips({
  options,
  prompt,
  onToggle,
  onSend,
  disabled = false,
}: AssistantOptionChipsProps) {
  if (options.length === 0) return null;

  return (
    <View className="shrink-0 px-4 pb-2" testID="assistant-option-chips">
      <View className="flex-row flex-wrap gap-2">
        {options.map((label) => {
          const selected = isOptionSelected(prompt, label);
          return (
            <View
              key={label}
              className={cn(
                "max-w-full flex-row self-start overflow-hidden rounded-full border",
                selected ? "border-primary bg-primary/10" : "border-border bg-input",
                disabled && "opacity-50",
              )}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${selected ? "移除" : "加入输入框"}：${label}`}
                accessibilityState={{ disabled, selected }}
                disabled={disabled}
                className="min-h-12 min-w-0 shrink justify-center px-3 py-2 active:opacity-70"
                onPress={() => onToggle(label)}
              >
                <Text
                  className={cn(
                    "font-t3-medium text-sm",
                    selected ? "text-foreground" : "text-foreground-secondary",
                  )}
                  numberOfLines={2}
                >
                  {label}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`只发送这一条：${label}`}
                accessibilityState={{ disabled }}
                disabled={disabled}
                className={cn(
                  "h-12 w-12 items-center justify-center border-l active:opacity-70",
                  selected ? "border-primary/50" : "border-border",
                )}
                onPress={() => onSend(label)}
              >
                <SymbolView
                  name="arrow.up"
                  size={15}
                  tintColorClassName={selected ? "accent-icon" : "accent-icon-subtle"}
                  type="monochrome"
                />
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}
