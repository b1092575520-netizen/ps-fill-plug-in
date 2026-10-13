import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_NOTE_STORAGE_KEY,
  addFavoritePrompt,
  findNoteByPrompt,
  loadPromptNotes,
  markPromptNoteUsed,
  normalizePromptNotes,
  noteTitleFromPrompt,
  renamePromptNote,
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
  useCount: 0,
  lastUsedAt: 0,
};

describe("prompt notebook storage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty instead of with sample prompts when nothing was saved", async () => {
    const storage = browserStorage();
    vi.stubGlobal("window", { localStorage: storage });
    await expect(loadPromptNotes()).resolves.toEqual([]);
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

  it("reads legacy notes, fills usage fields and puts busier notes first", () => {
    const normalized = normalizePromptNotes([
      { id: "old", title: "旧格式", prompt: " 保留这条 ", order: 0 },
      { id: "busy", title: "常用", prompt: "常用的那条", order: 9, mode: "redraw", useCount: 3 },
      { id: "dup", title: "重复", prompt: "保留这条", order: 2 },
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["busy", "old"]);
    expect(normalized[1]).toMatchObject({ mode: "all", prompt: "保留这条", useCount: 0, lastUsedAt: 0 });
  });

  it("titles a new favorite from the start of its first line", () => {
    expect(noteTitleFromPrompt("把背景换成纯蓝色证件照背景，人物保持不变")).toBe("把背景换成纯蓝色证件…");
    expect(noteTitleFromPrompt("换蓝底\n第二行")).toBe("换蓝底");
  });

  it("adds a favorite once, counts its use and renames it", () => {
    const added = addFavoritePrompt([], "  一只橘猫  ", 10);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ prompt: "一只橘猫", title: "一只橘猫", useCount: 0 });
    expect(addFavoritePrompt(added, "一只橘猫", 11)).toBe(added);
    expect(findNoteByPrompt(added, " 一只橘猫 ")?.id).toBe(added[0].id);

    const withSecond = addFavoritePrompt(added, "第二条", 12);
    const used = markPromptNoteUsed(withSecond, withSecond[1].id, 20);
    expect(used.map((item) => item.prompt)).toEqual(["第二条", "一只橘猫"]);
    expect(used[0]).toMatchObject({ useCount: 1, lastUsedAt: 20 });

    const renamed = renamePromptNote(used, used[0].id, " 证件照 ");
    expect(renamed[0].title).toBe("证件照");
    expect(renamePromptNote(renamed, renamed[0].id, " ")[0].title).toBe("第二条");
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
