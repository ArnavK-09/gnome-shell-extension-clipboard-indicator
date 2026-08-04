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

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/ArnavK-09/gnome-shell-extension-clipboard-indicator.git
cd gnome-shell-extension-clipboard-indicator
```

### 2. Build & Install

#### Option A: Direct Install (Recommended)

Compile the schemas and locales, then install directly into `~/.local/share/gnome-shell/extensions/clipboard-indicator@tudmotu.com/`:

```bash
make install
```

#### Option B: Build as a ZIP Bundle

Compile and package the extension into `bundle.zip`:

```bash
make bundle
```

You can install the generated zip bundle with `gnome-extensions`:

```bash
gnome-extensions install --force bundle.zip
```

---

## Original

Based on the original work by Tudmotu: https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator
