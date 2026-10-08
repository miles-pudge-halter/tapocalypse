---
title: Smoke test
description: Launch the app and walk every main navigation destination to confirm nothing is broken at first glance.
---
Smoke test of the installed build.

1. Launch the app from a cold start (force-stop it first). Confirm it reaches its first interactive screen without a crash, an error dialog or a blank screen.
2. If a login or onboarding wall appears, get past it with <test account or "skip"> and note what you used.
3. Visit every top-level destination (tabs, drawer entries, bottom bar items). On each, confirm the screen loads, shows real content or a sensible empty state, and has no visible layout breakage (clipped text, overlapping elements, missing images).
4. On <the most important screen>, perform <the single most important action> and confirm it completes.
5. Background the app for about 10 seconds and bring it back. Confirm the state is preserved or restored sensibly.

Declare one check per step. A crash, a frozen screen or an error that blocks navigation is a FAIL; cosmetic issues are PASS WITH ISSUES.
