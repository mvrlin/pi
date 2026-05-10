/**
 * Model favorites for the native Pi model selector
 *
 * Adds favorites support to the built-in /model picker (Ctrl+L).
 * Favorite models are shown first in the sorted model list and are marked with ★.
 *
 * Usage:
 * 1. Open the native model selector with /model or Ctrl+L
 * 2. Move to a model and press Ctrl+Shift+F (or Alt+F as a fallback) to toggle it as favorite
 * 3. Favorites are persisted in ~/.pi/agent/settings.json under "favoriteModels"
 * 4. You can also edit the setting manually, using either "provider/model-id" or "model-id"
 *
 * Example settings.json:
 * {
 *   "favoriteModels": [
 *     "openai/gpt-5.1-codex-max",
 *     "claude-sonnet-4.5"
 *   ]
 * }
 */

import { getAgentDir, ModelSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const FAVORITES_FIELD = "favoriteModels";
const TOGGLE_KEYS = ["ctrl+shift+f", "alt+f"];
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let isPatched = false;

type Model = {
  id: string;
  name?: string;
  provider: string;
};

type ModelItem = {
  id: string;
  model: Model;
  provider: string;
};

type SettingsWithFavorites = Record<string, unknown> & {
  favoriteModels?: unknown;
};

function readSettings(): SettingsWithFavorites {
  if (!existsSync(SETTINGS_PATH)) return {};
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  return raw.trim() ? (JSON.parse(raw) as SettingsWithFavorites) : {};
}

function writeSettings(settings: SettingsWithFavorites): void {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function getFavorites(): string[] {
  const settings = readSettings();
  return Array.isArray(settings[FAVORITES_FIELD])
    ? settings[FAVORITES_FIELD].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function setFavorites(favorites: string[]): void {
  const seen = new Set<string>();
  const normalized = favorites.filter((favorite) => {
    if (seen.has(favorite)) return false;
    seen.add(favorite);
    return true;
  });
  const settings = readSettings();
  settings[FAVORITES_FIELD] = normalized;
  writeSettings(settings);
}

function modelKey(model: Model): string {
  return `${model.provider}/${model.id}`;
}

function favoriteIndex(model: Model, favorites = getFavorites()): number {
  const key = modelKey(model);
  return favorites.findIndex((favorite) => favorite === key || favorite === model.id);
}

function isFavorite(model: Model, favorites = getFavorites()): boolean {
  return favoriteIndex(model, favorites) >= 0;
}

function toggleFavorite(model: Model): boolean {
  const key = modelKey(model);
  const favorites = getFavorites();
  const index = favoriteIndex(model, favorites);
  if (index >= 0) {
    favorites.splice(index, 1);
    setFavorites(favorites);
    return false;
  }
  favorites.push(key);
  setFavorites(favorites);
  return true;
}

function modelsAreEqual(a: Model | undefined, b: Model | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

function isToggleFavoriteKey(data: string): boolean {
  return TOGGLE_KEYS.some((key) => matchesKey(data, key));
}

async function patchNativeModelSelector() {
  if (isPatched) return;
  isPatched = true;

  const piMainUrl = await import.meta.resolve("@earendil-works/pi-coding-agent");
  const themeModule = await import(new URL("./modes/interactive/theme/theme.js", piMainUrl).href);
  const theme = themeModule.theme;
  const proto = ModelSelectorComponent.prototype;

  proto.sortModels = function sortModelsWithFavorites(models: ModelItem[]) {
    const favorites = getFavorites();
    const sorted = [...models];
    sorted.sort((a, b) => {
      const aFavorite = favoriteIndex(a.model, favorites);
      const bFavorite = favoriteIndex(b.model, favorites);
      if (aFavorite >= 0 || bFavorite >= 0) {
        if (aFavorite >= 0 && bFavorite >= 0) return aFavorite - bFavorite;
        return aFavorite >= 0 ? -1 : 1;
      }

      // Preserve Pi's native ordering for non-favorites: current model first, then provider.
      const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
      const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return a.provider.localeCompare(b.provider);
    });
    return sorted;
  };

  const originalLoadModels = proto.loadModels;
  proto.loadModels = async function loadModelsWithFavoriteScopedOrdering(...args: unknown[]) {
    await originalLoadModels.apply(this, args);
    this.scopedModelItems = this.sortModels(this.scopedModelItems ?? []);
    this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
    this.filteredModels = this.activeModels;
    const currentIndex = this.filteredModels.findIndex((item: ModelItem) => modelsAreEqual(this.currentModel, item.model));
    this.selectedIndex = currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
  };

  const originalHandleInput = proto.handleInput;
  proto.handleInput = function handleInputWithFavoriteToggle(keyData: string) {
    if (isToggleFavoriteKey(keyData)) {
      const selected = this.filteredModels?.[this.selectedIndex];
      if (!selected) return;
      toggleFavorite(selected.model);
      this.allModels = this.sortModels(this.allModels ?? []);
      this.scopedModelItems = this.sortModels(this.scopedModelItems ?? []);
      this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
      this.filterModels(this.searchInput.getValue());
      this.tui.requestRender();
      return;
    }
    return originalHandleInput.call(this, keyData);
  };

  proto.getScopeHintText = function getScopeHintTextWithFavorite() {
    return "Tab scope · Ctrl+Shift+F/Alt+F favorite";
  };

  proto.updateList = function updateListWithFavoriteMarkers() {
    this.listContainer.clear();
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
    const favorites = getFavorites();

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;
      const isSelected = i === this.selectedIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);
      const favoriteMark = isFavorite(item.model, favorites) ? `${YELLOW}★${RESET} ` : "  ";
      const providerBadge = theme.fg("muted", `[${item.provider}]`);
      const checkmark = isCurrent ? ` ${theme.fg("success", "✓")}` : "";

      if (isSelected) {
        const prefix = theme.fg("accent", "→ ");
        const modelText = theme.fg("accent", item.id);
        this.listContainer.addChild(new Text(`${prefix}${favoriteMark}${modelText} ${providerBadge}${checkmark}`, 0, 0));
      } else {
        this.listContainer.addChild(new Text(`  ${favoriteMark}${item.id} ${providerBadge}${checkmark}`, 0, 0));
      }
    }

    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0),
      );
    }

    if (this.errorMessage) {
      for (const line of this.errorMessage.split("\n")) {
        this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
      }
    } else if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
      this.listContainer.addChild(
        new Text(theme.fg("muted", "  Ctrl+Shift+F/Alt+F: toggle favorite (saved to settings.json)"), 0, 0),
      );
    }
  };
}

export default async function (_pi: ExtensionAPI) {
  await patchNativeModelSelector();
}
