# Clipboard Popup UI Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bulky per-item action buttons in the clipboard history popup with a single compact "more" dropdown, enlarge image previews, hide the scrollbar, add subtle animations, and expose Blur my Shell-compatible CSS classes.

**Architecture:** Keep the existing `PanelMenu.Button` / `PopupMenu` structure. Refactor `_addEntry()` in `extension.js` so each row only shows content preview, an optional tag pill, and one kebab button that opens a small per-item menu. Drive visual changes through `stylesheet.css` and document Blur my Shell compatibility in `README.md`.

**Tech Stack:** GNOME Shell extension (GJS, St, Clutter, PopupMenu), CSS via `stylesheet.css`, settings schema unchanged.

## Global Constraints
- Target GNOME Shell 46–50; avoid APIs not present in all target versions.
- Preserve existing keyboard shortcuts: Del (delete), P (pin), V (paste), E (edit text), T (tag), H (image preview).
- Preserve existing preferences toggles: `show-delete-button`, `show-pin-button`, `show-paste-button`, `show-edit-button`, `show-tag-button`, `show-preview-button`.
- Do not change the settings schema (`schemas/org.gnome.shell.extensions.clipboard-indicator.gschema.xml`).
- Do not modify registry, caching, selection, or top-bar indicator logic.
- No runtime dependency on Blur my Shell; only expose a stable CSS class.

---

### Task 1: Add the popup-level CSS class and base styling

**Files:**
- Modify: `extension.js:275-312`
- Modify: `stylesheet.css`

**Interfaces:**
- Consumes: existing `this.menu` actor created by `PanelMenu.Button`.
- Produces: menu actor with extra style class `clipboard-indicator-popup`.

- [ ] **Step 1: Assign the new class to the popup menu**

In `extension.js`, inside `_buildMenu()`, after the sections are added to `this.menu`, add:

```javascript
this.menu.box.add_style_class_name('clipboard-indicator-popup');
```

Place it near the section-ordering block (around line 305-312) so the class is applied once during menu construction.

- [ ] **Step 2: Add base popup CSS**

In `stylesheet.css`, prepend/append a new block (keep existing rules intact):

```css
.clipboard-indicator-popup {
    border-radius: 12px;
    padding: 8px 0;
}

.clipboard-indicator-popup .popup-menu-content {
    border-radius: 12px;
    background-color: rgba(28, 28, 28, 0.92);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.clipboard-indicator-popup .popup-menu-item {
    border-radius: 8px;
    margin: 2px 8px;
    padding: 8px 12px;
    transition: background-color 150ms ease-in-out;
}

.clipboard-indicator-popup .popup-menu-item:hover,
.clipboard-indicator-popup .popup-menu-item:focus,
.clipboard-indicator-popup .popup-menu-item.selected {
    background-color: rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 3: Verify the class is added and syntax is valid**

Run a syntax check. If the project has a Makefile target, use it:

```bash
make lint
```

If not, do a manual gjs parse check:

```bash
gjs -c "import('file:///home/dopamide/Projects/gnome-shell-extension-clipboard-indicator/extension.js').then(() => print('ok')).catch(e => { print(e); quit(1); })"
```

Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add extension.js stylesheet.css
git commit -m "feat(popup): add clipboard-indicator-popup class and base shell styling"
```

---

### Task 2: Enlarge image previews and hide the scrollbar

**Files:**
- Modify: `stylesheet.css:61-75`

**Interfaces:**
- Consumes: `.clipboard-menu-img-preview` and `.clipboard-indicator-img-preview` classes.
- Produces: larger, rounded image thumbnails; invisible scrollbar in the popup.

- [ ] **Step 1: Update image preview styles**

Replace the existing `.clipboard-menu-img-preview` block with:

```css
.clipboard-menu-img-preview {
    border: none;
    border-radius: 6px;
    overflow: hidden;
    width: 48px;
    height: 48px;
    margin: 0;
    padding: 0;
}
```

Also update `.clipboard-indicator-img-preview` to match the rounded look (keep its top-bar size):

```css
.clipboard-indicator-img-preview {
    border: none;
    border-radius: 4px;
    width: 1em;
    height: 1em;
    margin-right: .25em;
}
```

- [ ] **Step 2: Hide the popup scrollbar**

Add to `stylesheet.css`:

```css
.clipboard-indicator-popup StScrollBar {
    width: 0;
}

.clipboard-indicator-popup StScrollBar StBin {
    background-color: transparent;
    border: none;
}
```

- [ ] **Step 3: Commit**

```bash
git add stylesheet.css
git commit -m "feat(popup): enlarge image previews, round corners, hide scrollbar"
```

---

### Task 3: Refactor `_addEntry()` to use a single kebab dropdown

**Files:**
- Modify: `extension.js:608-835`

