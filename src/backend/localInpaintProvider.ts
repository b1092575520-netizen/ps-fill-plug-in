import type {
  GeneratedImageAsset,
} from "./contracts";
import type {
  LocalInpaintModel,
  LocalInpaintSettings,
  InpaintStrength,
  SelectionSnapshot,
} from "../types";
import { InpaintIntentPlanner } from "../inpaintIntentPlanner";

type FetchLike = typeof fetch;

interface ComfyImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: ComfyImage[] }>;
  status?: { status_str?: string; messages?: unknown[] };
}

export interface LocalInpaintRequest {
  prompt: string;
  count: number;
  seed: number;
  snapshot: SelectionSnapshot;
  strength?: InpaintStrength;
}

export interface LocalInpaintHealth {
  deviceName: string;
  model: LocalInpaintModel;
}

export interface LocalInpaintProviderContract {
  checkHealth(signal: AbortSignal): Promise<LocalInpaintHealth>;
  generate(
    request: LocalInpaintRequest,
    signal: AbortSignal,
    onProgress?: (value: number) => void,
  ): Promise<GeneratedImageAsset[]>;
}

const MODEL_CONFIG = {
  "klein-9b": {
    diffusion: "flux-2-klein-9b-fp8.safetensors",
    clip: "qwen_3_8b_fp8mixed.safetensors",
    steps: 4,
    cfg: 1,
  },
} as const;

const VAE_MODEL = "flux2-vae.safetensors";
const REQUIRED_NODES = [
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
] as const;

function normalizeLocalBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("本地 ComfyUI 地址无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("本地 ComfyUI 地址只支持 HTTP 或 HTTPS");
  }
  return trimmed;
}

function endpoint(baseUrl: string, path: string) {
  return `${normalizeLocalBaseUrl(baseUrl)}${path}`;
}

