import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import * as AnimationUtils from "resource:///org/gnome/shell/misc/animationUtils.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

import { Registry, ClipboardEntry } from "./registry.js";
import { DialogManager } from "./confirmDialog.js";
import { PrefsFields } from "./constants.js";
import { Keyboard } from "./keyboard.js";

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const INDICATOR_ICON = "edit-paste-symbolic";

// Square box (logical px) that image thumbnails are aspect-fit into.
// Kept in sync with .clipboard-menu-img-preview / .clipboard-indicator-img-preview
// in stylesheet.css.
const MENU_IMG_PREVIEW_WIDTH = 96;
const MENU_IMG_PREVIEW_HEIGHT = 64;
const TOPBAR_IMG_PREVIEW_SIZE = 16;

let DELAYED_SELECTION_TIMEOUT = 750;
let MAX_REGISTRY_LENGTH = 15;
let MAX_ENTRY_LENGTH = 100;
let MOVE_ITEM_FIRST = false;
let ENABLE_KEYBINDING = true;
let PRIVATEMODE = false;
let NOTIFY_ON_COPY = true;
let NOTIFY_ON_CYCLE = true;
let NOTIFY_ON_CLEAR = true;
let CONFIRM_ON_CLEAR = true;
let MAX_TOPBAR_LENGTH = 15;
let TOPBAR_DISPLAY_MODE = 1; //0 - only icon, 1 - only clipboard content, 2 - both, 3 - neither
let CLEAR_ON_BOOT = false;
let PASTE_ON_SELECT = false;
let DISABLE_DOWN_ARROW = false;
let BLINK_ICON_ON_COPY = false;
let STRIP_TEXT = false;
let KEEP_SELECTED_ON_CLEAR = false;
let CACHE_IMAGES = true;
let EXCLUDED_APPS = [];
let CLEAR_HISTORY_ON_INTERVAL = false;
let CLEAR_HISTORY_INTERVAL = 60;
let NEXT_HISTORY_CLEAR = -1;
let CASE_SENSITIVE_SEARCH = false;
let REGEX_SEARCH = false;
let OPEN_AT_CURSOR = false;
let SHOW_SEARCH_BAR = true;
let SHOW_PRIVATE_MODE = true;
let SHOW_SETTINGS_BUTTON = true;
let SHOW_CLEAR_HISTORY_BUTTON = true;
let SHOW_DELETE_BUTTON = true;

export default class ClipboardIndicatorExtension extends Extension {
  enable() {
    this.clipboardIndicator = new ClipboardIndicator({
      clipboard: St.Clipboard.get_default(),
      settings: this.getSettings(),
      openSettings: this.openPreferences,
      uuid: this.uuid,
    });

    Main.panel.addToStatusArea(
      "clipboardIndicator",
      this.clipboardIndicator,
      1,
    );
  }

  disable() {
    this.clipboardIndicator.destroy();
    this.clipboardIndicator = null;
    EXCLUDED_APPS = [];
  }
}

