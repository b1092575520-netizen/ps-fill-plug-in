import {
  ASPECT_RATIOS,
  type GenerationDraft,
  type GenerationMode,
  type ModelCapability,
  type PhotoshopContext,
  type ProviderSnapshot,
} from "../types";
import { XINBAO_SIZE_MAP, capabilityForModel } from "./providerCapabilities";
import type {
  GeneratedImageAsset,
  ImageGenerationRequest,
  ReferenceUploader,
} from "./contracts";
import type { RemoteRequestAudit } from "../remoteRequestLedger";

export interface ImageProvider {
  generate(
    request: ImageGenerationRequest,
    signal: AbortSignal,
    onProgress?: (value: number) => void,
  ): Promise<GeneratedImageAsset[]>;
}

export interface GenerationServiceRequest {
  draft: GenerationDraft;
  modelOptions: string[];
  apiKey: string;
  signal: AbortSignal;
  onProgress: (value: number) => void;
  uploader?: ReferenceUploader;
  onStage?: (stage: "uploading" | "submitting" | "generating") => void;
  context?: PhotoshopContext;
  providerSnapshot?: ProviderSnapshot | null;
  remoteProvider: ImageProvider;
  remoteAudit?: RemoteRequestAudit;
}

export class GenerationService {
  async generate(request: GenerationServiceRequest) {
    return generateFromDraft(
      request.remoteProvider,
      request.draft,
      request.modelOptions,
      request.apiKey,
      request.signal,
      request.onProgress,
      request.uploader,
      request.onStage,
      request.context,
      request.providerSnapshot,
      request.remoteAudit,
    );
  }
}

export function generationModel(model: string, options: string[], snapshot?: ProviderSnapshot | null) {
  if (model !== "auto") return model;
  if (snapshot) return snapshot.models.find((option) => option.confirmedImage)?.id ?? "";
  return options.find((option) => option !== "auto") ?? "";
}

