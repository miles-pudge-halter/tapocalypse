---
title: Verify a ticket or pull request
description: Check that a change meets its acceptance criteria and did not break the area around it.
---
Verify the change described below against its acceptance criteria.

Ticket / PR: <link or id>
Summary of the change: <one or two sentences>

Acceptance criteria:
1. <criterion 1>
2. <criterion 2>
3. <criterion 3>

How to reach the changed area: <navigation path, account, feature flags, test data>

Instructions:
- Declare one check per acceptance criterion, using the criterion text as the title.
- Test each criterion by using the app the way a user would; do not infer from code. Attach a screenshot as proof for every pass and every fail.
- Then add one "neighbouring behaviour" check: use the two or three features closest to the change and confirm they still work.
- If the build under test does not contain the change (the new behaviour is simply absent), stop and report BLOCKED with that explanation instead of failing every criterion.
- Record anything surprising that is outside the criteria in the report, but keep it out of the verdict unless it is a crash or data loss.