const ClipboardIndicator = GObject.registerClass(
  {
    GTypeName: "ClipboardIndicator",
  },
  class ClipboardIndicator extends PanelMenu.Button {
    #refreshInProgress = false;
    #_imagePreviewOverlay = null;

    destroy() {
      this._destroyed = true;
      this._disconnectSettings();
      this._unbindShortcuts();
      this._disconnectSelectionListener();
      this._clearDelayedSelectionTimeout();
      this.#clearTimeouts();
      this.#closeImagePreview();
      this._removeHistoryLabel();
      this._destroyNotifSource();
      this.dialogManager.destroy();
      this.keyboard.destroy();
      this._cursorActor.destroy();
      this._cursorActor = null;

      super.destroy();
    }

    _init(extension) {
      super._init(0.0, "ClipboardIndicator");

      this._cursorActor = new Clutter.Actor({
        opacity: 0,
        width: 1,
        height: 1,
      });
      Main.uiGroup.add_child(this._cursorActor);

      // Keep the menu anchored to the top of the source actor so deleting items
      // (which shrinks the menu height) does not make the popup window jump.
      this.menu.setSourceAlignment(0.0);

      this.menu.connect("open-state-changed", (menu, isOpen) => {
        if (!isOpen) {
          this.menu.sourceActor = this;
        }
      });

      this.extension = extension;
      this._destroyed = false;
      this.registry = new Registry(extension);
      this.keyboard = new Keyboard();
      this._settingsChangedId = null;
      this._selectionOwnerChangedId = null;
      this._historyLabel = null;
      this._buttonText = null;
      this._disableDownArrow = null;

      this._shortcutsBindingIds = [];
      this.clipItemsRadioGroup = [];

      let hbox = new St.BoxLayout({
        style_class: "panel-status-menu-box clipboard-indicator-hbox",
      });

      this.hbox = hbox;

      this.icon = new St.Icon({
        icon_name: INDICATOR_ICON,
        style_class: "system-status-icon clipboard-indicator-icon",
      });

      this._buttonText = new St.Label({
        text: _("Text will be here"),
        y_align: Clutter.ActorAlign.CENTER,
      });

      this._buttonImgPreview = new St.Bin({
        style_class: "clipboard-indicator-topbar-preview",
      });

      hbox.add_child(this.icon);
      hbox.add_child(this._buttonText);
      hbox.add_child(this._buttonImgPreview);
      this._downArrow = PopupMenu.arrowIcon(St.Side.BOTTOM);
      hbox.add_child(this._downArrow);
      this.add_child(hbox);
      this._createHistoryLabel();
      this._loadSettings();

      if (CLEAR_ON_BOOT) this.registry.clearCacheFolder();

      this.dialogManager = new DialogManager();
      this._buildMenu().then(() => {
        if (this._destroyed) {
          return;
        }
        this._updateTopbarLayout();
        this._setupListener();
        this._setupHistoryIntervalClearing();
      });
    }

    #updateIndicatorContent(entry) {
      if (
        this.preventIndicatorUpdate ||
        (TOPBAR_DISPLAY_MODE !== 1 && TOPBAR_DISPLAY_MODE !== 2)
      ) {
        return;
      }

      if (!entry || PRIVATEMODE) {
        this._buttonImgPreview.destroy_all_children();
        this._buttonText.set_text("...");
      } else {
        if (entry.isText()) {
          this._buttonText.set_text(
            this._truncate(entry.getStringValue(), MAX_TOPBAR_LENGTH),
          );
          this._buttonImgPreview.destroy_all_children();
        } else if (entry.isImage()) {
          this._buttonText.set_text("");
          this._buttonImgPreview.destroy_all_children();

          this.registry.getEntryAsTexture(entry).then((texture) => {
            if (!texture || texture.is_destroyed?.()) return;

            this.#fitTexture(
              texture,
              TOPBAR_IMG_PREVIEW_SIZE,
              TOPBAR_IMG_PREVIEW_SIZE,
            );
            this._buttonImgPreview.set_child(texture);
          });
        }
      }
    }

    _blinkIcon() {
      if (!BLINK_ICON_ON_COPY || !this.icon) {
        return;
      }

      // Set inverted colors
      this.set_style("background-color: rgba(255, 255, 255, 0.9);");
      this.icon.set_style("color: rgba(0, 0, 0, 0.9);");

      // Revert back to normal after delay
      this._blinkAnimationTimeout = setTimeout(() => {
        this._blinkAnimationTimeout = null;
        this.set_style(null);
        this.icon.set_style(null);
      }, 200);
    }

    async _buildMenu() {
      const clipHistory = await this._getCache();
      if (this._destroyed) {
        return;
      }
      let lastIdx = clipHistory.length - 1;
      let clipItemsArr = this.clipItemsRadioGroup;

      /* This create the search entry, which is add to a menuItem.
        The searchEntry is connected to the function for research.
        The menu itself is connected to some shitty hack in order to
        grab the focus of the keyboard. */
      this._entryItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      this.searchEntry = new St.Entry({
        name: "searchEntry",
        style_class: "search-entry",
        can_focus: true,
        hint_text: _("Type here to search..."),
        track_hover: true,
        x_expand: true,
        y_expand: true,
        primary_icon: new St.Icon({ icon_name: "edit-find-symbolic" }),
      });

      this.searchEntry
        .get_clutter_text()
        .connect("text-changed", this._onSearchTextChanged.bind(this));

      this._entryItem.add_child(this.searchEntry);

      this.menu.connect("open-state-changed", (self, open) => {
        if (open && this.historyScrollView?.vscroll_adjustment) {
          this.historyScrollView.vscroll_adjustment.value = 0;
        }

        this._setFocusOnOpenTimeout = setTimeout(() => {
          if (!open) return;

          if (this._focusItemOnOpen) {
            const item = this._focusItemOnOpen;
            this._focusItemOnOpen = null;
            global.stage.set_key_focus(item.actor);
          } else if (SHOW_SEARCH_BAR && this.clipItemsRadioGroup.length > 0) {
            this.searchEntry.set_text("");
            global.stage.set_key_focus(this.searchEntry);
          } else if (this.clipItemsRadioGroup.length > 0) {
            const currentItem = this._getCurrentlySelectedItem();
            if (currentItem) global.stage.set_key_focus(currentItem.actor);
          } else if (SHOW_PRIVATE_MODE && this.privateModeMenuItem) {
            global.stage.set_key_focus(this.privateModeMenuItem.actor);
          }
        }, 50);
      });

      // Create menu sections for items
      // History
      this.historySection = new PopupMenu.PopupMenuSection();

      this.scrollViewMenuSection = new PopupMenu.PopupMenuSection();
      this.historyScrollView = new St.ScrollView({
        style_class: "ci-main-menu-section ci-history-menu-section",
        overlay_scrollbars: true,
      });
      this.historyScrollView.add_child(this.historySection.actor);

      this.scrollViewMenuSection.actor.add_child(this.historyScrollView);

      // Add separator
      this.historySeparator = new PopupMenu.PopupSeparatorMenuItem();

      this.menu.addMenuItem(this.scrollViewMenuSection);

      this.menu.box.add_style_class_name("clipboard-indicator-popup");
      this.menu.box.set_width(360);

      // Private mode switch
      this.privateModeMenuItem = new PopupMenu.PopupSwitchMenuItem(
        _("Private mode"),
        PRIVATEMODE,
        { reactive: true },
      );
      this.privateModeMenuItem.connect(
        "toggled",
        this._onPrivateModeSwitch.bind(this),
      );
      this.privateModeMenuItem.insert_child_at_index(
        new St.Icon({
          icon_name: "security-medium-symbolic",
          style_class: "clipboard-menu-icon",
          y_align: Clutter.ActorAlign.CENTER,
        }),
        0,
      );
      this.menu.addMenuItem(this.privateModeMenuItem);

      // Add 'Clear' button which removes all items from cache
      this.clearMenuItem = new PopupMenu.PopupMenuItem(_("Clear history"));
      this.clearMenuItem.insert_child_at_index(
        new St.Icon({
          icon_name: "user-trash-symbolic",
          style_class: "clipboard-menu-icon",
          y_align: Clutter.ActorAlign.CENTER,
        }),
        0,
      );

      let timerBox = new St.BoxLayout({
        x_align: Clutter.ActorAlign.END,
        x_expand: true,
      });

      this.timerLabel = new St.Label({
        text: "",
        style: "font-family: monospace;",
        x_align: Clutter.ActorAlign.END,
        x_expand: true,
      });

      this.resetTimerButton = new St.Button({
        style_class: "ci-action-btn",
        can_focus: true,
        accessible_name: _("Reset Timer"),
        child: new St.Icon({
          icon_name: "view-refresh-symbolic",
          style_class: "system-status-icon",
          icon_size: 14,
        }),
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      });

      this.resetTimerButton.connect("clicked", () => {
        this._scheduleNextHistoryClear();
      });

      timerBox.add_child(this.timerLabel);
      timerBox.add_child(this.resetTimerButton);
      this.clearMenuItem.add_child(timerBox);

      this.clearMenuItem.connect("activate", this._removeAll.bind(this));

      // Add 'Settings' menu item to open settings
      this.settingsMenuItem = new PopupMenu.PopupMenuItem(_("Settings"));
      this.settingsMenuItem.insert_child_at_index(
        new St.Icon({
          icon_name: "preferences-system-symbolic",
          style_class: "clipboard-menu-icon",
          y_align: Clutter.ActorAlign.CENTER,
        }),
        0,
      );
      this.settingsMenuItem.connect("activate", this._openSettings.bind(this));

      // Empty state section
      this.emptyStateSection = new St.BoxLayout({
        style_class: "clipboard-indicator-empty-state",
        vertical: true,
      });
      this.emptyStateSection.add_child(
        new St.Icon({
          icon_name: INDICATOR_ICON,
          style_class: "system-status-icon clipboard-indicator-icon",
          x_align: Clutter.ActorAlign.CENTER,
        }),
      );
      this.emptyStateSection.add_child(
        new St.Label({
          text: _("Clipboard is empty"),
          x_align: Clutter.ActorAlign.CENTER,
        }),
      );

      // Add cached items
      clipHistory.forEach((entry) => this._addEntry(entry));

      if (lastIdx >= 0) {
        this._selectMenuItem(clipItemsArr[lastIdx]);
      }

      this.#showElements();
    }

    #hideElements() {
      if (this._destroyed) {
        return;
      }
      if (this.menu.box.contains(this._entryItem))
        this.menu.box.remove_child(this._entryItem);
      if (this.menu.box.contains(this.historySeparator))
        this.menu.box.remove_child(this.historySeparator);
      if (
        this.clearMenuItem?.actor &&
        this.menu.box.contains(this.clearMenuItem.actor)
      )
        this.menu.box.remove_child(this.clearMenuItem.actor);
      if (
        this.settingsMenuItem?.actor &&
        this.menu.box.contains(this.settingsMenuItem.actor)
      )
        this.menu.box.remove_child(this.settingsMenuItem.actor);
      if (this.menu.box.contains(this.emptyStateSection))
        this.menu.box.remove_child(this.emptyStateSection);
    }

    #showElements() {
      if (this._destroyed) {
        return;
      }

      // Remove empty-state if items exist
      if (
        this.clipItemsRadioGroup.length > 0 &&
        this.menu.box.contains(this.emptyStateSection)
      ) {
        this.menu.box.remove_child(this.emptyStateSection);
      }

      // Search bar
      if (SHOW_SEARCH_BAR && !PRIVATEMODE) {
        if (!this.menu.box.contains(this._entryItem))
          this.menu.box.insert_child_at_index(this._entryItem, 0);
      } else {
        if (this.menu.box.contains(this._entryItem))
          this.menu.box.remove_child(this._entryItem);
      }

      // Keep the private-mode switch in place; only gate its visibility
      if (this.privateModeMenuItem?.actor) {
        this.privateModeMenuItem.actor.visible = SHOW_PRIVATE_MODE;
      }

      // History separator (between history and toggled buttons)
      if (
        this.clipItemsRadioGroup.length > 0 &&
        this.historySection._getMenuItems().length > 0 &&
        !PRIVATEMODE &&
        (SHOW_PRIVATE_MODE || SHOW_SETTINGS_BUTTON || SHOW_CLEAR_HISTORY_BUTTON)
      ) {
        if (!this.menu.box.contains(this.historySeparator))
          this.menu.box.insert_child_above(
            this.historySeparator,
            this.scrollViewMenuSection.actor,
          );
      } else if (this.menu.box.contains(this.historySeparator)) {
        this.menu.box.remove_child(this.historySeparator);
      }

      // If no items, render empty state and (if toggled on) only show Private/Settings
      if (this.clipItemsRadioGroup.length === 0) {
        if (!this.menu.box.contains(this.emptyStateSection))
          this.#renderEmptyState();
        // Re-append toggled buttons after the empty state
        if (this.menu.box.contains(this.settingsMenuItem?.actor))
          this.menu.box.remove_child(this.settingsMenuItem.actor);

        let index = this.menu.box.get_n_children(); // append after empty state
        if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
          this.menu.box.insert_child_at_index(
            this.settingsMenuItem.actor,
            index++,
          );
        return;
      }

      // Re-append toggled buttons at end in fixed order
      if (this.menu.box.contains(this.settingsMenuItem?.actor))
        this.menu.box.remove_child(this.settingsMenuItem.actor);
      if (this.menu.box.contains(this.clearMenuItem?.actor))
        this.menu.box.remove_child(this.clearMenuItem.actor);

      let index = this.menu.box.get_n_children(); // append
      if (SHOW_SETTINGS_BUTTON && this.settingsMenuItem)
        this.menu.box.insert_child_at_index(
          this.settingsMenuItem.actor,
          index++,
        );
      if (SHOW_CLEAR_HISTORY_BUTTON && this.clearMenuItem && !PRIVATEMODE)
        this.menu.box.insert_child_at_index(this.clearMenuItem.actor, index++);
    }

    #renderEmptyState() {
      if (this._destroyed) {
        return;
      }
      this.#hideElements();
      this.menu.box.insert_child_at_index(this.emptyStateSection, 0);
    }

    /* When text change, this function will check, for each item of the
    historySection, if it should be visible or not (based on words contained
    in the clipContents attribute of the item). It doesn't destroy or create
    items. It the entry is empty, the section is restored with all items
    set as visible. */
    _onSearchTextChanged() {
      // Text to be searched converted to lowercase if search is case insensitive
      let searchedText = this.searchEntry.get_text();
      if (!CASE_SENSITIVE_SEARCH) searchedText = searchedText.toLowerCase();

      if (searchedText === "") {
        this._getAllMenuItems().forEach(function (mItem) {
          mItem.actor.visible = true;
        });
      } else {
        this._getAllMenuItems().forEach((mItem) => {
          let text = mItem.clipContents;
          let tag = mItem.entry.getTag() || "";
          if (!CASE_SENSITIVE_SEARCH) {
            text = text.toLowerCase();
            tag = tag.toLowerCase();
          }

          let isMatching = false;
          if (REGEX_SEARCH) {
            const flags = "m" + (CASE_SENSITIVE_SEARCH ? "" : "i");
            const re = new RegExp(searchedText, flags);
            isMatching = re.test(text) || re.test(tag);
          } else {
            isMatching =
              text.includes(searchedText) || tag.includes(searchedText);
          }
          mItem.actor.visible = isMatching;
        });
      }
    }

    _truncate(string, length) {
      let shortened = string.replace(/\s+/g, " ");

      let chars = [...shortened];
      if (chars.length > length)
        shortened = chars.slice(0, length - 1).join("") + "...";

      return shortened;
    }

    _setEntryLabel(menuItem) {
      const { entry } = menuItem;
      if (entry.isText()) {
        menuItem.label.set_text(
          this._truncate(entry.getStringValue(), MAX_ENTRY_LENGTH),
        );
        menuItem.label.clutter_text.line_wrap = false;
        menuItem.label.clutter_text.ellipsize = 3;
      } else if (entry.isImage()) {
        this._renderImagePreview(menuItem);
      }
    }

    _renderImagePreview(menuItem) {
      this.registry
        .getEntryAsTexture(menuItem.entry)
        .then((texture) => {
          if (this._destroyed) return;
          if (!texture || texture.is_destroyed?.()) return;

          if (menuItem.previewImage) {
            menuItem.remove_child(menuItem.previewImage);
            menuItem.previewImage.destroy();
            menuItem.previewImage = null;
          }

          // Wrap the texture in a St.Bin with explicit dimensions so the
          // popup menu item actually allocates enough height/width for the
          // image to render. The texture itself uses content_gravity to
          // aspect-fit within the bin.
          const bin = new St.Bin({
            style_class: "clipboard-menu-img-preview",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
          });
          bin.set_size(MENU_IMG_PREVIEW_WIDTH, MENU_IMG_PREVIEW_HEIGHT);
          bin.set_child(texture);

          texture.content_gravity = Clutter.ContentGravity.SCALE_ASPECT_FIT;
          texture.set_size(MENU_IMG_PREVIEW_WIDTH, MENU_IMG_PREVIEW_HEIGHT);

          menuItem.previewImage = bin;
          menuItem.insert_child_below(bin, menuItem.label);
        })
        .catch((e) => {
          console.error("Clipboard Indicator: failed to load image preview", e);
        });
    }

    _findAdjacentMenuItem(currentMenuItem) {
      let currentIndex = this.clipItemsRadioGroup.indexOf(currentMenuItem);

      // for only one item
      if (this.clipItemsRadioGroup.length === 1) {
        return null;
      }

      // when focus is in middle of the displayed list
      for (let i = currentIndex - 1; i >= 0; i--) {
        let menuItem = this.clipItemsRadioGroup[i];
        if (menuItem.actor.visible) {
          return menuItem;
        }
      }

      // when focus is at the last element of the displayed list
      let beforeMenuItem = this.clipItemsRadioGroup[currentIndex + 1];
      if (beforeMenuItem.actor.visible) {
        return beforeMenuItem;
      }

      return null;
    }

    #selectNextMenuItem(menuItem) {
      let nextMenuItem = this._findAdjacentMenuItem(menuItem);

      if (nextMenuItem) {
        nextMenuItem.actor.grab_key_focus();
      } else if (this.privateModeMenuItem?.actor) {
        this.privateModeMenuItem.actor.grab_key_focus();
      }
    }

    _addEntry(entry, autoSelect, autoSetClip) {
      let menuItem = new PopupMenu.PopupMenuItem("");

      menuItem.menu = this.menu;
      menuItem.entry = entry;
      menuItem.clipContents = entry.getStringValue();
      menuItem.radioGroup = this.clipItemsRadioGroup;

      // CLICK fix for Paste on Select: clicking behaves like Enter
      menuItem.connect("activate", () => {
        if (PASTE_ON_SELECT) {
          this.#pasteItem(menuItem);
          this._onMenuItemSelectedAndMenuClose(menuItem, false);
        } else {
          this._onMenuItemSelectedAndMenuClose(menuItem, true);
        }
      });

      menuItem.connect("key-focus-in", () => {
        AnimationUtils.ensureActorVisibleInScrollView(
          this.historyScrollView,
          menuItem,
        );
      });
      menuItem.actor.connect("key-press-event", (actor, event) => {
        switch (event.get_key_symbol()) {
          case Clutter.KEY_Delete:
            this.#selectNextMenuItem(menuItem);
            this._removeEntry(menuItem, "delete");
            return Clutter.EVENT_STOP;
          case Clutter.KEY_v:
            this.#pasteItem(menuItem);
            return Clutter.EVENT_STOP;
          case Clutter.KEY_h:
            if (entry.isImage()) {
              this.#showImagePreview(entry, () => {
                this._focusItemOnOpen = menuItem;
                this.menu.open();
              });
              return Clutter.EVENT_STOP;
            }
            break;
          case Clutter.KEY_e:
            if (entry.isText()) {
              this.#showEditDialog(menuItem, true);
              return Clutter.EVENT_STOP;
            }
            break;
          case Clutter.KEY_t:
            this.#showTagDialog(menuItem, true);
            return Clutter.EVENT_STOP;
          case Clutter.KEY_KP_Enter:
          case Clutter.KEY_Return:
            if (PASTE_ON_SELECT) {
              this.#pasteItem(menuItem);
              this._onMenuItemSelectedAndMenuClose(menuItem, false);
            } else {
              this._onMenuItemSelectedAndMenuClose(menuItem, true);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      this._setEntryLabel(menuItem);
      this.clipItemsRadioGroup.push(menuItem);

      if (entry.getTag()) {
        menuItem.tagLabel = new St.Label({
          text: entry.getTag(),
          style_class: "ci-tag-label",
          y_align: Clutter.ActorAlign.CENTER,
        });
        menuItem.actor.add_child(menuItem.tagLabel);
      }

      menuItem.actionsSpacer = new St.Widget({
        x_expand: true,
      });
      menuItem.actor.add_child(menuItem.actionsSpacer);

      menuItem.deleteBtn = new St.Button({
        style_class: "ci-action-btn ci-delete-btn",
        can_focus: true,
        accessible_name: _("Delete"),
        child: new St.Icon({
          icon_name: "user-trash-symbolic",
          icon_size: 14,
          x_align: Clutter.ActorAlign.CENTER,
          y_align: Clutter.ActorAlign.CENTER,
        }),
        x_expand: false,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
        visible: SHOW_DELETE_BUTTON,
        opacity: 0,
      });

      menuItem.deleteBtn.connect("clicked", () => {
        this._removeEntry(menuItem, "delete");
      });

      menuItem.actor.add_child(menuItem.deleteBtn);

      menuItem.actor.connect("notify::hover", () => {
        if (menuItem.deleteBtn) {
          menuItem.deleteBtn.opacity = menuItem.actor.hover ? 255 : 0;
        }
      });

      this.historySection.addMenuItem(menuItem, 0);

      if (autoSelect === true) {
        this._selectMenuItem(menuItem, autoSetClip);
      }

      this.#showElements();
    }

    _confirmRemoveAll() {
      const title = _("Clear all?");
      const message = _("Are you sure you want to delete all clipboard items?");
      const sub_message = _("This operation cannot be undone.");

      this.dialogManager.open(
        title,
        message,
        sub_message,
        _("Clear"),
        _("Cancel"),
        () => {
          this._clearHistory();
        },
      );
    }

    _clearHistory(invokedAutomatically = false) {
      this.historySection._getMenuItems().forEach((mItem) => {
        if (KEEP_SELECTED_ON_CLEAR === false || !mItem.currentlySelected) {
          this._removeEntry(mItem, "delete");
        }
      });

      if (NOTIFY_ON_CLEAR) {
        const message = invokedAutomatically
          ? _("Clipboard history cleared automatically")
          : _("Clipboard history cleared");
        this._showNotification(message);
      }
    }

    _removeAll() {
      if (PRIVATEMODE) return;

      if (CONFIRM_ON_CLEAR) {
        this._confirmRemoveAll();
      } else {
        this._clearHistory();
      }
    }

    _removeEntry(menuItem, event) {
      let itemIdx = this.clipItemsRadioGroup.indexOf(menuItem);

      if (itemIdx === -1) {
        console.error(
          "Clipboard Indicator: tried to remove a menuItem that is not in clipItemsRadioGroup",
        );
        return;
      }

      if (event === "delete" && menuItem.currentlySelected) {
        this.#clearClipboard();
      }

      menuItem.destroy();
      this.clipItemsRadioGroup.splice(itemIdx, 1);

      if (menuItem.entry.isImage()) {
        this.registry.deleteEntryFile(menuItem.entry);
      }

      this._updateCache();
      this.#showElements();
    }

    _removeOldestEntries() {
      while (this.clipItemsRadioGroup.length > MAX_REGISTRY_LENGTH) {
        // Do not shift the item out manually; _removeEntry handles the splice
        // so clipItemsRadioGroup and the visual menu stay in sync.
        let oldest = this.clipItemsRadioGroup[0];
        this._removeEntry(oldest);
      }
    }

    _onMenuItemSelected(menuItem, autoSet) {
      for (let otherMenuItem of menuItem.radioGroup) {
        if (otherMenuItem === menuItem && menuItem.clipContents) {
          menuItem.currentlySelected = true;
          if (autoSet !== false) this.#updateClipboard(menuItem.entry);
        } else {
          otherMenuItem.currentlySelected = false;
        }
      }
    }

    _selectMenuItem(menuItem, autoSet) {
      this._onMenuItemSelected(menuItem, autoSet);
      this.#updateIndicatorContent(menuItem.entry);
    }

    _onMenuItemSelectedAndMenuClose(menuItem, autoSet) {
      const selectedIdx = this.clipItemsRadioGroup.indexOf(menuItem);
      console.log(
        "Clipboard Indicator: selected item at index",
        selectedIdx,
        "contents:",
        menuItem.clipContents,
      );

      this._onMenuItemSelected(menuItem, autoSet);

      // Ensure MOVE_ITEM_FIRST also applies when PASTE_ON_SELECT fast-path skips _refreshIndicator()
      if (PASTE_ON_SELECT && MOVE_ITEM_FIRST) {
        this._moveItemFirst(menuItem);
      }

      menuItem.menu.close();
    }

    _getCache() {
      return this.registry.read();
    }

    #addToCache(entry) {
      const entries = this.clipItemsRadioGroup
        .map((menuItem) => menuItem.entry)
        .concat([entry]);
      this.registry.write(entries);
    }

    _updateCache() {
      const entries = this.clipItemsRadioGroup.map(
        (menuItem) => menuItem.entry,
      );

      this.registry.write(entries);
    }

    async _onSelectionChange(selection, selectionType, selectionSource) {
      if (selectionType === Meta.SelectionType.SELECTION_CLIPBOARD) {
        this._refreshIndicator();
      }
    }

    async _refreshIndicator() {
      if (PRIVATEMODE || this._destroyed) return; // Private mode, do not.

      const focussedWindow = Shell.Global.get().display.focusWindow;
      const wmClass = focussedWindow?.get_wm_class();

      if (wmClass && EXCLUDED_APPS.includes(wmClass)) return; // Excluded app, do not.

      if (this.#refreshInProgress) return;
      this.#refreshInProgress = true;

      try {
        const result = await this.#getClipboardContent();
        if (this._destroyed) {
          return;
        }

        if (result) {
          for (let menuItem of this.clipItemsRadioGroup) {
            if (menuItem.entry.equals(result)) {
              this._selectMenuItem(menuItem, false);

              if (MOVE_ITEM_FIRST) {
                this._moveItemFirst(menuItem);
              }

              return;
            }
          }

          this.#addToCache(result);
          this._addEntry(result, true, false);
          this._removeOldestEntries();
          if (NOTIFY_ON_COPY) {
            this._showNotification(_("Copied to clipboard"), (notif) => {
              notif.addAction(_("Cancel"), this._cancelNotification);
            });
          }
          this._blinkIcon();
        }
      } catch (e) {
        console.error("Clipboard Indicator: Failed to refresh indicator");
        console.error(e);
      } finally {
        this.#refreshInProgress = false;
      }
    }

    _moveItemFirst(item) {
      const idx = this.clipItemsRadioGroup.indexOf(item);
      if (idx === -1) return;
      this.clipItemsRadioGroup.splice(idx, 1);
      this.clipItemsRadioGroup.push(item);
      this.historySection.addMenuItem(item, 0);
      this._updateCache();
    }

    _getCurrentlySelectedItem() {
      return this.clipItemsRadioGroup.find((item) => item.currentlySelected);
    }

    _getAllMenuItems() {
      return this.historySection._getMenuItems();
    }

    _setupListener() {
      const metaDisplay = Shell.Global.get().get_display();
      const selection = metaDisplay.get_selection();
      this._setupSelectionTracking(selection);
    }

    _setupSelectionTracking(selection) {
      this.selection = selection;
      this._selectionOwnerChangedId = selection.connect(
        "owner-changed",
        (selection, selectionType, selectionSource) => {
          this._onSelectionChange(selection, selectionType, selectionSource);
        },
      );
    }

    _setupHistoryIntervalClearing() {
      this._fetchSettings();

      if (this._intervalSettingChangedId) {
        this.extension.settings.disconnect(this._intervalSettingChangedId);
        this._intervalSettingChangedId = null;
      }
      if (this._intervalToggleChangedId) {
        this.extension.settings.disconnect(this._intervalToggleChangedId);
        this._intervalToggleChangedId = null;
      }
      if (this._historyClearTimeoutId) {
        clearTimeout(this._historyClearTimeoutId);
        this._historyClearTimeoutId = null;
      }

      this._intervalSettingChangedId = this.extension.settings.connect(
        `changed::${PrefsFields.CLEAR_HISTORY_INTERVAL}`,
        this._onHistoryIntervalClearSettingsChanged.bind(this),
      );
      this._intervalToggleChangedId = this.extension.settings.connect(
        `changed::${PrefsFields.CLEAR_HISTORY_ON_INTERVAL}`,
        this._onHistoryIntervalClearSettingsChanged.bind(this),
      );

      if (!CLEAR_HISTORY_ON_INTERVAL) {
        this._updateIntervalTimer();
        return;
      }

      const currentTime = Math.ceil(new Date().getTime() / 1000);

      if (NEXT_HISTORY_CLEAR === -1) {
        //new timer
        this._scheduleNextHistoryClear();
      } else if (NEXT_HISTORY_CLEAR < currentTime) {
        //timer expired
        this._clearHistory(true);
        this._scheduleNextHistoryClear();
      } else {
        //timer already set, but not expired
        // Clean up existing timers before reassigning
        if (this._historyClearTimeoutId) {
          clearTimeout(this._historyClearTimeoutId);
          this._historyClearTimeoutId = null;
        }
        if (this._timerIntervalId) {
          clearInterval(this._timerIntervalId);
          this._timerIntervalId = null;
        }

        const timeoutMs = (NEXT_HISTORY_CLEAR - currentTime) * 1000;
        this._historyClearTimeoutId = setTimeout(() => {
          this._clearHistory(true);
          this._scheduleNextHistoryClear();
        }, timeoutMs);
        this._timerIntervalId = setInterval(() => {
          this._updateIntervalTimer();
        }, 1000);
      }
    }

    _onHistoryIntervalClearSettingsChanged(_settings, key) {
      this._fetchSettings();
      if (key === PrefsFields.CLEAR_HISTORY_INTERVAL) {
        this._scheduleNextHistoryClear();
      } else if (key === PrefsFields.CLEAR_HISTORY_ON_INTERVAL) {
        if (CLEAR_HISTORY_ON_INTERVAL) {
          this._resetHistoryClearTimer();
          this._setupHistoryIntervalClearing();
        } else {
          this._resetHistoryClearTimer();
        }
      }
    }

    _scheduleNextHistoryClear() {
      this._fetchSettings();

      clearInterval(this._timerIntervalId);
      if (this._historyClearTimeoutId) {
        clearTimeout(this._historyClearTimeoutId);
        this._historyClearTimeoutId = null;
      }

      if (!CLEAR_HISTORY_ON_INTERVAL) {
        this._resetHistoryClearTimer();
        return;
      }

      const currentTime = Math.ceil(new Date().getTime() / 1000);
      NEXT_HISTORY_CLEAR = currentTime + CLEAR_HISTORY_INTERVAL * 60;
      const timeoutMs = (NEXT_HISTORY_CLEAR - currentTime) * 1000;

      this.extension.settings.set_int(
        PrefsFields.NEXT_HISTORY_CLEAR,
        NEXT_HISTORY_CLEAR,
      );

      this._updateIntervalTimer();
      this._timerIntervalId = setInterval(() => {
        this._updateIntervalTimer();
      }, 1000);

      this._historyClearTimeoutId = setTimeout(() => {
        this._clearHistory(true);
        this._scheduleNextHistoryClear();
      }, timeoutMs);
    }

    _resetHistoryClearTimer() {
      //basically just reset and stop the timer
      if (this._historyClearTimeoutId) {
        clearTimeout(this._historyClearTimeoutId);
        this._historyClearTimeoutId = null;
      }
      clearInterval(this._timerIntervalId);
      this._timerIntervalId = null;
      this._updateIntervalTimer();
      this.extension.settings.set_int(PrefsFields.NEXT_HISTORY_CLEAR, -1);
    }

    _updateIntervalTimer() {
      this._fetchSettings();
      this.resetTimerButton.visible = CLEAR_HISTORY_ON_INTERVAL;
      this.timerLabel.visible = CLEAR_HISTORY_ON_INTERVAL;
      if (!CLEAR_HISTORY_ON_INTERVAL) return;

      let currentTime = Math.ceil(new Date().getTime() / 1000);
      let timeLeft = NEXT_HISTORY_CLEAR - currentTime;

      if (timeLeft <= 0) {
        this.timerLabel.set_text("");
        return;
      }

      let hours = Math.floor(timeLeft / 3600);
      let minutes = Math.floor((timeLeft % 3600) / 60);
      let seconds = Math.floor(timeLeft % 60);

      let formattedTime = "";
      if (hours > 0) {
        formattedTime += `${hours}h `;
      }
      if (minutes > 0) {
        formattedTime += `${minutes}m `;
      }
      formattedTime += `${seconds}s`;
      this.timerLabel.set_text(formattedTime);
    }

    _openSettings() {
      this.extension.openSettings();
      this.menu.close();
    }

    _initNotifSource() {
      if (!this._notifSource) {
        this._notifSource = new MessageTray.Source({
          title: "Clipboard Indicator",
          "icon-name": INDICATOR_ICON,
        });

        this._notifSource.connect("destroy", () => {
          this._notifSource = null;
        });

        Main.messageTray.add(this._notifSource);
      }
    }

    _destroyNotifSource() {
      if (this._notifSource) {
        this._notifSource.destroy();
        this._notifSource = null;
      }
    }

    _cancelNotification() {
      if (this.clipItemsRadioGroup.length >= 2) {
        let clipSecond = this.clipItemsRadioGroup.length - 2;
        let previousClip = this.clipItemsRadioGroup[clipSecond];
        this.#updateClipboard(previousClip.entry);
        previousClip.currentlySelected = true;
      } else {
        this.#clearClipboard();
      }
      this._removeEntry(
        this.clipItemsRadioGroup[this.clipItemsRadioGroup.length - 1],
      );
    }

    _showNotification(message, transformFn) {
      const dndOn = () => {
        try {
          return !Main.panel.statusArea.dateMenu._indicator._settings.get_boolean(
            "show-banners",
          );
        } catch (e) {
          return false;
        }
      };
      if (PRIVATEMODE || dndOn()) {
        return;
      }

      let notification = null;

      this._initNotifSource();

      if (this._notifSource.count === 0) {
        notification = new MessageTray.Notification({
          source: this._notifSource,
          body: message,
          "is-transient": true,
        });
      } else {
        notification = this._notifSource.notifications[0];
        notification.body = message;
        notification.clearActions();
      }

      if (typeof transformFn === "function") {
        transformFn(notification);
      }

      this._notifSource.addNotification(notification);
    }

    _createHistoryLabel() {
      this._historyLabel = new St.Label({
        style_class: "ci-notification-label",
        text: "",
      });

      global.stage.add_child(this._historyLabel);

      this._historyLabel.hide();
    }

    _removeHistoryLabel() {
      if (this._historyLabel) {
        if (this._historyLabel.get_parent()) {
          global.stage.remove_child(this._historyLabel);
        }
        this._historyLabel.destroy();
        this._historyLabel = null;
      }
    }

    togglePrivateMode() {
      this.privateModeMenuItem.toggle();
    }

    _onPrivateModeSwitch() {
      PRIVATEMODE = this.privateModeMenuItem.state;
      // We hide the history in private ModeTypee because it will be out of sync (selected item will not reflect clipboard)
      this.scrollViewMenuSection.actor.visible = !PRIVATEMODE;
      // If we get out of private mode then we restore the clipboard to old state
      if (!PRIVATEMODE) {
        let selectList = this.clipItemsRadioGroup.filter(
          (item) => !!item.currentlySelected,
        );

        if (selectList.length) {
          this._selectMenuItem(selectList[0]);
        } else {
          // Nothing to return to, let's empty it instead
          this.#clearClipboard();
        }

        this.#getClipboardContent()
          .then((entry) => {
            if (!entry) return;
            this.#updateIndicatorContent(entry);
          })
          .catch((e) => console.error(e));

        this.hbox.remove_style_class_name("private-mode");
        this.#showElements();
      } else {
        this.hbox.add_style_class_name("private-mode");
        this.#updateIndicatorContent(null);
        this.#showElements();
      }
    }

    _loadSettings() {
      this._settingsChangedId = this.extension.settings.connect(
        "changed",
        this._onSettingsChange.bind(this),
      );

      this._fetchSettings();

      if (ENABLE_KEYBINDING) this._bindShortcuts();
    }

    _fetchSettings() {
      const { settings } = this.extension;
      MAX_REGISTRY_LENGTH = settings.get_int(PrefsFields.HISTORY_SIZE);
      MAX_ENTRY_LENGTH = settings.get_int(PrefsFields.PREVIEW_SIZE);
      MOVE_ITEM_FIRST = settings.get_boolean(PrefsFields.MOVE_ITEM_FIRST);
      NOTIFY_ON_COPY = settings.get_boolean(PrefsFields.NOTIFY_ON_COPY);
      NOTIFY_ON_CYCLE = settings.get_boolean(PrefsFields.NOTIFY_ON_CYCLE);
      NOTIFY_ON_CLEAR = settings.get_boolean(PrefsFields.NOTIFY_ON_CLEAR);
      CONFIRM_ON_CLEAR = settings.get_boolean(PrefsFields.CONFIRM_ON_CLEAR);
      ENABLE_KEYBINDING = settings.get_boolean(PrefsFields.ENABLE_KEYBINDING);
      MAX_TOPBAR_LENGTH = settings.get_int(PrefsFields.TOPBAR_PREVIEW_SIZE);
      TOPBAR_DISPLAY_MODE = settings.get_int(
        PrefsFields.TOPBAR_DISPLAY_MODE_ID,
      );
      CLEAR_ON_BOOT = settings.get_boolean(PrefsFields.CLEAR_ON_BOOT);
      PASTE_ON_SELECT = settings.get_boolean(PrefsFields.PASTE_ON_SELECT);
      DISABLE_DOWN_ARROW = settings.get_boolean(PrefsFields.DISABLE_DOWN_ARROW);
      BLINK_ICON_ON_COPY = settings.get_boolean(PrefsFields.BLINK_ICON_ON_COPY);
      STRIP_TEXT = settings.get_boolean(PrefsFields.STRIP_TEXT);
      KEEP_SELECTED_ON_CLEAR = settings.get_boolean(
        PrefsFields.KEEP_SELECTED_ON_CLEAR,
      );
      CACHE_IMAGES = settings.get_boolean(PrefsFields.CACHE_IMAGES);
      EXCLUDED_APPS = settings.get_strv(PrefsFields.EXCLUDED_APPS);
      CLEAR_HISTORY_ON_INTERVAL = settings.get_boolean(
        PrefsFields.CLEAR_HISTORY_ON_INTERVAL,
      );
      CLEAR_HISTORY_INTERVAL = settings.get_int(
        PrefsFields.CLEAR_HISTORY_INTERVAL,
      );
      NEXT_HISTORY_CLEAR = settings.get_int(PrefsFields.NEXT_HISTORY_CLEAR);
      CASE_SENSITIVE_SEARCH = settings.get_boolean(
        PrefsFields.CASE_SENSITIVE_SEARCH,
      );
      REGEX_SEARCH = settings.get_boolean(PrefsFields.REGEX_SEARCH);
      OPEN_AT_CURSOR = settings.get_boolean(PrefsFields.OPEN_AT_CURSOR);
      SHOW_SEARCH_BAR = settings.get_boolean(PrefsFields.SHOW_SEARCH_BAR);
      SHOW_PRIVATE_MODE = settings.get_boolean(PrefsFields.SHOW_PRIVATE_MODE);
      SHOW_SETTINGS_BUTTON = settings.get_boolean(
        PrefsFields.SHOW_SETTINGS_BUTTON,
      );
      SHOW_CLEAR_HISTORY_BUTTON = settings.get_boolean(
        PrefsFields.SHOW_CLEAR_HISTORY_BUTTON,
      );
      SHOW_DELETE_BUTTON = settings.get_boolean(PrefsFields.SHOW_DELETE_BUTTON);
    }

    async _onSettingsChange(settings, key) {
      try {
        // Load the settings into variables
        this._fetchSettings();

        // If the toggle is hidden but private mode is on, force it off now
        if (!SHOW_PRIVATE_MODE && PRIVATEMODE && this.privateModeMenuItem) {
          this.privateModeMenuItem.setToggleState(false);
          this._onPrivateModeSwitch();
        }

        // Remove old entries in case the registry size changed
        this._removeOldestEntries();

        // Re-set menu-items labels in case preview size changed
        this._getAllMenuItems().forEach((mItem) => {
          this._setEntryLabel(mItem);
          if (mItem.deleteBtn) mItem.deleteBtn.visible = SHOW_DELETE_BUTTON;
        });

        //update topbar
        this._updateTopbarLayout();
        this.#updateIndicatorContent(await this.#getClipboardContent());

        // Only rebind shortcuts when a shortcut-related key changes
        const shortcutKeys = [
          PrefsFields.ENABLE_KEYBINDING,
          PrefsFields.BINDING_TOGGLE_MENU,
          PrefsFields.BINDING_CLEAR_HISTORY,
          PrefsFields.BINDING_PREV_ENTRY,
          PrefsFields.BINDING_NEXT_ENTRY,
          PrefsFields.BINDING_PRIVATE_MODE,
        ];
        if (!key || shortcutKeys.includes(key)) {
          if (ENABLE_KEYBINDING) this._bindShortcuts();
          else this._unbindShortcuts();
        }

        // Respect UI toggles
        this.#showElements();
      } catch (e) {
        console.error("Clipboard Indicator: Failed to update registry");
        console.error(e);
      }
    }

    _bindShortcuts() {
      this._unbindShortcuts();
      this._bindShortcut(PrefsFields.BINDING_CLEAR_HISTORY, this._removeAll);
      this._bindShortcut(PrefsFields.BINDING_PREV_ENTRY, this._previousEntry);
      this._bindShortcut(PrefsFields.BINDING_NEXT_ENTRY, this._nextEntry);
      this._bindShortcut(PrefsFields.BINDING_TOGGLE_MENU, this._toggleMenu);
      this._bindShortcut(
        PrefsFields.BINDING_PRIVATE_MODE,
        this.togglePrivateMode,
      );
    }

    _unbindShortcuts() {
      this._shortcutsBindingIds.forEach((id) => Main.wm.removeKeybinding(id));

      this._shortcutsBindingIds = [];
    }

    _bindShortcut(name, cb) {
      Main.wm.addKeybinding(
        name,
        this.extension.settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.ALL,
        cb.bind(this),
      );

      this._shortcutsBindingIds.push(name);
    }

    _updateTopbarLayout() {
      if (TOPBAR_DISPLAY_MODE === 0) {
        this.icon.visible = true;
        this._buttonText.visible = false;
        this._buttonImgPreview.visible = false;
        this.show();
      } else if (TOPBAR_DISPLAY_MODE === 1) {
        this.icon.visible = false;
        this._buttonText.visible = true;
        this._buttonImgPreview.visible = true;
        this.show();
      } else if (TOPBAR_DISPLAY_MODE === 2) {
        this.icon.visible = true;
        this._buttonText.visible = true;
        this._buttonImgPreview.visible = true;
        this.show();
      } else if (TOPBAR_DISPLAY_MODE === 3) {
        this.hide();
      }
      if (!DISABLE_DOWN_ARROW) {
        this._downArrow.visible = true;
      } else {
        this._downArrow.visible = false;
      }
    }

    _disconnectSettings() {
      if (!this._settingsChangedId) return;

      this.extension.settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = null;

      if (this._intervalSettingChangedId) {
        this.extension.settings.disconnect(this._intervalSettingChangedId);
        this._intervalSettingChangedId = null;
      }

      if (this._intervalToggleChangedId) {
        this.extension.settings.disconnect(this._intervalToggleChangedId);
        this._intervalToggleChangedId = null;
      }

      if (this._historyClearTimeoutId) {
        clearTimeout(this._historyClearTimeoutId);
        this._historyClearTimeoutId = null;
      }
    }

    _disconnectSelectionListener() {
      if (!this._selectionOwnerChangedId) return;

      this.selection.disconnect(this._selectionOwnerChangedId);
    }

    _clearDelayedSelectionTimeout() {
      if (this._delayedSelectionTimeoutId) {
        clearTimeout(this._delayedSelectionTimeoutId);
      }
    }

    _selectEntryWithDelay(entry) {
      this._selectMenuItem(entry, false);

      this._delayedSelectionTimeoutId = setTimeout(() => {
        this._selectMenuItem(entry); //select the item
        this._delayedSelectionTimeoutId = null;
      }, DELAYED_SELECTION_TIMEOUT);
    }

    #cycleEntry(direction) {
      if (PRIVATEMODE) return;

      this._clearDelayedSelectionTimeout();

      this._getAllMenuItems().some((mItem, i, menuItems) => {
        if (mItem.currentlySelected) {
          i += direction;
          if (i < 0) i = menuItems.length - 1;
          if (i >= menuItems.length) i = 0;

          if (NOTIFY_ON_CYCLE) {
            this._showNotification(
              i +
                1 +
                " / " +
                menuItems.length +
                ": " +
                menuItems[i].entry.getStringValue(),
            );
          }
          if (MOVE_ITEM_FIRST) {
            this._selectEntryWithDelay(menuItems[i]);
          } else {
            this._selectMenuItem(menuItems[i]);
          }
          return true;
        }
        return false;
      });
    }

    _previousEntry() {
      this.#cycleEntry(-1);
    }

    _nextEntry() {
      this.#cycleEntry(1);
    }

    _toggleMenu() {
      if (!this.menu.isOpen && OPEN_AT_CURSOR) {
        const [x, y] = global.get_pointer();
        this._cursorActor.set_position(x, y);
        this.menu.sourceActor = this._cursorActor;
      }
      this.menu.toggle();
    }

    #pasteItem(menuItem) {
      const pastedIdx = this.clipItemsRadioGroup.indexOf(menuItem);
      console.log(
        "Clipboard Indicator: pasting item at index",
        pastedIdx,
        "contents:",
        menuItem.clipContents,
      );

      this.menu.close();
      this.preventIndicatorUpdate = true;
      this.#updateClipboard(menuItem.entry);
      this._pastingKeypressTimeout = setTimeout(() => {
        if (this.keyboard.purpose === Clutter.InputContentPurpose.TERMINAL) {
          this.keyboard.press(Clutter.KEY_Control_L);
          this.keyboard.press(Clutter.KEY_Shift_L);
          this.keyboard.press(Clutter.KEY_Insert);
          this.keyboard.release(Clutter.KEY_Insert);
          this.keyboard.release(Clutter.KEY_Shift_L);
          this.keyboard.release(Clutter.KEY_Control_L);
        } else {
          this.keyboard.press(Clutter.KEY_Shift_L);
          this.keyboard.press(Clutter.KEY_Insert);
          this.keyboard.release(Clutter.KEY_Insert);
          this.keyboard.release(Clutter.KEY_Shift_L);
        }

        this._pastingResetTimeout = setTimeout(() => {
          this.preventIndicatorUpdate = false;
        }, 50);
      }, 50);
    }

    // Scale a texture produced by St.TextureCache.load_file_async() so its
    // content is drawn at an aspect-fit size within maxW x maxH.
    //
    // We rely on the texture having content_gravity = SCALE_ASPECT_FIT plus
    // an explicit size set by the caller. We do NOT read get_preferred_width
    // here because for an async-loaded texture those values are 0 until the
    // image content is fully decoded, and the timing of the
    // "notify::content" signal is not reliable. Callers must set the size on
    // the actor themselves.
    #fitTexture(texture, maxW, maxH) {
      if (!texture || texture.is_destroyed?.()) return;
      try {
        texture.content_gravity = Clutter.ContentGravity.SCALE_ASPECT_FIT;
        texture.set_size(maxW, maxH);
      } catch (e) {
        console.warn("Clipboard Indicator: #fitTexture failed", e);
      }
    }

    #showImagePreview(entry, onClose = null) {
      this.#closeImagePreview();
      this.menu.close();

      const monitor = Main.layoutManager.currentMonitor;

      const overlay = new St.Widget({
        reactive: true,
        can_focus: true,
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
        style: "background-color: rgba(0, 0, 0, 0.75);",
      });

      this.#_imagePreviewOverlay = overlay;
      global.stage.add_child(overlay);
      overlay.grab_key_focus();

      const close = () => {
        this.#closeImagePreview();
        if (onClose) onClose();
      };

      overlay._previewClickId = overlay.connect("button-press-event", () => {
        close();
        return Clutter.EVENT_STOP;
      });

      overlay._previewKeyId = overlay.connect(
        "key-press-event",
        (_actor, event) => {
          if (event.get_key_symbol() === Clutter.KEY_Escape) {
            close();
            return Clutter.EVENT_STOP;
          }
          return Clutter.EVENT_PROPAGATE;
        },
      );

      const maxW = Math.floor(monitor.width * 0.5);
      const maxH = Math.floor(monitor.height * 0.4);

      const bin = new St.Bin({
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      bin.add_constraint(
        new Clutter.AlignConstraint({
          source: overlay,
          align_axis: Clutter.AlignAxis.X_AXIS,
          factor: 0.5,
        }),
      );
      bin.add_constraint(
        new Clutter.AlignConstraint({
          source: overlay,
          align_axis: Clutter.AlignAxis.Y_AXIS,
          factor: 0.5,
        }),
      );
      overlay.add_child(bin);

      this.registry
        .getEntryAsTexture(entry)
        .then((actor) => {
          if (this.#_imagePreviewOverlay !== overlay) return;
          if (!actor || actor.is_destroyed()) return;

          bin.set_child(actor);
          this.#fitTexture(actor, maxW, maxH);
        })
        .catch((e) => {
          console.error("Clipboard Indicator: failed to load image preview");
          console.error(e);
        });
    }

    #showTagDialog(menuItem, reopenOnClose = false) {
      const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

      const onDialogClose = () => {
        if (reopenOnClose) {
          this._focusItemOnOpen = menuItem;
          this.menu.open();
        }
      };

      const textEntry = new St.Entry({
        text: menuItem.entry.getTag() || "",
        hint_text: _("Enter tag…"),
        can_focus: true,
        x_expand: true,
        style: "min-width: 300px;",
      });

      dialog.contentLayout.add_child(textEntry);

      dialog.addButton({
        label: _("Discard"),
        action: () => {
          dialog.close();
          onDialogClose();
        },
        key: Clutter.KEY_Escape,
      });

      dialog.addButton({
        label: _("Save"),
        action: () => {
          const tag = textEntry.get_text().trim() || null;
          menuItem.entry.setTag(tag);
          this._updateTagLabel(menuItem);
          this._updateCache();
          dialog.close();
          onDialogClose();
        },
        default: true,
      });

      dialog.open();
      textEntry.grab_key_focus();
    }

    _updateTagLabel(menuItem) {
      if (menuItem.tagLabel) {
        menuItem.actor.remove_child(menuItem.tagLabel);
        menuItem.tagLabel.destroy();
        menuItem.tagLabel = null;
      }

      const tag = menuItem.entry.getTag();
      if (tag) {
        menuItem.tagLabel = new St.Label({
          text: tag,
          style_class: "ci-tag-label",
          y_align: Clutter.ActorAlign.CENTER,
        });
        menuItem.actor.insert_child_above(menuItem.tagLabel, menuItem.label);
      }
    }

    #showEditDialog(menuItem, reopenOnClose = false) {
      const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

      const onDialogClose = () => {
        if (reopenOnClose) {
          this._focusItemOnOpen = menuItem;
          this.menu.open();
        }
      };

      const scrollView = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        x_expand: true,
        y_expand: false,
        style: "min-width: 400px; min-height: 100px; max-height: 400px;",
      });

      const clutterText = new Clutter.Text({
        text: menuItem.entry.getStringValue(),
        editable: true,
        reactive: true,
        single_line_mode: false,
        activatable: false,
        line_wrap: true,
      });

      const white = new Cogl.Color();
      white.init_from_4f(1.0, 1.0, 1.0, 1.0);
      const selectionBlue = new Cogl.Color();
      selectionBlue.init_from_4f(0.39, 0.59, 1.0, 0.71);
      clutterText.color = white;
      clutterText.selection_color = selectionBlue;
      clutterText.selected_text_color = white;

      const textBox = new St.BoxLayout({
        style_class: "ci-edit-textbox",
        x_expand: true,
        y_expand: true,
        vertical: true,
      });

      textBox.add_child(clutterText);

      scrollView.add_child(textBox);
      dialog.contentLayout.add_child(scrollView);

      dialog.addButton({
        label: _("Discard"),
        action: () => {
          dialog.close();
          onDialogClose();
        },
        key: Clutter.KEY_Escape,
      });

      dialog.addButton({
        label: _("Save"),
        action: () => {
          const newText = clutterText.get_text();
          menuItem.entry.setText(newText);
          menuItem.clipContents = newText;
          this._setEntryLabel(menuItem);
          this._updateCache();
          if (menuItem.currentlySelected) this.#updateClipboard(menuItem.entry);
          dialog.close();
          onDialogClose();
        },
        default: true,
      });

      if (reopenOnClose) this.menu.close();
      dialog.open();
      clutterText.grab_key_focus();
    }

    #closeImagePreview() {
      if (!this.#_imagePreviewOverlay) return;

      const overlay = this.#_imagePreviewOverlay;
      this.#_imagePreviewOverlay = null;

      if (overlay._previewClickId) overlay.disconnect(overlay._previewClickId);
      if (overlay._previewKeyId) overlay.disconnect(overlay._previewKeyId);

      if (overlay.get_parent()) global.stage.remove_child(overlay);
      overlay.destroy();
    }

    #clearTimeouts() {
      if (this._setFocusOnOpenTimeout)
        clearTimeout(this._setFocusOnOpenTimeout);
      if (this._pastingKeypressTimeout)
        clearTimeout(this._pastingKeypressTimeout);
      if (this._pastingResetTimeout) clearTimeout(this._pastingResetTimeout);
      if (this._historyClearTimeoutId)
        clearTimeout(this._historyClearTimeoutId);
      if (this._timerIntervalId) clearInterval(this._timerIntervalId);
      if (this._blinkAnimationTimeout)
        clearTimeout(this._blinkAnimationTimeout);
    }

    #clearClipboard() {
      this.extension.clipboard.set_text(CLIPBOARD_TYPE, "");
      this.#updateIndicatorContent(null);
    }

    #updateClipboard(entry) {
      console.log(
        "Clipboard Indicator: updating clipboard to",
        entry.isImage()
          ? `[Image ${entry.asBytes().hash()}]`
          : entry.getStringValue(),
      );

      this.extension.clipboard.set_content(
        CLIPBOARD_TYPE,
        entry.mimetype(),
        entry.asBytes(),
      );
      this.#updateIndicatorContent(entry);
    }

    async #getClipboardContent() {
      const mimetypes = [
        "text/plain;charset=utf-8",
        "UTF8_STRING",
        "text/plain",
        "STRING",
        "image/gif",
        "image/png",
        "image/jpg",
        "image/jpeg",
        "image/webp",
        "image/svg+xml",
        "text/html",
      ];

      for (let type of mimetypes) {
        let result = await new Promise((resolve) =>
          this.extension.clipboard.get_content(
            CLIPBOARD_TYPE,
            type,
            (clipBoard, bytes) => {
              if (bytes === null || bytes.get_size() === 0) {
                resolve(null);
                return;
              }

              // HACK: workaround for GNOME 2nd+ copy mangling mimetypes https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233
              // In theory GNOME or XWayland should auto-convert this back to UTF8_STRING for legacy apps when it's needed https://gitlab.gnome.org/GNOME/gtk/-/merge_requests/5300
              const effectiveType =
                type === "UTF8_STRING" ? "text/plain;charset=utf-8" : type;

              const entry = new ClipboardEntry(effectiveType, bytes.get_data());
              if (CACHE_IMAGES && entry.isImage()) {
                this.registry.writeEntryFile(entry).then(() => resolve(entry));
              } else {
                resolve(entry);
              }
            },
          ),
        );

        if (result) {
          if (!CACHE_IMAGES && result.isImage()) {
            return null;
          } else {
            return result;
          }
        }
      }

      return null;
    }
  },
);