**Interfaces:**
- Consumes: `SHOW_DELETE_BUTTON`, `SHOW_PIN_BUTTON`, `SHOW_TAG_BUTTON`, `SHOW_EDIT_BUTTON`, `SHOW_PREVIEW_BUTTON`, `PASTE_BUTTON` booleans; existing `_removeEntry`, `_favoriteToggle`, `#pasteItem`, `#showEditDialog`, `#showTagDialog`, `#showImagePreview`, `_confirmRemovePinnedEntry` helpers.
- Produces: each menu item (`menuItem`) exposes `menuItem.moreBtn`, `menuItem.actionMenu`, and keeps legacy action buttons removed from the actor tree. Keyboard handlers remain unchanged.

- [ ] **Step 1: Create a helper to build the per-item action menu**

Add the following private method near `_addEntry()` (e.g. after `_onSearchTextChanged`):

```javascript
#buildItemActionMenu(menuItem, entry) {
    const actionMenu = new PopupMenu.PopupMenu(menuItem.moreBtn, 0, St.Side.TOP);
    actionMenu.actor.add_style_class_name('clipboard-indicator-item-menu');
    Main.uiGroup.add_child(actionMenu.actor);
    actionMenu.actor.hide();

    const addAction = (label, iconName, visible, callback) => {
        if (!visible) return;
        const item = new PopupMenu.PopupMenuItem(label);
        item.insert_child_at_index(new St.Icon({
            icon_name: iconName,
            style_class: 'clipboard-menu-icon',
            y_align: Clutter.ActorAlign.CENTER
        }), 0);
        item.connect('activate', () => {
            actionMenu.close();
            callback();
        });
        actionMenu.addMenuItem(item);
    };

    addAction(_('Paste'), 'edit-paste-symbolic', PASTE_BUTTON, () => this.#pasteItem(menuItem));
    addAction(_('Pin'), entry.isFavorite() ? 'view-unpin-symbolic' : 'view-pin-symbolic', SHOW_PIN_BUTTON, () => this._favoriteToggle(menuItem));
    addAction(_('Edit'), 'document-edit-symbolic', SHOW_EDIT_BUTTON && entry.isText(), () => this.#showEditDialog(menuItem));
    addAction(_('Preview'), 'image-x-generic-symbolic', SHOW_PREVIEW_BUTTON && entry.isImage(), () => this.#showImagePreview(entry));
    addAction(_('Tag'), 'user-bookmarks-symbolic', SHOW_TAG_BUTTON, () => this.#showTagDialog(menuItem));
    addAction(_('Delete'), 'edit-delete-symbolic', SHOW_DELETE_BUTTON, () => {
        if (menuItem.entry.isFavorite() && CONFIRM_ON_PINNED_DELETE)
            this._confirmRemovePinnedEntry(menuItem);
        else
            this._removeEntry(menuItem, 'delete');
    });

    return actionMenu;
}
```

- [ ] **Step 2: Replace inline buttons with the kebab button**

Inside `_addEntry()`, after the tag label block, keep the `actionsSpacer` if useful but remove all button creation code (`imagePreviewBtn`, `editBtn`, `icofavBtn`, `pasteBtn`, `tagBtn`, `icoBtn`). Replace it with a single block:

```javascript
menuItem.actionsSpacer = new St.Widget({ x_expand: true });
menuItem.actor.add_child(menuItem.actionsSpacer);

menuItem.moreBtn = new St.Button({
    style_class: 'ci-action-btn ci-more-btn',
    can_focus: true,
    accessible_name: _('More actions'),
    child: new St.Icon({
        icon_name: 'view-more-horizontal-symbolic',
        style_class: 'system-status-icon',
        icon_size: 14
    }),
    x_expand: false,
    y_align: Clutter.ActorAlign.CENTER,
    opacity: 0
});

menuItem.moreBtn.connect('clicked', () => {
    if (menuItem.actionMenu.isOpen)
        menuItem.actionMenu.close();
    else
        menuItem.actionMenu.open();
});

menuItem.actor.connect('notify::hover', () => {
    menuItem.moreBtn.opacity = menuItem.actor.hover ? 255 : 0;
});

menuItem.actor.add_child(menuItem.moreBtn);

menuItem.actionMenu = this.#buildItemActionMenu(menuItem, entry);
```

- [ ] **Step 3: Update settings-changed visibility logic**

In `_onSettingsChange()` (around line 1433-1441), replace the per-button visibility toggles with a call to refresh each action menu:

```javascript
this._getAllIMenuItems().forEach(mItem => {
    this._setEntryLabel(mItem);
    this.#refreshItemActionMenu(mItem);
});
```

Then add the helper:

```javascript
#refreshItemActionMenu(menuItem) {
    if (!menuItem.actionMenu) return;

    menuItem.actionMenu.destroy();
    menuItem.actionMenu = this.#buildItemActionMenu(menuItem, menuItem.entry);

    const hasVisibleActions = menuItem.actionMenu._getMenuItems().length > 0;
    menuItem.moreBtn.visible = hasVisibleActions;
}
```

- [ ] **Step 4: Remove obsolete button references**

