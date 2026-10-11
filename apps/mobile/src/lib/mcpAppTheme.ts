import type { MobileThemeVariables } from "./mobileTheme";

/**
 * The MCP Apps style names, translated from the fork's mobile theme to the
 * spec's standardized ones (web reads the same set from its CSS). Mobile has
 * no success slot or custom fonts, so those stay unset;
 * `mcpAppStyleVariables` skips empty values rather than sending blanks.
 */
export function mcpAppThemeVariables(variables: MobileThemeVariables): Record<string, string> {
  return {
    "--background": variables["--color-screen"],
    "--card": variables["--color-card"],
    "--muted": variables["--color-card-alt"],
    "--foreground": variables["--color-foreground"],
    "--muted-foreground": variables["--color-foreground-muted"],
    "--info": variables["--color-primary"],
    "--info-foreground": variables["--color-primary-foreground"],
    "--destructive": variables["--color-danger"],
    "--destructive-surface": variables["--color-danger"],
    "--destructive-foreground": variables["--color-danger-foreground"],
    "--warning-surface": variables["--color-warning"],
    "--warning-foreground": variables["--color-warning-foreground"],
    "--border": variables["--color-border"],
    "--input": variables["--color-input-border"],
    "--ring": variables["--color-focus"],
  };
}
