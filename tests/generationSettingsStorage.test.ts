import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRememberedSettings,
  GENERATION_SETTINGS_STORAGE_KEY,
  loadGenerationSettingsMemory,
  normalizeGenerationSettingsMemory,
  saveGenerationSettingsMemory,
  settingsFromDraft,
} from "../src/generationSettingsStorage";
import type { GenerationDraft } from "../src/types";

const draft: GenerationDraft = {
  mode: "text",
  prompt: "不应持久化",
  model: "gpt-image-2-oai",
  resolution: "2K",
  quality: "high",
  count: 4,
  aspectRatio: "4:3",
  customWidth: 4,
  customHeight: 3,
  outputTarget: "new-document",
  references: [{ id: "private-reference", name: "reference.png", url: "blob:private", order: 0 }],
};

function browserStorage(payload: string | null = null) {
  let value = payload;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("generation settings storage", () => {
  it("persists only approved settings fields and never prompt or references", async () => {
    const storage = browserStorage();
    vi.stubGlobal("window", { localStorage: storage });
    await saveGenerationSettingsMemory({
      version: 1,
      enabled: true,
      byMode: { text: settingsFromDraft(draft) },
    });
    const payload = String(storage.setItem.mock.calls[0][1]);

    expect(storage.setItem.mock.calls[0][0]).toBe(GENERATION_SETTINGS_STORAGE_KEY);
    expect(payload).not.toContain(draft.prompt);
    expect(payload).not.toContain("private-reference");
    expect(JSON.parse(payload).byMode.text).toEqual(settingsFromDraft(draft));
  });

  it("keeps remembered values isolated by generation mode", () => {
    const memory = normalizeGenerationSettingsMemory({
      version: 1,
      enabled: true,
      byMode: {
        text: settingsFromDraft({ ...draft, count: 1, model: "text-model" }),
        redraw: settingsFromDraft({ ...draft, mode: "redraw", count: 3, model: "redraw-model" }),
      },
    });

    expect(applyRememberedSettings(draft, memory, "text")).toMatchObject({ mode: "text", count: 1, model: "text-model" });
    expect(applyRememberedSettings(draft, memory, "redraw")).toMatchObject({ mode: "redraw", count: 3, model: "redraw-model" });
  });

  it("rejects invalid legacy values without corrupting valid modes", () => {
    const memory = normalizeGenerationSettingsMemory({
      version: 1,
      enabled: true,
      byMode: {
        text: { ...settingsFromDraft(draft), count: 99 },
        redraw: settingsFromDraft({ ...draft, mode: "redraw", count: 2 }),
      },
    });
    expect(memory.byMode.text).toBeUndefined();
    expect(memory.byMode.redraw?.count).toBe(2);
    expect(normalizeGenerationSettingsMemory({ version: 0, enabled: false }).enabled).toBe(true);
  });

  it("loads disabled memory as disabled with no implicit values", async () => {
    const storage = browserStorage(JSON.stringify({ version: 1, enabled: false, byMode: {} }));
    vi.stubGlobal("window", { localStorage: storage });
    await expect(loadGenerationSettingsMemory()).resolves.toEqual({ version: 1, enabled: false, byMode: {} });
  });
});