Search `_onSettingsChange` for references to `pasteBtn`, `icoBtn`, `tagBtn`, `icofavBtn`, `editBtn`, `imagePreviewBtn` and delete those lines. Also remove `_cancelNotification` references to `previousClip.icoBtn` (around line 1269) — there will no longer be an `icoBtn`.

- [ ] **Step 5: Verify syntax**

```bash
gjs -c "import('file:///home/dopamide/Projects/gnome-shell-extension-clipboard-indicator/extension.js').then(() => print('ok')).catch(e => { print(e); quit(1); })"
```

Expected: no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add extension.js
git commit -m "feat(popup): replace inline action buttons with per-item dropdown"
```

---

### Task 4: Style the kebab button and dropdown items

**Files:**
- Modify: `stylesheet.css`

**Interfaces:**
- Consumes: `.ci-action-btn` and `.ci-more-btn` classes; `.clipboard-indicator-item-menu` class.
- Produces: styled kebab button with hover/focus visibility and a compact action dropdown.

- [ ] **Step 1: Add kebab button and action menu styles**

Append to `stylesheet.css`:

```css
.popup-menu-item .ci-more-btn {
    icon-size: 14px;
    margin-left: 8px;
    transition: opacity 150ms ease-in-out;
}

.popup-menu-item:hover .ci-more-btn,
.popup-menu-item.selected .ci-more-btn,
.popup-menu-item:focus .ci-more-btn {
    opacity: 255;
}

.clipboard-indicator-item-menu .popup-menu-content {
    border-radius: 8px;
    padding: 4px 0;
    background-color: rgba(40, 40, 40, 0.96);
}

.clipboard-indicator-item-menu .popup-menu-item {
    border-radius: 6px;
    margin: 1px 4px;
    padding: 6px 10px;
    transition: background-color 120ms ease-in-out;
}

.clipboard-indicator-item-menu .popup-menu-item:hover,
.clipboard-indicator-item-menu .popup-menu-item:focus {
    background-color: rgba(255, 255, 255, 0.1);
}
```

- [ ] **Step 2: Commit**

```bash
git add stylesheet.css
git commit -m "feat(popup): style kebab button and compact action dropdown"
```

---

### Task 5: Ensure action menus are destroyed with their items and clean up old references

**Files:**
- Modify: `extension.js:892-908`

**Interfaces:**
- Consumes: `_removeEntry()`.
- Produces: no leaked per-item `PopupMenu` actors.

- [ ] **Step 1: Destroy the per-item menu when the row is removed**

In `_removeEntry()` before `menuItem.destroy()`:

```javascript
if (menuItem.actionMenu) {
    menuItem.actionMenu.destroy();
    menuItem.actionMenu = null;
}
```

- [ ] **Step 2: Verify no remaining references to removed buttons**

Search the file:

```bash
grep -n "icoBtn\|icofavBtn\|pasteBtn\|tagBtn\|editBtn\|imagePreviewBtn" extension.js
```

Expected output: only definitions/helpers related to `#buildItemActionMenu`/`#refreshItemActionMenu`; no stale property reads in `_onSettingsChange`, `_cancelNotification`, etc. Fix any that remain.

- [ ] **Step 3: Commit**

```bash
git add extension.js
git commit -m "fix(popup): destroy per-item action menus with rows and remove stale button refs"
```

---

### Task 6: Document Blur my Shell compatibility

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: user-facing note about the CSS class `clipboard-indicator-popup`.

- [ ] **Step 1: Add a short section to README.md**

Find a sensible place (e.g. near installation or customization) and insert:

```markdown
### Blur my Shell support

The clipboard popup exposes the CSS class `clipboard-indicator-popup`.
If you use the [Blur my Shell](https://github.com/aunetx/blur-my-shell) extension,
you can add that class to its application list to get a blurred backdrop behind
this extension's popup.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): note Blur my Shell class compatibility"
```

---

## Self-review

- **Spec coverage check:**
  - Remove bulky buttons → Task 3.
  - Single "more" dropdown → Task 3.
  - Large image previews → Task 2.
  - Hidden scrollbar → Task 2.
  - Subtle animations → Tasks 1 & 4 (CSS transitions).
  - Blur my Shell compatibility → Tasks 1 & 6.
  - Preserve keyboard shortcuts → Task 3 keeps key handlers.
  - Preserve settings toggles → Task 3 maps toggles to dropdown items.
  - No schema changes → verified (no schema tasks).

- **Placeholder scan:** No TBD/TODO/fill-in-later strings.

- **Type consistency:** `menuItem.actionMenu` is always a `PopupMenu.PopupMenu`. `menuItem.moreBtn` is always an `St.Button`. Helpers `#buildItemActionMenu` and `#refreshItemActionMenu` operate on these properties consistently.

## Execution choice

Plan complete and saved to `docs/superpowers/plans/2026-08-03-clipboard-popup-revamp-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using batch execution with checkpoints.

Which approach?