export function conciseLayerName(prompt: string, mode: GenerationMode) {
  const fallback = mode === "redraw" ? "图生图" : "生成图像";
  const firstDescription = prompt.trim().split(/[,，。；;\n]/, 1)[0] ?? "";
  const normalized = firstDescription
    .replace(/^(?:请|帮我|给我)?(?:生成|创建|绘制|画出?|制作|添加|变成|重绘成?)\s*/u, "")
    .replace(/^(?:一|1)\s*(?:只|朵|个|张|幅|片|株|条|头|位|名|颗|棵|支|束|件)\s*/u, "")
    .replace(/[的\s"'“”‘’]/gu, "")
    .trim();
  return normalized.slice(0, 24) || fallback;
}

export function normalizeOpenAiImagePrompt(prompt: string) {
  const trimmed = prompt.trim();
  return trimmed.startsWith("创建图片,") ? trimmed : `创建图片,${trimmed}`;
}

export function generationSize(
  model: string,
  draft: GenerationDraft,
  capability?: ModelCapability,
): string | undefined {
  const knownXinbao = ["gpt-image-2", "gpt-image-2-oai"].includes(model);
  const sizeMap = capability?.sizeMap ?? (knownXinbao ? XINBAO_SIZE_MAP : undefined);
  if (!sizeMap || draft.resolution === "api-default") return undefined;
  if (draft.aspectRatio === "auto") return model === "gpt-image-2-oai" ? "auto" : undefined;
  if (draft.aspectRatio === "custom") return undefined;
  return sizeMap[draft.resolution]?.[draft.aspectRatio]
    ?? sizeMap[draft.resolution]?.["1:1"];
}

export function realGenerationBlocker(
  draft: GenerationDraft,
  apiKey: string,
  isUxp: boolean,
  context?: PhotoshopContext | null,
) {
  if (isUxp && !apiKey.trim()) return "请先配置 API Key";
  const needsDocument = draft.mode !== "text" || draft.outputTarget === "current-document";
  if (isUxp && context === null && needsDocument) return "请先打开 Photoshop 文档";
  if (!draft.prompt.trim()) {
    return "请先填写提示词";
  }
  if (!draft.model.trim()) return "请先选择模型";
  if (draft.mode === "text" && draft.aspectRatio === "custom") {
    return "请设置有效比例：真实接口暂只支持预设比例";
  }
  const reservedReferences = draft.mode === "redraw" ? 1 : 0;
  const manualReferenceCount = draft.references.filter((reference) => reference.kind !== "photoshop-context").length;
  if (reservedReferences && manualReferenceCount > 9 - reservedReferences) {
    return `图生图会自动加入 ${reservedReferences} 张 Photoshop 上下文图，手动参考图最多 ${9 - reservedReferences} 张`;
  }
  return "";
}

function closestAspectRatio(width: number, height: number) {
  const target = width / height;
  return ASPECT_RATIOS.reduce((best, ratio) => {
    const [w, h] = ratio.split(":").map(Number);
    const [bestW, bestH] = best.split(":").map(Number);
    return Math.abs(Math.log(w / h / target)) < Math.abs(Math.log(bestW / bestH / target))
      ? ratio
      : best;
  }, ASPECT_RATIOS[0]);
}

function modePrompt(draft: GenerationDraft, context?: PhotoshopContext) {
  if (draft.mode === "redraw") {
    return `请保持参考图的主体结构和构图关系，将整幅重绘为：${draft.prompt.trim()}`;
  }
  return draft.prompt.trim();
}

async function resolveReferenceUrls(
  draft: GenerationDraft,
  uploader: ReferenceUploader | undefined,
  signal: AbortSignal,
) {
  const references = [...draft.references].sort((a, b) => a.order - b.order);
  return Promise.all(references.map(async (reference) => {
    if (reference.remoteUrl) return reference.remoteUrl;
    if (reference.url.startsWith("https://")) return reference.url;
    if (!reference.file) throw new Error(`参考图“${reference.name}”缺少可上传的本地文件`);
    if (!uploader) throw new Error("参考图上传服务未配置");
    return uploader.upload(reference.file, reference.name, signal);
  }));
}

export async function generateFromDraft(
  provider: ImageProvider,
  draft: GenerationDraft,
  modelOptions: string[],
  apiKey: string,
  signal: AbortSignal,
  onProgress: (value: number) => void,
  uploader?: ReferenceUploader,
  onStage?: (stage: "uploading" | "submitting" | "generating") => void,
  context?: PhotoshopContext,
  providerSnapshot?: ProviderSnapshot | null,
  remoteAudit?: RemoteRequestAudit,
) {
  const blocker = realGenerationBlocker(draft, apiKey, true, context);
  if (blocker) throw new Error(blocker);
  if (draft.mode !== "text" && !draft.references.length) {
    throw new Error("当前 Photoshop 画面快照缺失");
  }
  const model = generationModel(draft.model, modelOptions, providerSnapshot);
  if (!model) throw new Error("当前渠道没有可自动选择的已确认图片模型，请手动选择模型");
  if (draft.references.length) onStage?.("uploading");
  const imageUrls = await resolveReferenceUrls(draft, uploader, signal);
  onStage?.("submitting");
  onStage?.("generating");
  const effectiveDraft = draft.mode === "text" || !context
    ? draft
    : {
        ...draft,
        aspectRatio: closestAspectRatio(context.width, context.height),
      };
  const prompt = modePrompt(draft, context);
  const capability = capabilityForModel(providerSnapshot ?? null, model);
  const knownQualityModel = model === "gpt-image-2-oai";
  const supportsQuality = capability
    ? capability.qualityOptions.includes(draft.quality)
    : knownQualityModel;
  const assets = await provider.generate({
    prompt: model.toLowerCase().startsWith("gpt-image-")
      ? normalizeOpenAiImagePrompt(prompt)
      : prompt,
    model,
    imageUrls,
    n: draft.count,
    responseFormat: "url",
    size: generationSize(model, effectiveDraft, capability),
    quality: supportsQuality ? draft.quality : undefined,
    audit: remoteAudit,
  }, signal, onProgress);
  const layerName = conciseLayerName(draft.prompt, draft.mode);
  return assets.map((asset) => ({ ...asset, layerName }));
}
