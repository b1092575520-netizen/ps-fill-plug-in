import type { GeneratedImageAsset } from "./backend/contracts";

export type GenerationMode = "text" | "redraw" | "inpaint";
export type LocalInpaintModel = "klein-9b";
export type ImageQuality = "low" | "medium" | "high";
export type ImageResolution = "api-default" | "1K" | "2K" | "4K";
export type InpaintStrength = "subtle" | "balanced" | "strong";
export type CapabilitySource = "api" | "adapter" | "default" | "cache";
export type JobStatus = "idle" | "queued" | "running" | "completed" | "cancelled";
export type GenerationStage = "idle" | "capturing" | "uploading" | "submitting" | "generating" | "downloading" | "completed";
export type SelectionReadStatus = "ready" | "reading" | "missing" | "error";
export type OutputTarget = "new-document" | "current-document";
export type ThemeKey = "graphite" | "midnight" | "sakura" | "forest" | "aurora" | "sunset";

export const ASPECT_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface ModelCapability {
  id: string;
  confirmedImage: boolean;
  resolutions: ImageResolution[];
  qualityOptions: ImageQuality[];
  aspectRatios: AspectRatio[];
  defaultResolution: ImageResolution;
  sizeMap?: Partial<Record<Exclude<ImageResolution, "api-default">, Partial<Record<AspectRatio, string>>>>;
}

export interface ProviderSnapshot {
  models: ModelCapability[];
  credentialVerified: boolean;
  source: CapabilitySource;
  fetchedAt: number;
  stale: boolean;
}

export interface BalanceSnapshot {
  status: "idle" | "loading" | "available" | "unsupported" | "error";
  remaining?: number;
  total?: number;
  used?: number;
  unit: "积分";
  expiresAt?: number | null;
  unlimited?: boolean;
  updatedAt?: number;
  error?: string;
}

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionSnapshot {
  documentId: string;
  documentWidth: number;
  documentHeight: number;
  selectionBounds: SelectionBounds;
  cropBounds: SelectionBounds;
  targetWidth: number;
  targetHeight: number;
  contextBytes: Uint8Array;
  maskBytes: Uint8Array;
  /** Median RGB color sampled outside the selection for removal prefill. */
  removalFillColor?: number;
  /** True when the sampled surrounding area is a safe, light uniform fill. */
  removalBackgroundUniform?: boolean;
  maskMimeType?: "image/png" | "image/jpeg";
  /** Optional native-resolution blend mask; outside-selection pixels are zero. */
  compositeMaskBytes?: Uint8Array;
  compositeMaskMimeType?: "image/png";
  selectionChannelName?: string;
  mimeType: "image/png";
}

export interface LocalInpaintSettings {
  baseUrl: string;
  model: LocalInpaintModel;
  connectionStatus: "idle" | "testing" | "connected" | "failed";
  experimental: boolean;
}

export interface PhotoshopContext {
  documentId: string;
  documentName: string;
  width: number;
  height: number;
  colorMode: string;
  selection: SelectionBounds | null;
}

export interface ReferenceImage {
  id: string;
  name: string;
  url: string;
  order: number;
  file?: Blob;
  remoteUrl?: string;
  kind?: "user" | "photoshop-context";
}

export interface GenerationDraft {
  mode: GenerationMode;
  prompt: string;
  model: string;
  resolution: ImageResolution;
  quality: ImageQuality;
  count: number;
  aspectRatio: AspectRatio | "custom" | "auto";
  customWidth: number;
  customHeight: number;
  outputTarget: OutputTarget;
  references: ReferenceImage[];
  inpaintStrength?: InpaintStrength;
}

export interface Candidate {
  id: string;
  title: string;
  url: string;
  aspectRatio: string;
  selected: boolean;
  asset?: GeneratedImageAsset;
  sourceDocumentId?: string;
  outputTarget?: OutputTarget;
  selection?: SelectionBounds | null;
  selectionSnapshot?: SelectionSnapshot;
  generationMode?: GenerationMode;
  photoshopLayerId?: string;
}

export interface GenerationJob {
  id: string;
  createdAt: string;
  draft: GenerationDraft;
  context: PhotoshopContext | null;
  outputRatio: string;
  status: Exclude<JobStatus, "idle">;
  progress: number;
  candidates: Candidate[];
}

export interface ConnectionSettings {
  baseUrl: string;
  apiKey: string;
  modelOptions: string[];
  connectionStatus: "idle" | "testing" | "reachable" | "connected" | "failed";
  providerSnapshot: ProviderSnapshot | null;
}

export interface PromptNote {
  id: string;
  title: string;
  prompt: string;
  mode: GenerationMode | "all";
  pinned: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  mode: GenerationMode;
  lastUsedAt: number;
}

export interface CloudTaskRecord {
  taskId: string;
  model: string;
  status: string;
  createdAt: number | null;
  completedAt: number | null;
  thumbnailUrl: string | null;
  origin: "plugin" | "external-or-unknown";
}

export interface ToastMessage {
  id: number;
  kind: "success" | "warning" | "info";
  text: string;
}

export const MODE_META: Record<GenerationMode, { label: string; description: string }> = {
  text: { label: "文生图", description: "按提示词创建全新画面" },
  redraw: { label: "图生图", description: "以当前可见画面为基础生成" },
  inpaint: { label: "局部重绘", description: "跟随 Photoshop 当前选区" },
};

export const QUALITY_META: Record<ImageQuality, { label: string; hint: string }> = {
  low: { label: "低", hint: "更快" },
  medium: { label: "中", hint: "均衡" },
  high: { label: "高", hint: "精细" },
};
