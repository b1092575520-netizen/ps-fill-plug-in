import { describe, expect, it, vi } from "vitest";
import {
  buildKleinWorkflow,
  LocalInpaintProvider,
} from "../src/backend/localInpaintProvider";
import type {
  LocalInpaintSettings,
  SelectionSnapshot,
} from "../src/types";

const requiredNodes = [
  "LoadImage",
  "ImageScaleToTotalPixels",
  "GetImageSize",
  "UNETLoader",
  "CLIPLoader",
  "VAELoader",
  "CLIPTextEncode",
  "ConditioningZeroOut",
  "ConditioningSetAreaStrength",
  "VAEEncode",
  "ReferenceLatent",
  "EmptyFlux2LatentImage",
  "Flux2Scheduler",
  "CFGGuider",
  "KSamplerSelect",
  "RandomNoise",
  "SamplerCustomAdvanced",
  "VAEDecode",
  "LoadImageMask",
  "GrowMask",
  "FeatherMask",
  "MaskToImage",
  "ImageScale",
  "ImageToMask",
  "EmptyImage",
  "ImageCompositeMasked",
  "PreviewImage",
];

const settings: LocalInpaintSettings = {
  baseUrl: "http://127.0.0.1:8188",
  model: "klein-9b",
  connectionStatus: "idle",
  experimental: true,
};

const snapshot: SelectionSnapshot = {
  documentId: "doc-1",
  documentWidth: 1000,
  documentHeight: 800,
  selectionBounds: { x: 100, y: 100, width: 100, height: 80 },
  cropBounds: { x: 0, y: 0, width: 500, height: 400 },
  targetWidth: 768,
  targetHeight: 608,
  contextBytes: new Uint8Array([1, 2, 3]),
  maskBytes: new Uint8Array([4, 5, 6]),
  removalFillColor: 0xe8e9eb,
  mimeType: "image/png",
};
const baseRequest = { prompt: "", count: 1, seed: 10, snapshot };

