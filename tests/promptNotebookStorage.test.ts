import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROMPT_NOTES,
  PROMPT_NOTE_STORAGE_KEY,
  loadPromptNotes,
  normalizePromptNotes,
  savePromptNotes,
} from "../src/promptNotebookStorage";
import type { PromptNote } from "../src/types";

function browserStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(() => { value = null; }),
  };
}

const note: PromptNote = {
  id: "note-test",
  title: "测试提示词",
  prompt: "一只安静的黑猫，柔和侧光",
  mode: "text",
  pinned: false,
  order: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe("prompt notebook storage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the built-in starter notes only when storage is missing", async () => {
    const storage = browserStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const loaded = await loadPromptNotes();
    expect(loaded).toEqual(DEFAULT_PROMPT_NOTES);
    expect(storage.getItem).toHaveBeenCalledWith(PROMPT_NOTE_STORAGE_KEY);
  });

  it("round-trips notes through browser localStorage", async () => {
    const storage = browserStorage();
    vi.stubGlobal("window", { localStorage: storage });
    await savePromptNotes([note]);
    const loaded = await loadPromptNotes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: note.id, title: note.title, prompt: note.prompt, mode: "text" });
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it("returns an empty notebook for corrupt JSON instead of throwing", async () => {
    const storage = browserStorage("{not-json");
    vi.stubGlobal("window", { localStorage: storage });
    await expect(loadPromptNotes()).resolves.toEqual([]);
  });

  it("normalizes legacy notes and keeps pinned notes first", () => {
    const normalized = normalizePromptNotes([
      { id: "old", title: "旧格式", prompt: " 保留这条 ", order: 1 },
      { id: "pin", title: "置顶", prompt: "优先", pinned: true, order: 9, mode: "redraw" },
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["pin", "old"]);
    expect(normalized[1]).toMatchObject({ mode: "all", pinned: false, prompt: "保留这条" });
  });

  it("drops invalid empty records without dropping valid records", () => {
    const normalized = normalizePromptNotes([null, { title: "空", prompt: " " }, note]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].id).toBe(note.id);
  });

  it("uses the UXP data folder when the host exposes it", async () => {
    let payload = "";
    const file = {
      read: vi.fn(async () => payload),
      write: vi.fn(async (next: string) => { payload = next; }),
    };
    const folder = {
      getEntry: vi.fn(async () => file),
      createFile: vi.fn(async () => file),
    };
    vi.stubGlobal("require", (name: string) => name === "uxp" ? { storage: { localFileSystem: { getDataFolder: async () => folder } } } : undefined);
    await savePromptNotes([note]);
    expect(file.write).toHaveBeenCalledOnce();
    await expect(loadPromptNotes()).resolves.toHaveLength(1);
    expect(folder.getEntry).toHaveBeenCalledWith("prompt-notebook.v1.json");
  });
});
