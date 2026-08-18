import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPromptHistory,
  PROMPT_HISTORY_LIMIT,
  PROMPT_HISTORY_STORAGE_KEY,
  recordPromptHistory,
  savePromptHistory,
} from "../src/promptHistoryStorage";

afterEach(() => vi.unstubAllGlobals());

describe("prompt history storage", () => {
  it("does not record an empty prompt", () => {
    expect(recordPromptHistory([], "   ", "inpaint", 1)).toEqual([]);
  });

  it("deduplicates by prompt and moves the latest use to the front", () => {
    const first = recordPromptHistory([], "白色小花", "text", 1);
    const second = recordPromptHistory(first, "黑色小狗", "redraw", 2);
    const third = recordPromptHistory(second, "白色小花", "inpaint", 3);
    expect(third).toHaveLength(2);
    expect(third[0]).toMatchObject({ prompt: "白色小花", mode: "inpaint", lastUsedAt: 3 });
  });

  it("keeps at most fifty recent prompts", () => {
    let entries = [] as ReturnType<typeof recordPromptHistory>;
    for (let index = 0; index < PROMPT_HISTORY_LIMIT + 5; index += 1) {
      entries = recordPromptHistory(entries, `提示词-${index}`, "text", index + 1);
    }
    expect(entries).toHaveLength(50);
    expect(entries[0].prompt).toBe("提示词-54");
    expect(entries.at(-1)?.prompt).toBe("提示词-5");
  });

  it("round-trips through separate browser storage", async () => {
    let payload: string | null = null;
    const storage = {
      getItem: vi.fn(() => payload),
      setItem: vi.fn((key: string, value: string) => { expect(key).toBe(PROMPT_HISTORY_STORAGE_KEY); payload = value; }),
    };
    vi.stubGlobal("window", { localStorage: storage });
    const entries = recordPromptHistory([], "商业棚拍", "text", 10);
    await savePromptHistory(entries);
    await expect(loadPromptHistory()).resolves.toEqual(entries);
  });
});