async function responseJson<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${action}失败（HTTP ${response.status}）`);
  }
  const value = await response.json() as unknown;
  // Some ComfyUI builds serialize /object_info as a JSON string containing
  // the node dictionary. Accept both that response and the normal object.
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      // Keep the original value so the caller can report its normal shape
      // error rather than hiding a provider response behind a parse error.
    }
  }
  return value as T;
}

function requiredCombo(info: Record<string, unknown>, node: string, input: string): string[] {
  const nodeInfo = info[node] as {
    input?: { required?: Record<string, unknown> };
  } | undefined;
  const definition = nodeInfo?.input?.required?.[input];
  if (!Array.isArray(definition) || !Array.isArray(definition[0])) return [];
  return definition[0].filter((value): value is string => typeof value === "string");
}

function queueContains(queue: unknown, promptId: string) {
  return Array.isArray(queue) && queue.some((item) => (
    Array.isArray(item) && item.some((value) => value === promptId)
  ));
}

function abortError() {
  return new DOMException("已取消本地局部重绘", "AbortError");
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

const STRENGTH_CONFIG: Record<
  InpaintStrength,
  { conditioning: number; maskGrow: number; maskFeather: number; instruction: string }
> = {
  subtle: {
    conditioning: 0.85,
    maskGrow: 0,
    maskFeather: 12,
    instruction: "Make a subtle, conservative edit while still completing the requested change.",
  },
  balanced: {
    conditioning: 1.2,
    maskGrow: 6,
    maskFeather: 8,
    instruction: "Make the requested change clearly and noticeably, while preserving unrelated details.",
  },
  strong: {
    conditioning: 1.65,
    maskGrow: 18,
    maskFeather: 4,
    instruction: "Make the requested change decisive and unmistakable. Do not return an unchanged or barely changed result.",
  },
};

const REMOVAL_VERB = /(?:移除|去除|删除|消除|擦除|去掉|清除|拿掉|抹掉|remove|removal|delete|erase|take\s+away)/iu;

function parseEnglishRemovalTarget(requested: string) {
  const match = requested.match(
    /\b(?:remove|erase|delete)\b\s+(?:the\s+)?(?:selected\s+)?(.+?)(?:(?:\s+(?:completely|fully|entirely)\b)|[.!?]|$)/iu,
  );
  if (!match?.[1]) return "";
  const candidate = match[1]
    .replace(/\s+(?:and|or)\s+(?:every|all)\b.*$/iu, "")
    .replace(/\s+(?:inside|within|from)\s+(?:the\s+)?selected\s+area.*$/iu, "")
    .trim();
  if (!candidate || /^(?:the\s+)?selected\s+area$/iu.test(candidate)) return "";
  if (/\b(?:upper\s+)?hair\s+bun\b|\bbun\b/iu.test(candidate)) {
    return "the selected upper hair bun";
  }
  if (/\b(?:extra|unwanted)\s+(?:clump|tuft)\s+of\s+hair\b/iu.test(candidate)) {
    return "the extra clump of hair on top of the head";
  }
  if (/\bhair\b/iu.test(candidate)) return "the hair";
  return /^(?:the|a|an)\s/iu.test(candidate) ? candidate : `the ${candidate}`;
}

function removalTarget(requested: string) {
  const normalized = requested
    .replace(/^[\s，。！？,:：;；]*(?:请|请帮我|帮我|麻烦|我想|我要|希望|把|将|给我)\s*/u, "")
    .replace(/^(?:please|kindly|could you|can you)\s+/iu, "")
    .replace(/\s*(?:移除|去除|删除|消除|擦除|去掉|清除|拿掉|抹掉|remove|delete|erase|take\s+away)\s*[。！？.!?]*$/iu, "")
    .replace(/^[\s，。！？,:：;；]*(?:移除|去除|删除|消除|擦除|去掉|清除|拿掉|抹掉|remove|delete|erase|take\s+away)\s*/iu, "")
    .trim();

  if (/(?:头顶|头上).*(?:一团|一撮|一束|多出来|多余)|(?:一团|一撮|一束)(?:多余的?)?头发/u.test(normalized)) {
    return "the extra clump of hair on top of the head";
  }
  if (/(?:多余的?|额外的?)头发/u.test(normalized)) return "the extra hair";
  if (/发髻|发团/u.test(normalized)) return "the hair bun";
  if (/头发/u.test(normalized)) return "the hair";
  if (/双下巴/u.test(normalized)) return "the double chin";
  if (/下巴/u.test(normalized)) return "the chin";
  if (/衣服|衣物|布料/u.test(normalized) && /多出|多余|露出|一截|一段/u.test(normalized)) {
    return "the extra piece of clothing";
  }
  if (/衣服|衣物|布料/u.test(normalized)) return "the clothing";
  if (/耳朵/u.test(normalized)) return "the ear";
  if (/眼睛|眼珠/u.test(normalized)) return "the eye";
  if (/鼻子/u.test(normalized)) return "the nose";
  if (/嘴巴|嘴唇/u.test(normalized)) return "the mouth";

  const parsedEnglish = parseEnglishRemovalTarget(normalized);
  if (parsedEnglish) return parsedEnglish;
  if (/\b(?:object\s+)?removal\b/iu.test(normalized)) {
    return "the unwanted object or feature inside the selected area";
  }

  const english = normalized
    .replace(/^(?:please|kindly|could you|can you)\s+/iu, "")
    .trim();
  if (english && /^[\x00-\x7F]+$/u.test(english)) {
    return /^(?:the|a|an)\s/iu.test(english) ? english : `the ${english}`;
  }
  return "the unwanted object or feature inside the selected area";
}

function isRemovalIntent(prompt: string) {
  return !prompt.trim() || REMOVAL_VERB.test(prompt)
    || /\b(?:object\s+)?removal\b|\bunwanted\s+(?:content|object|feature)\b/iu.test(prompt);
}

function compileInpaintIntent(prompt: string, strength: InpaintStrength = "strong") {
  const requested = prompt.trim();
  const policy = STRENGTH_CONFIG[strength].instruction;
  const reconstruction = "Extend the surrounding background into the selected area with matching color, texture, lighting and perspective. Do not create a replacement object.";
  if (!requested) {
    return `Treat the selected area as unwanted content to remove, not as a subject to recreate. If the selected content is hair or a bun, remove the hair or bun completely; otherwise remove the selected object or feature completely. Naturally reconstruct the missing anatomy or background from the surrounding context. ${reconstruction} Never generate a replacement object, hair, a hair bun, a coil, a facial feature, clothing, or any recognizable foreground detail inside the selected area. ${policy} Preserve identity, realistic anatomy, skin texture, lighting and perspective outside the selected area. Never copy the selected content back into the result. No unwanted object or trace may remain.`;
  }
  if (isRemovalIntent(requested)) {
    const target = removalTarget(requested);
    const removalSubject = /hair|bun/iu.test(target)
      ? `${target} and every hair strand inside the selected area`
      : target;
    const residual = /hair|bun/iu.test(target)
      ? "No hair, bun, or unwanted object may remain."
      : `No ${target.replace(/^the\s+/iu, "")} or unwanted object may remain.`;
    return `OBJECT REMOVAL. The user explicitly wants to completely remove: ${target}. Completely remove ${removalSubject}. Reconstruct the missing anatomy or background naturally. ${reconstruction} ${policy} ${residual} Do not preserve the unwanted feature and do not leave traces.`;
  }
  return `User's exact instruction: ${requested}. ${policy} Follow the instruction as the primary objective. Preserve identity and unrelated details unless the instruction asks to change them.`;
}

