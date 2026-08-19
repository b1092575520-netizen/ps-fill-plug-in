import { describe, expect, it, vi } from "vitest";
import { GenerationService } from "../src/backend/generationService";
import type { GenerationDraft } from "../src/types";

const draft: GenerationDraft = {
  mode: "text",
  prompt: "白色小花",
  model: "gpt-image-2",
  resolution: "2K",
  quality: "low",
  count: 1,
  aspectRatio: "auto",
  customWidth: 1,
  customHeight: 1,
  outputTarget: "current-document",
  references: [],
};

describe("GenerationService mode routing", () => {
  it.each(["text", "redraw"] as const)("routes %s through the remote provider", async (mode) => {
    const remoteProvider = { generate: vi.fn(async () => []) };
    await new GenerationService().generate({
      draft: {
        ...draft,
        mode,
        prompt: mode === "text" ? "白色小花" : "改成冬季",
        references: mode === "redraw" ? [{ id: "doc", name: "doc.png", url: "https://temp/doc.png", order: 0 }] : [],
      },
      modelOptions: ["gpt-image-2"],
      apiKey: "xinbao-key",
      signal: new AbortController().signal,
      onProgress: () => undefined,
      remoteProvider,
    });
    expect(remoteProvider.generate).toHaveBeenCalledOnce();
  });
});
