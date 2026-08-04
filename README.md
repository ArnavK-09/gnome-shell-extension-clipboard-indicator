# Clipboard Indicator (Fork)

This is a fork of [clipboard-indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator) by Tudmotu, modified by **ArnavK-09** for personal use.

## What changed

- **Removed pin/favorite feature entirely** — no more pinning, no favorites section, no pinned-on-bottom toggle
- **Removed dropdown action menu** — the "more actions" (⋯) dropdown that was unreliable and auto-closed the popup has been replaced with inline icons
- **Inline delete button** — a small trash icon appears on the right side of each clipboard item on hover, with a circular hover highlight
- **Removed preview button from item menu** — image preview still available via keyboard shortcut (`h`)
- **Removed tag button from item menu** — tagging still available via keyboard shortcut (`t`)
- **Removed edit button from item menu** — editing still available via keyboard shortcut (`e`)
- **Removed paste button from item menu** — pasting still available via keyboard shortcut (`v`) or by selecting the item
- **Cleaned up dead code** from the old dropdown/pin system

Everything else (search, private mode, keyboard shortcuts, auto-clear, notifications, etc.) remains unchanged from the upstream extension.

## Install from source

```bash
$ git clone <repo-url> <extensions-dir>/clipboard-indicator@tudmotu.com
$ gnome-extensions enable clipboard-indicator@tudmotu.com
```

## Original

Based on the original work by Tudmotu: https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator