---
title: Regression of critical flows
description: Re-verify the flows the product cannot afford to break, with an explicit pass criterion for each.
---
Regression pass over the critical user flows of this app.

Flows to cover (replace or extend this list):
1. <Flow 1, e.g. sign in with a valid account> - expected: <observable outcome>
2. <Flow 2, e.g. create and save an item> - expected: <observable outcome>
3. <Flow 3, e.g. complete the purchase / booking / main task> - expected: <observable outcome>

For every flow:
- Run the happy path end to end first.
- Then try one realistic failure path (invalid input, cancelling half-way, going back) and confirm the app recovers without losing data or getting stuck.
- Capture a screenshot of the final state as evidence.

Declare one check per flow (id the flow, not the individual taps). Mark a flow FAIL if its expected outcome is not observed, even if the app did not crash. If a flow cannot be reached because an earlier one broke, mark it BLOCKED and say which check blocked it.