export function buildKleinWorkflow(
  settings: LocalInpaintSettings,
  request: LocalInpaintRequest,
  contextFile: string,
  maskFile: string,
  seed: number,
  compositeMaskFile = maskFile,
) {
  const model = MODEL_CONFIG[settings.model];
  const strength = request.strength ?? "strong";
  const directRemovalFill = !request.prompt.trim()
    && request.snapshot.removalBackgroundUniform === true;
  const hairRemoval = /(?:头发|发髻|发团|丸子头|\bhair\b|\bbun\b)/iu.test(request.prompt);
  const maskInstruction = maskFile
    ? "The masked region is the exact user-selected edit area. Make the requested change there, preserve everything outside it, and do not return the unmodified original."
    : "";
  const intent = new InpaintIntentPlanner().plan({
    selectionBounds: request.snapshot.selectionBounds,
    contextImage: {
      width: request.snapshot.documentWidth,
      height: request.snapshot.documentHeight,
      mimeType: request.snapshot.mimeType,
    },
    userPrompt: request.prompt,
    strength,
  });
  const prompt = `${intent.compiledPrompt} ${maskInstruction} Do not add text, borders, or unrelated objects.`.trim();
  const workflow: Record<string, any> = {
    "1": { class_type: "LoadImage", inputs: { image: contextFile } },
    // The official Klein image-edit graph first normalizes the reference image
    // to one megapixel, then derives both the latent and scheduler dimensions
    // from the scaled image. This keeps the model's reference pathway intact
    // instead of encoding a small Photoshop crop directly.
    "2": {
      class_type: "ImageScaleToTotalPixels",
      inputs: {
        image: ["1", 0],
        upscale_method: "nearest-exact",
        megapixels: 1,
        resolution_steps: 1,
      },
    },
    "3": { class_type: "GetImageSize", inputs: { image: ["2", 0] } },
    "4": {
      class_type: "UNETLoader",
      inputs: { unet_name: model.diffusion, weight_dtype: "default" },
    },
    "5": {
      class_type: "CLIPLoader",
      inputs: { clip_name: model.clip, type: "flux2", device: "default" },
    },
    "6": { class_type: "VAELoader", inputs: { vae_name: VAE_MODEL } },
    "7": { class_type: "CLIPTextEncode", inputs: { clip: ["5", 0], text: prompt } },
    "8": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["7", 0] } },
    "9": { class_type: "VAEEncode", inputs: { pixels: [maskFile ? "28" : "2", 0], vae: ["6", 0] } },
    "10": {
      class_type: "ReferenceLatent",
      inputs: { conditioning: ["20", 0], latent: ["9", 0] },
    },
    "11": {
      class_type: "ReferenceLatent",
      inputs: { conditioning: ["8", 0], latent: ["9", 0] },
    },
    "12": {
      class_type: "EmptyFlux2LatentImage",
      inputs: {
        width: ["3", 0],
        height: ["3", 1],
        batch_size: 1,
      },
    },
    "13": {
      class_type: "Flux2Scheduler",
      inputs: {
        steps: model.steps,
        width: ["3", 0],
        height: ["3", 1],
      },
    },
    "14": {
      class_type: "CFGGuider",
      inputs: {
        model: ["4", 0],
        positive: ["10", 0],
        negative: ["11", 0],
        cfg: model.cfg,
      },
    },
    "15": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "16": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "17": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["16", 0],
        guider: ["14", 0],
        sampler: ["15", 0],
        sigmas: ["13", 0],
        latent_image: ["12", 0],
      },
    },
    "18": { class_type: "VAEDecode", inputs: { samples: ["17", 0], vae: ["6", 0] } },
    "20": {
      class_type: "ConditioningSetAreaStrength",
      inputs: { conditioning: ["7", 0], strength: STRENGTH_CONFIG[strength].conditioning },
    },
  };
  if (maskFile) {
    workflow["21"] = {
      class_type: "LoadImageMask",
      inputs: { image: maskFile, channel: "red" },
    };
    workflow["22"] = {
      class_type: "GrowMask",
      inputs: {
        mask: ["21", 0],
        expand: STRENGTH_CONFIG[strength].maskGrow,
        tapered_corners: true,
      },
    };
    workflow["23"] = {
      class_type: "FeatherMask",
      inputs: {
        mask: ["22", 0],
        left: STRENGTH_CONFIG[strength].maskFeather,
        top: STRENGTH_CONFIG[strength].maskFeather,
        right: STRENGTH_CONFIG[strength].maskFeather,
        bottom: STRENGTH_CONFIG[strength].maskFeather,
      },
    };
    workflow["24"] = {
      class_type: "MaskToImage",
      inputs: { mask: ["23", 0] },
    };
    workflow["25"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["24", 0],
        upscale_method: "nearest-exact",
        width: ["3", 0],
        height: ["3", 1],
        crop: "disabled",
      },
    };
    workflow["26"] = {
      class_type: "ImageToMask",
      inputs: { image: ["25", 0], channel: "red" },
    };
    workflow["27"] = {
      class_type: "EmptyImage",
      inputs: {
        width: ["3", 0],
        height: ["3", 1],
        batch_size: 1,
        // Hair-bun removal is deliberately kept on the neutral-gray prefill
        // validated against the real top-bun sample. A light sampled fill
        // tends to be interpreted as a new hair highlight at that boundary.
        // Other removal targets still use the sampled surrounding color.
        color: isRemovalIntent(request.prompt)
          ? hairRemoval
            ? 8421504
            : request.snapshot.removalFillColor ?? 0xffffff
          : 8421504,
      },
    };
    workflow["28"] = {
      class_type: "ImageCompositeMasked",
      inputs: {
        destination: ["2", 0],
        source: ["27", 0],
        x: 0,
        y: 0,
        resize_source: false,
        mask: ["26", 0],
      },
    };
    workflow["29"] = {
      class_type: "ImageScale",
      inputs: {
        // When Photoshop reports a light, uniform surrounding background and
        // the prompt is empty, direct continuation is safer than asking Klein
        // to invent a replacement object. Non-uniform backgrounds continue to
        // use the learned image-edit path.
        image: directRemovalFill ? ["28", 0] : ["18", 0],
        upscale_method: "lanczos",
        width: request.snapshot.cropBounds.width,
        height: request.snapshot.cropBounds.height,
        crop: "disabled",
      },
    };
    workflow["30"] = {
      class_type: "ImageCompositeMasked",
      inputs: {
        // Keep the native-resolution context as the destination. This makes
        // every pixel outside the selection byte-for-byte identical to the
        // Photoshop crop and avoids a second resampling pass on writeback.
        destination: ["1", 0],
        source: ["29", 0],
        x: 0,
        y: 0,
        resize_source: false,
        mask: compositeMaskFile === maskFile
          ? ["23", 0]
          : ["32", 0],
      },
    };
    if (compositeMaskFile !== maskFile) {
      workflow["32"] = {
        class_type: "LoadImageMask",
        inputs: { image: compositeMaskFile, channel: "red" },
      };
    }
    workflow["31"] = { class_type: "PreviewImage", inputs: { images: ["30", 0] } };
  } else {
    workflow["19"] = { class_type: "PreviewImage", inputs: { images: ["18", 0] } };
  }
  return workflow;
}

