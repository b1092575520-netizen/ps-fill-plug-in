import {
  ASPECT_RATIOS,
  type AspectRatio,
  type ImageQuality,
  type ImageResolution,
  type ModelCapability,
  type ProviderSnapshot,
} from "../types";

const XINBAO_MODELS = ["gpt-image-2-oai", "gpt-image-2"] as const;

export const XINBAO_SIZE_MAP: NonNullable<ModelCapability["sizeMap"]> = {
  "1K": {
    "1:1": "1024x1024",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "21:9": "1344x576",
  },
  "2K": {
    "1:1": "2048x2048",
    "2:3": "1360x2048",
    "3:2": "2048x1360",
    "4:3": "2048x1536",
    "3:4": "1536x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "21:9": "2400x1024",
  },
  "4K": {
    "1:1": "2880x2880",
    "2:3": "2336x3504",
    "3:2": "3504x2336",
    "4:3": "3264x2448",
    "3:4": "2448x3264",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "21:9": "3840x1648",
  },
};

function xinbaoModel(id: typeof XINBAO_MODELS[number]): ModelCapability {
  return {
    id,
    confirmedImage: true,
    resolutions: ["1K", "2K", "4K"],
    qualityOptions: id === "gpt-image-2-oai" ? ["low", "medium", "high"] : [],
    aspectRatios: [...ASPECT_RATIOS],
    defaultResolution: "2K",
    sizeMap: XINBAO_SIZE_MAP,
  };
}

export function isXinbaoAsyncBase(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "async.xinbao-ai.com";
  } catch {
    return false;
  }
}

export function xinbaoBalanceBaseUrl(baseUrl: string) {
  return isXinbaoAsyncBase(baseUrl) ? "https://xinbaoapi.dpdns.org" : baseUrl;
}

export function xinbaoTaskHistoryBaseUrl(baseUrl: string) {
  return isXinbaoAsyncBase(baseUrl) ? "https://task.xinbao-ai.com" : null;
}

export function xinbaoTaskBatchBaseUrl(baseUrl: string) {
  return isXinbaoAsyncBase(baseUrl) ? "https://async.xinbao-ai.com" : null;
}

export function createXinbaoSnapshot(credentialVerified = false): ProviderSnapshot {
  return {
    models: XINBAO_MODELS.map(xinbaoModel),
    credentialVerified,
    source: "adapter",
    fetchedAt: Date.now(),
    stale: false,
  };
}

type RemoteModel = {
  id?: unknown;
  modalities?: unknown;
  output_modalities?: unknown;
  capabilities?: unknown;
  resolutions?: unknown;
  image_sizes?: unknown;
  qualities?: unknown;
  quality_options?: unknown;
  aspect_ratios?: unknown;
};

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function capabilityObject(model: RemoteModel) {
  return model.capabilities && typeof model.capabilities === "object"
    ? model.capabilities as Record<string, unknown>
    : {};
}

function normalizeResolutions(values: string[]): ImageResolution[] {
  return values
    .map((value) => value.toUpperCase())
    .filter((value): value is Exclude<ImageResolution, "api-default"> =>
      value === "1K" || value === "2K" || value === "4K");
}

function normalizeQualities(values: string[]): ImageQuality[] {
  return values
    .map((value) => value.toLowerCase())
    .filter((value): value is ImageQuality =>
      value === "low" || value === "medium" || value === "high");
}

function normalizeRatios(values: string[]): AspectRatio[] {
  return values.filter((value): value is AspectRatio =>
    (ASPECT_RATIOS as readonly string[]).includes(value));
}

export function remoteModelCapabilities(models: RemoteModel[]): ModelCapability[] {
  return models.flatMap((model) => {
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id || id.toLowerCase().startsWith("gemini")) return [];
    const capabilities = capabilityObject(model);
    const modalities = [
      ...stringArray(model.modalities),
      ...stringArray(model.output_modalities),
      ...stringArray(capabilities.modalities),
      ...stringArray(capabilities.output_modalities),
    ].map((value) => value.toLowerCase());
    const resolutions = normalizeResolutions([
      ...stringArray(model.resolutions),
      ...stringArray(model.image_sizes),
      ...stringArray(capabilities.resolutions),
      ...stringArray(capabilities.image_sizes),
    ]);
    const qualityOptions = normalizeQualities([
      ...stringArray(model.qualities),
      ...stringArray(model.quality_options),
      ...stringArray(capabilities.qualities),
      ...stringArray(capabilities.quality_options),
    ]);
    const aspectRatios = normalizeRatios([
      ...stringArray(model.aspect_ratios),
      ...stringArray(capabilities.aspect_ratios),
    ]);
    const confirmedImage = modalities.includes("image") || capabilities.image === true;
    return [{
      id,
      confirmedImage,
      resolutions: resolutions.length ? resolutions : ["api-default"],
      qualityOptions,
      aspectRatios,
      defaultResolution: resolutions[0] ?? "api-default",
    }];
  });
}

export function snapshotModelOptions(snapshot: ProviderSnapshot | null) {
  if (!snapshot) return [];
  const ids = snapshot.models.map((model) => model.id);
  return snapshot.models.some((model) => model.confirmedImage) ? ["auto", ...ids] : ids;
}

export function capabilityForModel(snapshot: ProviderSnapshot | null, model: string) {
  if (!snapshot) return undefined;
  if (model === "auto") return snapshot.models.find((item) => item.confirmedImage);
  return snapshot.models.find((item) => item.id === model);
}

export function capabilitySourceLabel(snapshot: ProviderSnapshot | null) {
  if (!snapshot) return "尚未获取";
  if (snapshot.stale || snapshot.source === "cache") return "过期缓存";
  if (snapshot.source === "api") return "API 实时";
  if (snapshot.source === "adapter") return "心宝文档适配";
  return "安全默认";
}
