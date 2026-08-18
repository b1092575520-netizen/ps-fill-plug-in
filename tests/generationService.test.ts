import { describe, expect, it, vi } from "vitest";
import {
  conciseLayerName,
  generateFromDraft,
  realGenerationBlocker,
} from "../src/backend/generationService";
import type { GenerationDraft, PhotoshopContext } from "../src/types";

const draft: GenerationDraft = {
  mode: "text",
  prompt: "mountain",
  model: "auto",
  resolution: "2K",
  quality: "low",
  count: 1,
  aspectRatio: "1:1",
  customWidth: 1,
  customHeight: 1,
  outputTarget: "current-document",
  references: [],
};

const context: PhotoshopContext = {
  documentId: "doc-1",
  documentName: "photo.psd",
  width: 3000,
  height: 2000,
  colorMode: "RGB",
  selection: { x: 300, y: 400, width: 600, height: 500 },
};

describe("generateFromDraft", () => {
  it("prioritizes missing UXP credentials over later generation requirements", () => {
    expect(realGenerationBlocker(
      { ...draft, prompt: "" },
      "",
      true,
      context,
    )).toBe("请先配置 API Key");
  });

  it("requires a Photoshop document before current-document generation", () => {
    expect(realGenerationBlocker(draft, "key", true, null))
      .toBe("请先打开 Photoshop 文档");
  });

  it("requires an inpaint selection before checking its optional prompt", () => {
    expect(realGenerationBlocker(
      { ...draft, mode: "inpaint", prompt: "" },
      "key",
      true,
      { ...context, selection: null },
    )).toBe("请先创建选区");
  });

  it("uses one direct prompt instruction for text and redraw modes", () => {
    expect(realGenerationBlocker(
      { ...draft, outputTarget: "new-document", prompt: "" },
      "key",
      true,
      null,
    )).toBe("请先填写提示词");
    expect(realGenerationBlocker(
      { ...draft, mode: "redraw", prompt: "" },
      "key",
      true,
      context,
    )).toBe("请先填写提示词");
  });

  it("blocks unsupported custom ratios with an actionable instruction", () => {
    expect(realGenerationBlocker(
      { ...draft, outputTarget: "new-document", aspectRatio: "custom" },
      "key",
      true,
      null,
    )).toMatch(/^请设置有效比例/);
  });

  it("allows browser demo generation without an API key", () => {
    expect(realGenerationBlocker(draft, "", false, context)).toBe("");
  });

  it("derives short Chinese layer names from generation prompts", () => {
    expect(conciseLayerName("一只黑色的小狗", "text")).toBe("黑色小狗");
    expect(conciseLayerName("一朵白色小花", "text")).toBe("白色小花");
    expect(conciseLayerName("", "inpaint")).toBe("智能填充");
  });

  it("builds the corrected gpt-image-2 request without quality", async () => {
    const provider = { generate: vi.fn(async () => []) };
    await generateFromDraft(
      provider,
      { ...draft, model: "gpt-image-2", aspectRatio: "16:9", quality: "high" },
      ["auto", "gpt-image-2"],
      "key",
      new AbortController().signal,
      () => undefined,
    );
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-image-2",
      prompt: "创建图片,mountain",
      size: "2048x1152",
      quality: undefined,
      responseFormat: "url",
    }), expect.any(AbortSignal), expect.any(Function));
  });

  it("passes auto size and quality only for gpt-image-2-oai", async () => {
    const provider = { generate: vi.fn(async () => []) };
    await generateFromDraft(
      provider,
      { ...draft, model: "gpt-image-2-oai", aspectRatio: "auto", quality: "medium" },
      ["auto", "gpt-image-2-oai"],
      "key",
      new AbortController().signal,
      () => undefined,
    );
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-image-2-oai",
      size: "auto",
      quality: "medium",
    }), expect.any(AbortSignal), expect.any(Function));
  });

  it("uses the corrected 2K 21:9 size", async () => {
    const provider = { generate: vi.fn(async () => []) };
    await generateFromDraft(
      provider,
      { ...draft, model: "gpt-image-2-oai", aspectRatio: "21:9" },
      ["auto", "gpt-image-2-oai"],
      "key",
      new AbortController().signal,
      () => undefined,
    );
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      size: "2400x1024",
    }), expect.any(AbortSignal), expect.any(Function));
  });

  it("supports empty-prompt inpaint with document context and selection coordinates", async () => {
    const provider = { generate: vi.fn(async () => []) };
    await generateFromDraft(
      provider,
      {
        ...draft,
        mode: "inpaint",
        prompt: "",
        model: "gpt-image-2-oai",
        references: [{ id: "doc", name: "doc.png", order: 0, url: "https://temp.example/doc.png" }],
      },
      ["auto", "gpt-image-2-oai"],
      "key",
      new AbortController().signal,
      () => undefined,
      undefined,
      undefined,
      context,
    );
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      imageUrls: ["https://temp.example/doc.png"],
      prompt: expect.stringMatching(/自然补全.*300.*400.*600.*500/),
      size: "2048x1536",
    }), expect.any(AbortSignal), expect.any(Function));
  });

  it("redraws the current document with a required prompt", async () => {
    const provider = { generate: vi.fn(async () => []) };
    await generateFromDraft(
      provider,
      {
        ...draft,
        mode: "redraw",
        prompt: "改成冬季",
        model: "gpt-image-2-oai",
        references: [{ id: "doc", name: "doc.png", order: 0, url: "https://temp.example/doc.png" }],
      },
      ["auto", "gpt-image-2-oai"],
      "key",
      new AbortController().signal,
      () => undefined,
      undefined,
      undefined,
      context,
    );
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(/整幅重绘.*改成冬季/),
      size: "2048x1360",
    }), expect.any(AbortSignal), expect.any(Function));
  });

  it("uploads local references and passes their public URLs in order", async () => {
    const provider = { generate: vi.fn(async () => []) };
    const uploader = { upload: vi.fn(async (_file: Blob, name: string) => `https://temp.example/${name}`) };
    const stages: string[] = [];
    await generateFromDraft(
      provider,
      {
        ...draft,
        references: [
          { id: "b", name: "b.png", order: 1, url: "blob:b", file: new Blob(["b"], { type: "image/png" }) as File },
          { id: "a", name: "a.png", order: 0, url: "blob:a", file: new Blob(["a"], { type: "image/png" }) as File },
        ],
      },
      ["auto", "model"],
      "key",
      new AbortController().signal,
      () => undefined,
      uploader,
      (stage) => stages.push(stage),
    );
    expect(uploader.upload.mock.calls.map((call) => call[1])).toEqual(["a.png", "b.png"]);
    expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({
      imageUrls: ["https://temp.example/a.png", "https://temp.example/b.png"],
    }), expect.any(AbortSignal), expect.any(Function));
    expect(stages).toEqual(["uploading", "submitting", "generating"]);
  });

  it("reserves reference slots for Photoshop context images", async () => {
    const provider = { generate: vi.fn() };
    const references = Array.from({ length: 8 }, (_, index) => ({
      id: `r-${index}`,
      name: `${index}.png`,
      order: index,
      url: `https://temp.example/${index}.png`,
    }));
    await expect(generateFromDraft(
      provider,
      { ...draft, mode: "inpaint", prompt: "", references },
      ["auto", "gpt-image-2-oai"],
      "key",
      new AbortController().signal,
      () => undefined,
      undefined,
      undefined,
      context,
    )).rejects.toThrow(/最多 7 张/);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("makes zero provider requests for unsupported custom ratios", async () => {
    const provider = { generate: vi.fn() };
    await expect(generateFromDraft(
      provider,
      { ...draft, aspectRatio: "custom" },
      ["auto", "gpt-image-2-oai"],
      "key",
      new AbortController().signal,
      () => undefined,
    )).rejects.toThrow(/预设比例/);
    expect(provider.generate).not.toHaveBeenCalled();
  });
});
