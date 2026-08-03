# Clipboard Indicator Popup UI Revamp

## Status
Approved for implementation.

## Goal
Redesign the clipboard history popup so it is sleek, minimal, and closer to the Windows `Win+V` clipboard popup:
- Remove bulky per-item action buttons (Delete, Pin, Paste, Edit, Tag, Preview).
- Replace them with a single compact "more" dropdown per item.
- Enlarge image previews so they are easily visible.
- Hide the scrollbar in the popup.
- Add subtle animations.
- Remain compatible with Blur my Shell (or similar) blur extensions.

## Non-goals
- Change settings keys / schema structure.
- Add new user-facing toggles.
- Modify top-bar indicator behavior.
- Refactor registry, caching, or selection logic.

## Constraints
- GNOME Shell extensions cannot apply blur shaders to arbitrary actors. Blur must come from an external extension such as Blur my Shell. We can only expose stable CSS classes that Blur my Shell can be configured to target.
- The extension targets GNOME Shell 46–50. We must keep compatibility across those versions and avoid newly-introduced APIs that break older targets.
- We must preserve all existing keyboard shortcuts (Del, P, V, E, T, H) and the existing visibility toggles in Preferences.

## Approach
**Approach A — single compact "more" menu per item.**

Instead of the current row that contains a delete icon, pin icon, paste icon, tag icon, edit icon (text only), and preview icon (image only), each row will contain:

1. Content preview (truncated text or image thumbnail).
2. Optional tag pill.
3. One small "kebab" (`view-more-horizontal-symbolic`) button that opens a dropdown with the relevant actions.

This removes visual clutter while keeping every action available and discoverable. The existing preferences toggles (`show-delete-button`, `show-pin-button`, etc.) will control whether each action appears inside the dropdown; the kebab button itself will hide when no actions are enabled.

## Design details

### Row layout (`extension.js`)

Current `_addEntry` creates a `PopupMenu.PopupMenuItem` and adds, in order:
- label / image preview
- tag label (if any)
- actions spacer
- image preview button (images)
- edit button (text)
- pin button
- paste button
- tag button
- delete button

New `_addEntry` will:
1. Create the same `PopupMenu.PopupMenuItem`.
2. Add the label or image preview.
3. Add the tag pill (unchanged logic, smaller style).
4. Add a single `St.Button` (`moreBtn`) with `view-more-horizontal-symbolic`.
5. Attach a small per-item `PopupMenu.PopupMenu` (or `PopupSubMenuMenuItem`) that contains only the actions currently enabled by settings.
6. Keep all existing keyboard handlers intact so shortcuts continue to work even when buttons are hidden.

### Image previews

- Increase `.clipboard-menu-img-preview` from `1.5em` to **48 px × 48 px**.
- Remove the white border and add `border-radius: 6px`.
- Keep aspect ratio by using `St.Bin` with the image as a child.

### Scrollbar

- Both `historyScrollView` and `favoritesScrollView` already set `overlay_scrollbars: true`.
- Add CSS to suppress the visible scrollbar track/thumb in the popup:
  ```css
  .clipboard-indicator-popup StScrollBar {
      width: 0;
  }
  ```
  (or equivalent GNOME Shell CSS to hide it).

### Popup styling

- Add the class `clipboard-indicator-popup` to the menu actor/box.
- Apply:
  - `border-radius: 12px`
  - tighter internal padding
  - translucent background (respecting theme)
  - subtle shadow
  - transitions for hover/focus backgrounds
- Keep the existing `.popup-menu-content` class so Blur my Shell can target it automatically if configured.

### Animations

- CSS transitions (150–200 ms) for row hover background, selection dot opacity, and the kebab button opacity.
- Use GNOME Shell’s built-in popup open/close animation where available; do not block or override it unless necessary.
- If the API allows, add a lightweight fade/slide on open via `AnimationUtils`. If not, rely on CSS transitions.

### Blur my Shell compatibility

- Document the class `clipboard-indicator-popup` in `README.md` so users can add it to Blur my Shell’s application list if it is not auto-detected.
- No runtime detection or dependency on Blur my Shell.

## Files to change

1. `extension.js`
   - Refactor `_addEntry` row construction.
   - Add per-item dropdown menu creation.
   - Attach the `clipboard-indicator-popup` class to the menu.
   - Preserve keyboard shortcuts and existing action handlers.

2. `stylesheet.css`
   - New `.clipboard-indicator-popup` shell styles.
   - Update `.clipboard-menu-img-preview` size and appearance.
   - Hide scrollbar.
   - Style the kebab button and dropdown items.

3. `README.md`
   - Add a short note about Blur my Shell class name compatibility.

## Verification

- Syntax: run `make lint` or `gjs -c` if available; otherwise visually review.
- Manual: load the extension in a GNOME Shell session, open the popup, and confirm:
  - Rows show only content, tag (if any), and the kebab.
  - Clicking the kebab reveals enabled actions.
  - Image previews are ~48 px and rounded.
  - Scrollbar is not visible.
  - Hover/selection animations are smooth.
  - Keyboard shortcuts still work.

## Open questions
None — all decisions made in design approval.