function objectInfo(overrides: { diffusion?: string[]; clip?: string[]; vae?: string[] } = {}) {
  const info = Object.fromEntries(requiredNodes.map((node) => [node, { input: { required: {} } }]));
    info.UNETLoader.input.required = {
    unet_name: [overrides.diffusion ?? ["flux-2-klein-9b-fp8.safetensors"]],
  };
  info.CLIPLoader.input.required = {
    clip_name: [overrides.clip ?? ["qwen_3_8b_fp8mixed.safetensors"]],
  };
  info.VAELoader.input.required = {
    vae_name: [overrides.vae ?? ["flux2-vae.safetensors"]],
  };
  return info;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LocalInpaintProvider", () => {
  it("reports an actionable port-specific error when ComfyUI is offline", async () => {
    const provider = new LocalInpaintProvider(
      { ...settings, baseUrl: "http://127.0.0.1:9999" },
      { fetchFn: vi.fn(async () => { throw new TypeError("connection refused"); }) },
    );
    await expect(provider.checkHealth(new AbortController().signal))
      .rejects.toThrow("无法连接本地 ComfyUI（127.0.0.1:9999）");
  });

  it("reports the exact missing 9B file without falling through to generation", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (
      String(url).endsWith("/system_stats")
        ? json({ devices: [{ name: "RTX 2080 Ti" }] })
        : json(objectInfo({ diffusion: ["other-model.safetensors"] }))
    ));
    const provider = new LocalInpaintProvider(settings, { fetchFn });
    await expect(provider.checkHealth(new AbortController().signal))
      .rejects.toThrow(/缺少 9B 模型文件：flux-2-klein-9b-fp8\.safetensors/);
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
  });

  it("reports a missing core node before any workflow submission", async () => {
    const info = objectInfo();
    delete info.ReferenceLatent;
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (
      String(url).endsWith("/system_stats")
        ? json({ devices: [{ name: "RTX" }] })
        : json(info)
    ));
    const provider = new LocalInpaintProvider(settings, { fetchFn });
    await expect(provider.checkHealth(new AbortController().signal))
      .rejects.toThrow("ComfyUI 缺少核心节点：ReferenceLatent");
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
  });

  it("accepts ComfyUI builds that double-encode object_info", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => (
      String(url).endsWith("/system_stats")
        ? json({ devices: [{ name: "RTX 2080 Ti" }] })
        : json(JSON.stringify(objectInfo()))
    ));
    const provider = new LocalInpaintProvider(settings, { fetchFn });
    await expect(provider.checkHealth(new AbortController().signal))
      .resolves.toEqual({ deviceName: "RTX 2080 Ti", model: "klein-9b" });
  });

  it("builds the documented 9B distilled sampler parameters using PreviewImage", () => {
    const nine = buildKleinWorkflow(settings, baseRequest, "context.png", "mask.png", 10);
    expect(nine["13"].inputs.steps).toBe(4);
    expect(nine["14"].inputs.cfg).toBe(1);
    expect(nine["15"].inputs.sampler_name).toBe("euler");
    expect(nine["2"].class_type).toBe("ImageScaleToTotalPixels");
    expect(nine["2"].inputs.megapixels).toBe(1);
    expect(nine["3"].class_type).toBe("GetImageSize");
    expect(nine["9"].inputs.pixels).toEqual(["28", 0]);
    expect(nine["20"].class_type).toBe("ConditioningSetAreaStrength");
    expect(nine["20"].inputs.strength).toBe(1.65);
    expect(nine["10"].inputs.conditioning).toEqual(["20", 0]);
    expect(nine["7"].inputs.text).toContain("Treat the selected area as unwanted content to remove");
    expect(nine["7"].inputs.text).toContain("Never copy the selected content back");
    expect(nine["12"].inputs.width).toEqual(["3", 0]);
    expect(nine["13"].inputs.height).toEqual(["3", 1]);
    expect(Object.values(nine).filter((node) => node.class_type === "LoadImage")).toHaveLength(1);
    expect(nine["21"].class_type).toBe("LoadImageMask");
    expect(nine["21"].inputs.image).toBe("mask.png");
    expect(nine["22"].class_type).toBe("GrowMask");
    expect(nine["22"].inputs.expand).toBe(18);
    expect(nine["23"].class_type).toBe("FeatherMask");
    expect(nine["23"].inputs.left).toBe(4);
    expect(nine["24"].class_type).toBe("MaskToImage");
    expect(nine["25"].class_type).toBe("ImageScale");
    expect(nine["25"].inputs.width).toEqual(["3", 0]);
    expect(nine["25"].inputs.height).toEqual(["3", 1]);
    expect(nine["26"].class_type).toBe("ImageToMask");
    expect(nine["27"].class_type).toBe("EmptyImage");
    expect(nine["27"].inputs.color).toBe(0xe8e9eb);
    expect(nine["28"].class_type).toBe("ImageCompositeMasked");
    expect(nine["28"].inputs.destination).toEqual(["2", 0]);
    expect(nine["28"].inputs.mask).toEqual(["26", 0]);
    expect(nine["29"].class_type).toBe("ImageScale");
    expect(nine["29"].inputs.image).toEqual(["18", 0]);
    expect(nine["29"].inputs.width).toBe(snapshot.cropBounds.width);
    expect(nine["29"].inputs.height).toBe(snapshot.cropBounds.height);
    expect(nine["30"].class_type).toBe("ImageCompositeMasked");
    expect(nine["30"].inputs.destination).toEqual(["1", 0]);
    expect(nine["30"].inputs.source).toEqual(["29", 0]);
    expect(nine["30"].inputs.mask).toEqual(["23", 0]);
    expect(nine["31"].class_type).toBe("PreviewImage");
    expect(nine["31"].inputs.images).toEqual(["30", 0]);
    expect(Object.values(nine).some((node) => node.class_type === "SaveImage")).toBe(false);
    const subtle = buildKleinWorkflow(
      settings,
      { ...baseRequest, strength: "subtle" },
      "context.png",
      "mask.png",
      10,
    );
    const balanced = buildKleinWorkflow(
      settings,
      { ...baseRequest, strength: "balanced" },
      "context.png",
      "mask.png",
      10,
    );
    expect(subtle["20"].inputs.strength).toBe(0.85);
    expect(balanced["20"].inputs.strength).toBe(1.2);
    expect(subtle["22"].inputs.expand).toBe(0);
    expect(subtle["23"].inputs.left).toBe(12);
    expect(balanced["22"].inputs.expand).toBe(6);
    expect(balanced["23"].inputs.left).toBe(8);

    const bareRemoval = buildKleinWorkflow(
      settings,
      { ...baseRequest, prompt: "移除" },
      "context.png",
      "mask.png",
      10,
    );
    expect(bareRemoval["7"].inputs.text).toContain("completely remove");
    expect(bareRemoval["7"].inputs.text).toContain("inside the selected area");
  });

  it("turns Chinese removal requests into explicit English object-removal instructions", () => {
    const hair = buildKleinWorkflow(
      settings,
      { ...baseRequest, prompt: "移除头发" },
      "context.png",
      "mask.png",
      10,
    );
    expect(hair["7"].inputs.text).toContain("completely remove: the hair");
    expect(hair["7"].inputs.text).toContain("No hair, bun, or unwanted object may remain");
    expect(hair["7"].inputs.text).toContain("Extend the surrounding background");

    const extraHair = buildKleinWorkflow(
      settings,
      { ...baseRequest, prompt: "请把多余的头发去掉" },
      "context.png",
      "mask.png",
      10,
    );
    expect(extraHair["7"].inputs.text).toContain("completely remove: the extra hair");
    expect(extraHair["27"].inputs.color).toBe(8421504);

    const topClump = buildKleinWorkflow(
      settings,
      { ...baseRequest, prompt: "请移除头顶多出来的这一团" },
      "context.png",
      "mask.png",
      10,
    );
    expect(topClump["7"].inputs.text)
      .toContain("completely remove: the extra clump of hair on top of the head");
  });

  it("treats OBJECT REMOVAL instructions as removal intent", () => {
    const objectRemoval = buildKleinWorkflow(
      settings,
      {
        ...baseRequest,
        prompt: "OBJECT REMOVAL. Completely remove the selected upper hair bun and every hair strand inside the selected area.",
      },
      "context.png",
      "mask.png",
      10,
    );
    expect(objectRemoval["7"].inputs.text).toContain("completely remove");
    expect(objectRemoval["7"].inputs.text)
      .toContain("completely remove: the selected upper hair bun");
    expect(objectRemoval["7"].inputs.text).not.toContain("the OBJECT REMOVAL");
    expect(objectRemoval["7"].inputs.text)
      .toContain("every hair strand inside the selected area");
    expect(objectRemoval["7"].inputs.text).toContain("Do not preserve the unwanted feature");
    expect(objectRemoval["27"].inputs.color).toBe(8421504);
  });

  it("recognizes a removal label even when the prompt has no removal verb", () => {
    const labeledRemoval = buildKleinWorkflow(
      settings,
      {
        ...baseRequest,
        prompt: "OBJECT REMOVAL. Fill the selected area with the surrounding background.",
      },
      "context.png",
      "mask.png",
      10,
    );
    expect(labeledRemoval["7"].inputs.text).toContain("completely remove");
    expect(labeledRemoval["27"].inputs.color).toBe(0xe8e9eb);
  });

  it("uses the sampled surrounding color for an empty-prompt removal", () => {
    const emptyPrompt = buildKleinWorkflow(
      settings,
      { ...baseRequest, prompt: "" },
      "context.png",
      "mask.png",
      10,
    );
    expect(emptyPrompt["7"].inputs.text).toContain("Treat the selected area as unwanted content to remove");
    expect(emptyPrompt["7"].inputs.text).toContain("Do not create a replacement object");
    expect(emptyPrompt["7"].inputs.text).toContain("Never generate a replacement object, hair, a hair bun");
    expect(emptyPrompt["27"].inputs.color).toBe(0xe8e9eb);
  });

  it("uses direct background continuation only for a confirmed uniform removal background", () => {
    const uniformBackground = buildKleinWorkflow(
      settings,
      {
        ...baseRequest,
        snapshot: { ...snapshot, removalBackgroundUniform: true },
      },
      "context.png",
      "mask.png",
      10,
    );
    expect(uniformBackground["29"].inputs.image).toEqual(["28", 0]);

    const texturedBackground = buildKleinWorkflow(
      settings,
      {
        ...baseRequest,
        snapshot: { ...snapshot, removalBackgroundUniform: false },
      },
      "context.png",
      "mask.png",
      10,
    );
    expect(texturedBackground["29"].inputs.image).toEqual(["18", 0]);
  });

  it("uses a separately supplied soft mask for final compositing", () => {
    const workflow = buildKleinWorkflow(
      settings,
      { prompt: "repair", count: 1, seed: 10, snapshot },
      "context.png",
      "selection-mask.png",
      10,
      "soft-mask.png",
    );
    expect(workflow["30"].inputs.mask).toEqual(["32", 0]);
    expect(workflow["32"]).toEqual({
      class_type: "LoadImageMask",
      inputs: { image: "soft-mask.png", channel: "red" },
    });
  });

  it("refuses an empty selection mask instead of submitting a full-image workflow", async () => {
    const fetchFn = vi.fn();
    const provider = new LocalInpaintProvider(settings, { fetchFn });
    await expect(provider.generate(
      {
        prompt: "",
        count: 1,
        seed: 1,
        snapshot: { ...snapshot, maskBytes: new Uint8Array() },
      },
      new AbortController().signal,
    )).rejects.toThrow("局部重绘遮罩为空");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uploads once, submits each candidate once, polls history, and downloads temp output", async () => {
    let uploadIndex = 0;
    let promptIndex = 0;
    const seeds: number[] = [];
    const prompts: string[] = [];
    const uploadFolders: string[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/system_stats")) return json({ devices: [{ name: "RTX 2080 Ti" }] });
      if (value.endsWith("/object_info")) return json(objectInfo());
      if (value.endsWith("/upload/image")) {
        uploadIndex += 1;
        const form = init?.body as FormData;
        const folder = String(form.get("subfolder"));
        expect((form.get("image") as Blob).type).toBe("image/png");
        uploadFolders.push(folder);
        return json({ name: "blob", subfolder: folder });
      }
      if (value.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body));
        expect(body.prompt["31"].class_type).toBe("PreviewImage");
        expect(body.prompt["1"].inputs.image).not.toBe(body.prompt["21"].inputs.image);
        seeds.push(body.prompt["16"].inputs.noise_seed);
        prompts.push(body.prompt["7"].inputs.text);
        promptIndex += 1;
        return json({ prompt_id: `prompt-${promptIndex}` });
      }
      if (value.endsWith("/history/prompt-1") || value.endsWith("/history/prompt-2")) {
        const suffix = value.endsWith("prompt-1") ? "1" : "2";
        return json({
          [`prompt-${suffix}`]: {
            outputs: { "20": { images: [{ filename: `preview-${suffix}.png`, type: "temp" }] } },
          },
        });
      }
      if (value.includes("/view?")) {
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      throw new Error(`unexpected ${value}`);
    });
    const provider = new LocalInpaintProvider(settings, { fetchFn, pollIntervalMs: 1 });
    const result = await provider.generate(
      { prompt: "移除双下巴", count: 2, seed: 20, snapshot },
      new AbortController().signal,
    );
    expect(result).toHaveLength(2);
    expect(Array.from(result[0].bytes)).toEqual([9, 8, 7]);
    expect(seeds).toEqual([20, 1_000_023]);
    expect(prompts[0]).toContain("completely remove: the double chin");
    expect(prompts[1]).toBe(prompts[0]);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(2);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/upload/image"))).toHaveLength(2);
    expect(new Set(uploadFolders).size).toBe(2);
  });

  it("uploads and wires the native soft mask separately from the model mask", async () => {
    const uploads: string[] = [];
    let submitted: Record<string, any> | undefined;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/system_stats")) return json({ devices: [{ name: "RTX" }] });
      if (value.endsWith("/object_info")) return json(objectInfo());
      if (value.endsWith("/upload/image")) {
        const form = init?.body as FormData;
        const folder = String(form.get("subfolder"));
        uploads.push(String((form.get("image") as Blob).size));
        return json({ name: "blob", subfolder: folder });
      }
      if (value.endsWith("/prompt")) {
        submitted = JSON.parse(String(init?.body)).prompt;
        return json({ prompt_id: "prompt-soft-mask" });
      }
      if (value.endsWith("/history/prompt-soft-mask")) {
        return json({ "prompt-soft-mask": {
          outputs: { "31": { images: [{ filename: "soft.png", type: "temp" }] } },
        } });
      }
      if (value.includes("/view?")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      throw new Error(`unexpected ${value}`);
    });
    const provider = new LocalInpaintProvider(settings, { fetchFn, pollIntervalMs: 1 });
    await provider.generate(
      {
        prompt: "repair",
        count: 1,
        seed: 1,
        snapshot: {
          ...snapshot,
          compositeMaskBytes: new Uint8Array([7, 8]),
          compositeMaskMimeType: "image/png",
        },
      },
      new AbortController().signal,
    );
    expect(uploads).toHaveLength(3);
    expect(submitted?.["30"].inputs.mask).toEqual(["32", 0]);
    expect(submitted?.["32"].inputs.image).not.toBe(submitted?.["21"].inputs.image);
  });

  it("does not resubmit a workflow when history polling fails", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith("/system_stats")) return json({ devices: [{ name: "RTX" }] });
      if (value.endsWith("/object_info")) return json(objectInfo());
      if (value.endsWith("/upload/image")) return json({ name: value.includes("mask") ? "mask.png" : "input.png" });
      if (value.endsWith("/prompt")) return json({ prompt_id: "prompt-1" });
      if (value.endsWith("/history/prompt-1")) return json({ error: "temporary" }, 500);
      throw new Error(`unexpected ${value}`);
    });
    const provider = new LocalInpaintProvider(settings, { fetchFn, pollIntervalMs: 1 });
    await expect(provider.generate(
      { prompt: "repair", count: 1, seed: 1, snapshot },
      new AbortController().signal,
    )).rejects.toThrow(/读取 Klein 任务状态失败/);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
  });

  it("surfaces a local timeout without resubmitting the same prompt", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value.endsWith("/system_stats")) return json({ devices: [{ name: "RTX" }] });
      if (value.endsWith("/object_info")) return json(objectInfo());
      if (value.endsWith("/upload/image")) return json({ name: "input.png" });
      if (value.endsWith("/prompt")) return json({ prompt_id: "prompt-timeout" });
      if (value.endsWith("/history/prompt-timeout")) return json({});
      throw new Error(`unexpected ${value}`);
    });
    const provider = new LocalInpaintProvider(settings, { fetchFn, pollIntervalMs: 1, timeoutMs: 3 });
    await expect(provider.generate(
      { prompt: "repair", count: 1, seed: 1, snapshot },
      new AbortController().signal,
    )).rejects.toThrow("本地 Klein 生成超时");
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
  });

  it("deletes a still-queued candidate on cancellation without interrupting ComfyUI", async () => {
    const abortController = new AbortController();
    let deleteBody: unknown;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/system_stats")) return json({ devices: [{ name: "RTX" }] });
      if (value.endsWith("/object_info")) return json(objectInfo());
      if (value.endsWith("/upload/image")) return json({ name: "input.png" });
      if (value.endsWith("/prompt")) return json({ prompt_id: "prompt-1" });
      if (value.endsWith("/history/prompt-1")) {
        setTimeout(() => abortController.abort(), 1);
        return json({});
      }
      if (value.endsWith("/queue") && init?.method === "POST") {
        deleteBody = JSON.parse(String(init.body));
        return json({});
      }
      if (value.endsWith("/queue")) return json({ queue_pending: [["prompt-1"]] });
      throw new Error(`unexpected ${value}`);
    });
    const provider = new LocalInpaintProvider(settings, { fetchFn, pollIntervalMs: 20 });
    await expect(provider.generate(
      { prompt: "", count: 1, seed: 1, snapshot },
      abortController.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(deleteBody).toEqual({ delete: ["prompt-1"] });
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/interrupt"))).toBe(false);
    expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/prompt"))).toHaveLength(1);
  });

  it("leaves a running candidate alone on cancellation", async () => {
    const abortController = new AbortController();
    let deletePosts = 0;
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/system_stats")) return json({ devices: [{ name: "RTX" }] });
      if (value.endsWith("/object_info")) return json(objectInfo());
      if (value.endsWith("/upload/image")) return json({ name: "input.png" });
      if (value.endsWith("/prompt")) return json({ prompt_id: "prompt-running" });
      if (value.endsWith("/history/prompt-running")) {
        setTimeout(() => abortController.abort(), 1);
        return json({});
      }
      if (value.endsWith("/queue") && init?.method === "POST") {
        deletePosts += 1;
        return json({});
      }
      if (value.endsWith("/queue")) return json({ queue_running: [["prompt-running"]], queue_pending: [] });
      throw new Error(`unexpected ${value}`);
    });
    const provider = new LocalInpaintProvider(settings, { fetchFn, pollIntervalMs: 20 });
    await expect(provider.generate(
      { prompt: "", count: 1, seed: 1, snapshot },
      abortController.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(deletePosts).toBe(0);
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/interrupt"))).toBe(false);
  });
});