export class LocalInpaintProvider implements LocalInpaintProviderContract {
  private readonly fetchFn: FetchLike;
  private readonly clientId = `photoshop-klein-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly settings: LocalInpaintSettings,
    dependencies: { fetchFn?: FetchLike; pollIntervalMs?: number; timeoutMs?: number } = {},
  ) {
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
    this.timeoutMs = dependencies.timeoutMs ?? 10 * 60_000;
  }

  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  async checkHealth(signal: AbortSignal): Promise<LocalInpaintHealth> {
    let statsResponse: Response;
    let objectInfoResponse: Response;
    try {
      [statsResponse, objectInfoResponse] = await Promise.all([
        this.fetchFn(endpoint(this.settings.baseUrl, "/system_stats"), { signal }),
        this.fetchFn(endpoint(this.settings.baseUrl, "/object_info"), { signal }),
      ]);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      const address = new URL(normalizeLocalBaseUrl(this.settings.baseUrl));
      throw new Error(`无法连接本地 ComfyUI（${address.host}）`);
    }
    const stats = await responseJson<Record<string, unknown>>(statsResponse, "读取 ComfyUI 状态");
    const info = await responseJson<Record<string, unknown>>(objectInfoResponse, "读取 ComfyUI 节点");
    const missingNodes = REQUIRED_NODES.filter((node) => !(node in info));
    if (missingNodes.length) {
      throw new Error(`ComfyUI 缺少核心节点：${missingNodes.join("、")}`);
    }
    const config = MODEL_CONFIG[this.settings.model];
    const missingModels = [
      ...requiredCombo(info, "UNETLoader", "unet_name").includes(config.diffusion)
        ? [] : [config.diffusion],
      ...requiredCombo(info, "CLIPLoader", "clip_name").includes(config.clip)
        ? [] : [config.clip],
      ...requiredCombo(info, "VAELoader", "vae_name").includes(VAE_MODEL)
        ? [] : [VAE_MODEL],
    ];
    if (missingModels.length) {
      throw new Error(`ComfyUI 缺少 9B 模型文件：${missingModels.join("、")}`);
    }
    const device = (stats.devices as Array<{ name?: string }> | undefined)?.[0]?.name ?? "ComfyUI";
    return { deviceName: device, model: this.settings.model };
  }

  async generate(
    request: LocalInpaintRequest,
    signal: AbortSignal,
    onProgress: (value: number) => void = () => undefined,
  ): Promise<GeneratedImageAsset[]> {
    if (!request.snapshot.maskBytes.length) {
      throw new Error("局部重绘遮罩为空，已拒绝全图生成");
    }
    await this.checkHealth(signal);
    const contextName = await this.upload(
      request.snapshot.contextBytes,
      `ps-fill-klein-context-${Date.now()}.png`,
      signal,
    );
    const maskName = request.snapshot.maskBytes.length
      ? await this.upload(
        request.snapshot.maskBytes,
        `ps-fill-klein-mask-${Date.now()}.${request.snapshot.maskMimeType === "image/jpeg" ? "jpg" : "png"}`,
        signal,
        request.snapshot.maskMimeType ?? "image/png",
      )
      : "";
    const compositeMaskName = request.snapshot.compositeMaskBytes?.length
      ? await this.upload(
        request.snapshot.compositeMaskBytes,
        `ps-fill-klein-composite-mask-${Date.now()}.png`,
        signal,
        request.snapshot.compositeMaskMimeType ?? "image/png",
      )
      : maskName;
    const assets: GeneratedImageAsset[] = [];
    for (let index = 0; index < request.count; index += 1) {
      if (signal.aborted) throw abortError();
      const seed = request.seed + index * 1_000_003;
      const workflow = buildKleinWorkflow(
        this.settings,
        {
          ...request,
        },
        contextName,
        maskName,
        seed,
        compositeMaskName,
      );
      const promptId = await this.submit(workflow, signal);
      try {
        const image = await this.poll(promptId, signal, (fraction) => {
          onProgress(Math.round(((index + fraction) / request.count) * 100));
        });
        assets.push(await this.download(image, signal, index));
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          await this.deleteQueuedPrompt(promptId);
        }
        throw error;
      }
    }
    onProgress(100);
    return assets;
  }

  private async upload(
    bytes: Uint8Array,
    fileName: string,
    signal: AbortSignal,
    mimeType = "image/png",
  ) {
    const form = new FormData();
    const data = new Uint8Array(bytes).slice().buffer;
    form.append("image", new Blob([data], { type: mimeType }), fileName);
    form.append("type", "input");
    // UXP's FormData implementation may discard the third filename
    // argument and ComfyUI then reports every upload as "blob". Isolate
    // each upload in its own folder so the context and mask can never
    // overwrite one another.
    form.append(
      "subfolder",
      `ps-fill-klein-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    form.append("overwrite", "false");
    const response = await this.fetchFn(endpoint(this.settings.baseUrl, "/upload/image"), {
      method: "POST",
      body: form,
      signal,
    });
    const uploaded = await responseJson<{ name?: string; subfolder?: string }>(response, "上传局部重绘素材");
    if (!uploaded.name) throw new Error("ComfyUI 未返回上传文件名");
    return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  }

  private async submit(workflow: Record<string, unknown>, signal: AbortSignal) {
    const response = await this.fetchFn(endpoint(this.settings.baseUrl, "/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
      signal,
    });
    const data = await responseJson<{ prompt_id?: string; node_errors?: Record<string, unknown> }>(
      response,
      "提交 Klein 工作流",
    );
    if (!data.prompt_id) {
      const nodes = Object.keys(data.node_errors ?? {});
      throw new Error(nodes.length
        ? `Klein 工作流校验失败：${nodes.join("、")}`
        : "ComfyUI 未返回 prompt_id");
    }
    return data.prompt_id;
  }

  private async poll(
    promptId: string,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<ComfyImage> {
    const startedAt = Date.now();
    for (;;) {
      if (signal.aborted) throw abortError();
      if (Date.now() - startedAt > this.timeoutMs) {
        throw new Error("本地 Klein 生成超时");
      }
      const response = await this.fetchFn(
        endpoint(this.settings.baseUrl, `/history/${encodeURIComponent(promptId)}`),
        { signal },
      );
      const history = await responseJson<Record<string, ComfyHistoryEntry>>(response, "读取 Klein 任务状态");
      const entry = history[promptId];
      if (entry) {
        const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
        if (images.length) return images[0];
        if (entry.status?.status_str === "error") {
          throw new Error("本地 Klein 工作流执行失败");
        }
      }
      const elapsedFraction = Math.min(0.95, (Date.now() - startedAt) / this.timeoutMs);
      onProgress(elapsedFraction);
      await wait(this.pollIntervalMs, signal);
    }
  }

  private async download(image: ComfyImage, signal: AbortSignal, index: number) {
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? "",
      type: image.type ?? "temp",
    });
    const response = await this.fetchFn(endpoint(this.settings.baseUrl, `/view?${query}`), { signal });
    if (!response.ok) throw new Error(`下载 Klein 结果失败（HTTP ${response.status}）`);
    const mimeType = response.headers.get("content-type") ?? "image/png";
    return {
      id: `klein-${Date.now()}-${index}`,
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType,
    };
  }

  private async deleteQueuedPrompt(promptId: string) {
    try {
      const response = await this.fetchFn(endpoint(this.settings.baseUrl, "/queue"));
      if (!response.ok) return;
      const queue = await response.json() as {
        queue_running?: unknown;
        queue_pending?: unknown;
      };
      if (queueContains(queue.queue_running, promptId)) return;
      if (!queueContains(queue.queue_pending, promptId)) return;
      await this.fetchFn(endpoint(this.settings.baseUrl, "/queue"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      });
    } catch {
      // Cancellation is best-effort and must never interrupt other ComfyUI jobs.
    }
  }
}
