---
title: First run and fresh install
description: What a brand-new user sees, from install state and onboarding to permission prompts and the first successful action.
---
Test the first-run experience as a user who has never opened the app.

Setup: clear the app's data (Android: `adb shell pm clear <package>`; iOS simulator: uninstall and reinstall the build) so no account, cache or preference remains.

1. **Launch.** Open the app. Confirm the first screen appears without a crash and is the expected entry point (welcome, onboarding or sign-in).
2. **Onboarding.** Walk through every onboarding screen, including any "skip" path and the back gesture. Confirm copy and images render and no step dead-ends.
3. **Permissions.** For each system permission the app asks for (notifications, location, camera, contacts...), confirm the prompt appears at a sensible moment with context, and that both Allow and Deny leave the app usable. Record which prompts appeared and when.
4. **Account creation or sign-in.** Complete <sign-up or sign-in path>. Confirm validation errors are clear for bad input and that a valid attempt succeeds.
5. **First value.** Reach <the first meaningful outcome, e.g. the home feed with content, a first item created> as quickly as a new user would. Note anything confusing, slow or unexplained.
6. **Second launch.** Force-stop and relaunch. Confirm onboarding does not repeat and the signed-in state or chosen settings persist.

Declare one check per step. Anything that stops a new user from reaching step 5 is FAIL; confusing copy or awkward prompts are PASS WITH ISSUES.
