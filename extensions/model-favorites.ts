import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

type Settings = {
  favoriteModels?: string[];
  defaultProvider?: string;
  defaultModel?: string;
};

type Favorite = {
  key: string;
  provider: string;
  modelId: string;
  thinkingLevel: Level;
};

function readJson(file: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeGlobalSettings(settings: Settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function favoritePrefix(key: string): string | undefined {
  const colon = key.lastIndexOf(":");
  const modelPart = colon === -1 ? key : key.slice(0, colon);
  return modelPart.includes("/") ? modelPart : undefined;
}

function parseFavorite(key: string): Favorite | undefined {
  const colon = key.lastIndexOf(":");
  const modelPart = colon === -1 ? key : key.slice(0, colon);
  const level = colon === -1 ? "off" : key.slice(colon + 1);
  if (!modelPart.includes("/") || !LEVELS.includes(level as Level)) return undefined;
  const slash = modelPart.indexOf("/");
  return {
    key,
    provider: modelPart.slice(0, slash),
    modelId: modelPart.slice(slash + 1),
    thinkingLevel: level as Level,
  };
}

function normalizeFavorites(favorites: string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const favorite of favorites ?? []) {
    const prefix = favoritePrefix(favorite);
    if (!prefix) {
      result.push(favorite);
      continue;
    }
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    result.push(favorite);
  }
  return result;
}

function getProjectSettings(cwd: string): Settings {
  return readJson(path.join(cwd, ".pi", "settings.json"));
}

function getMergedFavorites(cwd: string): string[] {
  const global = normalizeFavorites(readJson(SETTINGS_PATH).favoriteModels);
  const project = normalizeFavorites(getProjectSettings(cwd).favoriteModels);
  return normalizeFavorites([...global, ...project]);
}

function modelKey(model: Model<any>) {
  return `${model.provider}/${model.id}`;
}

function findGlobalFavorite(provider: string, modelId: string): string | undefined {
  const prefix = `${provider}/${modelId}`;
  return normalizeFavorites(readJson(SETTINGS_PATH).favoriteModels).find((fav) => fav === prefix || fav.startsWith(`${prefix}:`));
}

function setDefaultModel(provider: string, modelId: string) {
  const settings = readJson(SETTINGS_PATH);
  settings.defaultProvider = provider;
  settings.defaultModel = modelId;
  writeGlobalSettings(settings);
}

async function validFavorites(ctx: ExtensionContext): Promise<Array<Favorite & { model: Model<any> }>> {
  const result: Array<Favorite & { model: Model<any> }> = [];
  for (const key of getMergedFavorites(ctx.cwd)) {
    const fav = parseFavorite(key);
    if (!fav) continue;
    const model = ctx.modelRegistry.find(fav.provider, fav.modelId);
    if (!model) continue;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;
    result.push({ ...fav, model });
  }
  return result;
}

async function cycleFavorite(pi: ExtensionAPI, ctx: ExtensionContext, direction: "forward" | "backward") {
  const favorites = await validFavorites(ctx);
  if (favorites.length === 0) {
    ctx.ui.notify("No favorite models with configured API keys. Use /favorite-model add.", "warning");
    return;
  }

  const current = ctx.model ? modelKey(ctx.model) : undefined;
  let currentIndex = favorites.findIndex((fav) => `${fav.provider}/${fav.modelId}` === current);
  if (currentIndex === -1) currentIndex = direction === "forward" ? -1 : 0;

  const nextIndex =
    direction === "forward"
      ? (currentIndex + 1 + favorites.length) % favorites.length
      : (currentIndex - 1 + favorites.length) % favorites.length;
  const next = favorites[nextIndex];

  const ok = await pi.setModel(next.model);
  if (!ok) {
    ctx.ui.notify(`No API key for ${next.provider}/${next.modelId}`, "warning");
    return;
  }
  pi.setThinkingLevel(next.thinkingLevel as ThinkingLevel);
  setDefaultModel(next.provider, next.modelId);

}

function addFavorite(provider: string, modelId: string, level: string): boolean {
  if (!LEVELS.includes(level as Level)) return false;
  const settings = readJson(SETTINGS_PATH);
  const favorites = normalizeFavorites(settings.favoriteModels);
  const prefix = `${provider}/${modelId}`;
  settings.favoriteModels = [...favorites.filter((fav) => favoritePrefix(fav) !== prefix), `${prefix}:${level}`];
  writeGlobalSettings(settings);
  return true;
}

function removeFavorite(provider: string, modelId: string) {
  const settings = readJson(SETTINGS_PATH);
  const prefix = `${provider}/${modelId}`;
  settings.favoriteModels = normalizeFavorites(settings.favoriteModels).filter((fav) => favoritePrefix(fav) !== prefix);
  writeGlobalSettings(settings);
}

export default function favoriteModelExtension(pi: ExtensionAPI) {
  let unsubscribeMacOptionKeys: (() => void) | undefined;

  pi.registerShortcut("ctrl+shift+l", {
    description: "Cycle favorite models forward",
    handler: (ctx) => cycleFavorite(pi, ctx, "forward"),
  });

  pi.registerShortcut("ctrl+shift+k", {
    description: "Cycle favorite models backward",
    handler: (ctx) => cycleFavorite(pi, ctx, "backward"),
  });

  // macOS Terminal/iTerm often sends Option+P as the unicode chars π / ∏
  // unless "Option as Meta" is enabled. Handle those directly too.
  pi.on("session_start", (_event, ctx) => {
    unsubscribeMacOptionKeys?.();
    unsubscribeMacOptionKeys = ctx.ui.onTerminalInput((data) => {
      if (data === "π") {
        void cycleFavorite(pi, ctx, "forward");
        return { consume: true };
      }
      if (data === "∏") {
        void cycleFavorite(pi, ctx, "backward");
        return { consume: true };
      }
      return undefined;
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribeMacOptionKeys?.();
    unsubscribeMacOptionKeys = undefined;
  });

  pi.registerCommand("fm", {
    description: "Favorite model shortcut: next | prev | select | list | add | remove | toggle",
    handler: async (args, ctx) => {
      pi.sendUserMessage(`/favorite-model ${args || "select"}`, { deliverAs: ctx.isIdle() ? undefined : "followUp" });
    },
  });

  pi.registerCommand("favorite-model", {
    description: "Manage favorite models: list | add [provider/model[:level]] | remove [provider/model] | toggle",
    handler: async (args, ctx) => {
      const [action = "list", rawKey] = args.trim().split(/\s+/, 2);
      const current = ctx.model;

      if (action === "next") {
        await cycleFavorite(pi, ctx, "forward");
        return;
      }

      if (action === "prev" || action === "previous") {
        await cycleFavorite(pi, ctx, "backward");
        return;
      }

      if (action === "select") {
        const favorites = await validFavorites(ctx);
        if (favorites.length === 0) return ctx.ui.notify("No favorite models with configured API keys", "warning");
        const labels = favorites.map((f) => `${f.provider}/${f.modelId}:${f.thinkingLevel}`);
        const selected = await ctx.ui.select("Select favorite model", labels);
        if (!selected) return;
        const favorite = favorites[labels.indexOf(selected)];
        const ok = await pi.setModel(favorite.model);
        if (!ok) return ctx.ui.notify(`No API key for ${favorite.provider}/${favorite.modelId}`, "warning");
        pi.setThinkingLevel(favorite.thinkingLevel as ThinkingLevel);
        setDefaultModel(favorite.provider, favorite.modelId);

        return;
      }

      if (action === "list") {
        const favorites = getMergedFavorites(ctx.cwd);
        ctx.ui.notify(favorites.length ? `Favorite models:\n${favorites.map((f) => `• ${f}`).join("\n")}` : "No favorite models", "info");
        return;
      }

      if (action === "add") {
        const parsed = rawKey ? parseFavorite(rawKey) : current && parseFavorite(`${current.provider}/${current.id}:${pi.getThinkingLevel()}`);
        if (!parsed) return ctx.ui.notify("Usage: /favorite-model add provider/model[:off|minimal|low|medium|high|xhigh]", "error");
        if (!addFavorite(parsed.provider, parsed.modelId, parsed.thinkingLevel)) return ctx.ui.notify("Invalid thinking level", "error");
        ctx.ui.notify(`Added favorite ${parsed.provider}/${parsed.modelId}:${parsed.thinkingLevel}`, "info");
        return;
      }

      if (action === "remove") {
        const parsed = rawKey ? parseFavorite(rawKey) : current && parseFavorite(`${current.provider}/${current.id}`);
        if (!parsed) return ctx.ui.notify("Usage: /favorite-model remove provider/model", "error");
        removeFavorite(parsed.provider, parsed.modelId);
        ctx.ui.notify(`Removed favorite ${parsed.provider}/${parsed.modelId}`, "info");
        return;
      }

      if (action === "toggle") {
        if (!current) return ctx.ui.notify("No current model", "warning");
        const existing = findGlobalFavorite(current.provider, current.id);
        if (existing) {
          removeFavorite(current.provider, current.id);
          ctx.ui.notify(`Removed favorite ${current.provider}/${current.id}`, "info");
        } else {
          addFavorite(current.provider, current.id, pi.getThinkingLevel());
          ctx.ui.notify(`Added favorite ${current.provider}/${current.id}:${pi.getThinkingLevel()}`, "info");
        }
        return;
      }

      ctx.ui.notify("Usage: /favorite-model next|prev|select|list|add|remove|toggle", "error");
    },
  });
}
