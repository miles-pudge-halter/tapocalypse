---
title: Offline and poor network
description: Behaviour with no connection, a connection that drops mid-action, and recovery when it returns.
---
Test how the app behaves when connectivity is missing or unreliable.

Toggle connectivity with the device's own controls (Android: `adb shell svc wifi disable|enable` and `svc data disable|enable`, or airplane mode; iOS simulator: use the host network, or toggle it from the host). Always restore connectivity at the end.

1. **Cold start offline.** Enable airplane mode, force-stop the app and launch it. Confirm it opens, shows cached content or a clear offline state, and does not crash or spin forever.
2. **Action while offline.** On <a screen that loads or submits data> try to refresh and to perform <an action that needs the network>. Confirm the user gets a clear, non-technical message and can retry; confirm no data is silently lost.
3. **Connection lost mid-action.** Start <a network action>, disable connectivity while it is in flight, and confirm the app fails gracefully (message, retry, no stuck spinner).
4. **Recovery.** Re-enable connectivity without restarting the app. Confirm the app recovers on retry or automatically, and that anything queued is sent exactly once.
5. **Slow connection.** If the tooling allows throttling, repeat step 2 on a slow link and confirm loading indicators and timeouts behave.

Declare one check per step. Crashes, infinite loading, raw exception text or lost user input are FAIL. Mark a step skipped (with the reason) if the tooling cannot produce that condition.
