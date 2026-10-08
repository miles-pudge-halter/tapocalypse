---
title: Accessibility pass
description: Large text, dark mode and screen-reader labels on the app's key screens.
---
Accessibility review of these screens: <list the 3-6 most important screens, or "all top-level destinations">.

Run the checks in this order and restore the device settings afterwards.

1. **Large text.** Set the system font size and display size to the largest setting (Android: Settings > Display > Font size and Display size; iOS: Settings > Accessibility > Display & Text Size > Larger Text). On each screen confirm text is not clipped or overlapping, controls remain reachable and scrolling still reaches all content.
2. **Dark mode.** Switch the system to dark appearance. On each screen confirm text keeps readable contrast, there are no white flashes or unthemed regions, and icons and images remain visible.
3. **Screen-reader labels.** Using the accessibility tree (element list) rather than the pixels, confirm that every interactive element on each screen has a meaningful label: icon-only buttons are named, images that carry meaning have descriptions, and no element is announced as just "button", "image" or an internal id.
4. **Touch targets.** Flag interactive elements that are visibly smaller than about 48dp (Android) / 44pt (iOS).
5. **Focus order.** Confirm the order the accessibility tree lists elements matches the visual reading order on at least the first screen and one form.

Declare one check per step. Missing labels on primary actions and unreadable text under large font are FAIL; isolated low-contrast or small targets are PASS WITH ISSUES. Reset font size, display size and appearance when done.
