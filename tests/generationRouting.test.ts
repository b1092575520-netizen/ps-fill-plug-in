import { describe, expect, it, vi } from "vitest";
import { GenerationService } from "../src/backend/generationService";
import { candidateSelectionForInsert } from "../src/usePrototypeState";
import type { GenerationDraft, SelectionSnapshot } from "../src/types";

const draft: GenerationDraft = {
  mode: "inpaint",
  prompt: "",
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

const selectionSnapshot: SelectionSnapshot = {
  documentId: "doc-1",
  documentWidth: 1000,
  documentHeight: 800,
  selectionBounds: { x: 100, y: 100, width: 100, height: 100 },
  cropBounds: { x: 0, y: 0, width: 500, height: 500 },
  targetWidth: 512,
  targetHeight: 512,
  contextBytes: new Uint8Array([1]),
  maskBytes: new Uint8Array([2]),
  mimeType: "image/png",
};

describe("GenerationService mode routing", () => {
  it("passes the original arbitrary mask snapshot to Photoshop insertion", () => {
    const snapshot = { ...selectionSnapshot, maskBytes: new Uint8Array([0, 255, 127, 0]) };
    expect(candidateSelectionForInsert({
      id: "candidate",
      title: "方案 01",
      url: "blob:candidate",
      aspectRatio: "1:1",
      selected: true,
      generationMode: "inpaint",
      selection: selectionSnapshot.selectionBounds,
      selectionSnapshot: snapshot,
    })).toBe(snapshot);
    expect(candidateSelectionForInsert({
      id: "remote",
      title: "方案 01",
      url: "blob:remote",
      aspectRatio: "1:1",
      selected: true,
      generationMode: "redraw",
      selection: selectionSnapshot.selectionBounds,
    })).toBeNull();
  });

  it("routes inpaint only to the local provider and makes zero Xinbao calls", async () => {
    const remoteProvider = { generate: vi.fn() };
    const onStage = vi.fn();
    const localProvider = {
      checkHealth: vi.fn(),
      generate: vi.fn(async () => [{
        id: "local",
        bytes: new Uint8Array([3]),
        mimeType: "image/png",
      }]),
    };
    const result = await new GenerationService().generate({
      draft,
      modelOptions: ["gpt-image-2"],
      apiKey: "xinbao-key",
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onStage,
      selectionSnapshot,
      localModel: "klein-4b",
      remoteProvider,
      localProvider,
    });
    expect(localProvider.generate).toHaveBeenCalledOnce();
    expect(localProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({ strength: "strong" }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(onStage).toHaveBeenCalledWith("generating");
    expect(remoteProvider.generate).not.toHaveBeenCalled();
    expect(result[0].layerName).toBe("智能填充");
  });

  it("keeps redraw on the existing remote provider and makes zero local calls", async () => {
    const remoteProvider = { generate: vi.fn(async () => []) };
    const localProvider = {
      checkHealth: vi.fn(),
      generate: vi.fn(),
    };
    await new GenerationService().generate({
      draft: {
        ...draft,
        mode: "redraw",
        prompt: "改成冬季",
        references: [{ id: "doc", name: "doc.png", url: "https://temp/doc.png", order: 0 }],
      },
      modelOptions: ["gpt-image-2"],
      apiKey: "xinbao-key",
      signal: new AbortController().signal,
      onProgress: () => undefined,
      remoteProvider,
      localProvider,
      context: {
        documentId: "doc-1",
        documentName: "photo.psd",
        width: 1000,
        height: 800,
        colorMode: "RGB",
        selection: selectionSnapshot.selectionBounds,
      },
    });
    expect(remoteProvider.generate).toHaveBeenCalledOnce();
    expect(localProvider.generate).not.toHaveBeenCalled();
  });
});
