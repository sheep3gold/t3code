// Install anchor: a sandbox file that a reinstall wipes, while Keychain-persisted
// connection credentials survive. Its value (the first-launch timestamp of the
// current install) rides the WebSocket URL as clientInstalledAt; the server
// treats a changed value as a reinstall and triggers expiry-ledger renewal for
// Personal Team 7-day signing. iOS only: that signing constraint does not exist
// on Android.
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

const ANCHOR_FILE = "install-anchor.json";

let cachedInstallAnchor: string | undefined;

export function getInstallAnchor(): string | undefined {
  return cachedInstallAnchor;
}

export async function initInstallAnchor(): Promise<string | undefined> {
  if (Platform.OS !== "ios") return undefined;
  if (cachedInstallAnchor !== undefined) return cachedInstallAnchor;
  try {
    const file = new File(Paths.document, ANCHOR_FILE);
    if (file.exists) {
      const parsed = JSON.parse(await file.text()) as { readonly installedAt?: unknown };
      if (typeof parsed.installedAt === "string" && parsed.installedAt.trim() !== "") {
        cachedInstallAnchor = parsed.installedAt;
        return cachedInstallAnchor;
      }
    }
    const installedAt = new Date().toISOString();
    file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify({ installedAt }));
    cachedInstallAnchor = installedAt;
  } catch {
    // Never block startup on the anchor: the server just misses the param on
    // this launch and picks it up on the next connect.
  }
  return cachedInstallAnchor;
}

export function __resetInstallAnchorForTest(): void {
  cachedInstallAnchor = undefined;
}
