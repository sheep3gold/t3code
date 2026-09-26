# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## External message routing

An environment configured with `T3CODE_MSGHUB_NOTIFY=1` can also publish completion, interruption,
approval, question, and agent-authored notifications through one msghub transport. Agents use
`send_notification`; they cannot select a subject, recipient, or downstream channel. T3 Code sends
a standard thread/project envelope to the restricted
`dingding.notify.vibecoding.t3code.agent.message` subject, and msghub/notifier configuration decides
whether it reaches the currently configured DingTalk, ntfy, and Bark connectors or another
connector added to that routing layer. A `dedupeKey` keeps retries from delivering the same
notification twice.
