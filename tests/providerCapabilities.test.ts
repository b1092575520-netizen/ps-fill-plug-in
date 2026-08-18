import { describe, expect, it } from "vitest";
import {
  createXinbaoSnapshot,
  remoteModelCapabilities,
  snapshotModelOptions,
  xinbaoBalanceBaseUrl,
  xinbaoTaskBatchBaseUrl,
  xinbaoTaskHistoryBaseUrl,
} from "../src/backend/providerCapabilities";
import { generationSize } from "../src/backend/generationService";
import type { GenerationDraft } from "../src/types";

const draft: GenerationDraft = {
  mode: "text",
  prompt: "test",
  model: "gpt-image-2-oai",
  resolution: "2K",
  quality: "high",
  count: 1,
  aspectRatio: "1:1",
  customWidth: 1,
  customHeight: 1,
  outputTarget: "new-document",
  references: [],
};

describe("provider capabilities", () => {
  it("maps Xinbao generation traffic to its separate account API", () => {
    expect(xinbaoBalanceBaseUrl("https://async.xinbao-ai.com"))
      .toBe("https://xinbaoapi.dpdns.org");
    expect(xinbaoBalanceBaseUrl("https://compatible.example"))
      .toBe("https://compatible.example");
  });

  it("maps only confirmed Xinbao task capabilities without changing balance mapping", () => {
    expect(xinbaoTaskHistoryBaseUrl("https://async.xinbao-ai.com"))
      .toBe("https://task.xinbao-ai.com");
    expect(xinbaoTaskBatchBaseUrl("https://async.xinbao-ai.com"))
      .toBe("https://async.xinbao-ai.com");
    expect(xinbaoTaskHistoryBaseUrl("https://compatible.example")).toBeNull();
    expect(xinbaoTaskBatchBaseUrl("https://compatible.example")).toBeNull();
    expect(xinbaoBalanceBaseUrl("https://async.xinbao-ai.com"))
      .toBe("https://xinbaoapi.dpdns.org");
  });

  it("contains only the two documented non-Gemini Xinbao image models", () => {
    const snapshot = createXinbaoSnapshot();
    expect(snapshot.models.map((model) => model.id)).toEqual([
      "gpt-image-2-oai",
      "gpt-image-2",
    ]);
    expect(snapshot.models.every((model) => model.confirmedImage)).toBe(true);
    expect(snapshotModelOptions(snapshot)[0]).toBe("auto");
  });

  it("keeps unknown remote models selectable with API-default parameters and filters Gemini", () => {
    const models = remoteModelCapabilities([
      { id: "text-or-image-unknown" },
      { id: "gemini-3-pro-image-preview", modalities: ["image"] },
    ]);
    expect(models).toEqual([
      expect.objectContaining({
        id: "text-or-image-unknown",
        confirmedImage: false,
        resolutions: ["api-default"],
        qualityOptions: [],
      }),
    ]);
    expect(snapshotModelOptions({
      models,
      source: "api",
      fetchedAt: Date.now(),
      stale: false,
      credentialVerified: true,
    })).toEqual(["text-or-image-unknown"]);
  });

  it("parses explicit remote image capability metadata", () => {
    expect(remoteModelCapabilities([{
      id: "vendor-image",
      capabilities: {
        modalities: ["image"],
        resolutions: ["1k", "4K"],
        quality_options: ["low", "high"],
        aspect_ratios: ["1:1", "16:9", "unsupported"],
      },
    }])).toEqual([
      expect.objectContaining({
        id: "vendor-image",
        confirmedImage: true,
        resolutions: ["1K", "4K"],
        qualityOptions: ["low", "high"],
        aspectRatios: ["1:1", "16:9"],
      }),
    ]);
  });

  it("maps all 24 documented Xinbao resolution and ratio combinations for both models", () => {
    const expected = {
      "1K": ["1024x1024", "1024x768", "768x1024", "1536x1024", "1024x1536", "1280x720", "720x1280", "1344x576"],
      "2K": ["2048x2048", "2048x1536", "1536x2048", "2048x1360", "1360x2048", "2048x1152", "1152x2048", "2400x1024"],
      "4K": ["2880x2880", "3264x2448", "2448x3264", "3504x2336", "2336x3504", "3840x2160", "2160x3840", "3840x1648"],
    } as const;
    const ratios = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"] as const;
    for (const model of ["gpt-image-2-oai", "gpt-image-2"] as const) {
      for (const resolution of ["1K", "2K", "4K"] as const) {
        ratios.forEach((aspectRatio, index) => {
          expect(generationSize(model, {
            ...draft,
            model,
            resolution,
            aspectRatio,
          })).toBe(expected[resolution][index]);
        });
      }
    }
  });
});
