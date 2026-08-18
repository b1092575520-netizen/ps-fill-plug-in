import {
  ASPECT_RATIOS,
  type GenerationDraft,
  type GenerationMode,
  type ImageQuality,
  type ImageResolution,
  type OutputTarget,
} from "./types";

const STORAGE_KEY = "generative-fill.generation-settings.v1";
const DATA_FILE_NAME = "generation-settings.v1.json";

export interface RememberedModeSettings {
  model: string;
  resolution: ImageResolution;
  quality: ImageQuality;
  count: number;
  aspectRatio: GenerationDraft["aspectRatio"];
  customWidth: number;
  customHeight: number;
  outputTarget: OutputTarget;
}

export interface GenerationSettingsMemory {
  version: 1;
  enabled: boolean;
  byMode: Partial<Record<GenerationMode, RememberedModeSettings>>;
}

type UxpRequire = (moduleName: string) => any;
type UxpFile = { read: () => Promise<string>; write: (value: string) => Promise<void> };
type UxpFolder = {
  getEntry?: (name: string) => Promise<UxpFile>;
  createFile?: (name: string, options?: { overwrite?: boolean }) => Promise<UxpFile>;
};

export const DEFAULT_GENERATION_SETTINGS_MEMORY: GenerationSettingsMemory = {
  version: 1,
  enabled: true,
  byMode: {},
};

function getUxpRequire(): UxpRequire | null {
  const candidate = (globalThis as typeof globalThis & { require?: UxpRequire }).require;
  if (typeof candidate !== "function") return null;
  try { candidate("uxp"); return candidate; } catch { return null; }
}

function normalizeModeSettings(value: unknown): RememberedModeSettings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const resolutions: ImageResolution[] = ["api-default", "1K", "2K", "4K"];
  const qualities: ImageQuality[] = ["low", "medium", "high"];
  const ratios: Array<GenerationDraft["aspectRatio"]> = ["auto", "custom", ...ASPECT_RATIOS];
  const targets: OutputTarget[] = ["new-document", "current-document"];
  if (
    typeof record.model !== "string"
    || !resolutions.includes(record.resolution as ImageResolution)
    || !qualities.includes(record.quality as ImageQuality)
    || !ratios.includes(record.aspectRatio as GenerationDraft["aspectRatio"])
    || !targets.includes(record.outputTarget as OutputTarget)
  ) return null;
  const count = Math.trunc(Number(record.count));
  const customWidth = Math.trunc(Number(record.customWidth));
  const customHeight = Math.trunc(Number(record.customHeight));
  if (
    !Number.isFinite(count) || count < 1 || count > 4
    || !Number.isFinite(customWidth) || customWidth < 1 || customWidth > 100
    || !Number.isFinite(customHeight) || customHeight < 1 || customHeight > 100
  ) return null;
  return {
    model: record.model,
    resolution: record.resolution as ImageResolution,
    quality: record.quality as ImageQuality,
    count,
    aspectRatio: record.aspectRatio as GenerationDraft["aspectRatio"],
    customWidth,
    customHeight,
    outputTarget: record.outputTarget as OutputTarget,
  };
}

export function normalizeGenerationSettingsMemory(value: unknown): GenerationSettingsMemory {
  if (!value || typeof value !== "object") return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} };
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} };
  const source = record.byMode && typeof record.byMode === "object"
    ? record.byMode as Record<string, unknown>
    : {};
  const byMode: GenerationSettingsMemory["byMode"] = {};
  (["text", "redraw", "inpaint"] as const).forEach((mode) => {
    const normalized = normalizeModeSettings(source[mode]);
    if (normalized) byMode[mode] = normalized;
  });
  return { version: 1, enabled: record.enabled !== false, byMode };
}

export function settingsFromDraft(draft: GenerationDraft): RememberedModeSettings {
  return {
    model: draft.model,
    resolution: draft.resolution,
    quality: draft.quality,
    count: Math.min(4, Math.max(1, Math.round(draft.count))),
    aspectRatio: draft.aspectRatio,
    customWidth: Math.min(100, Math.max(1, Math.round(draft.customWidth))),
    customHeight: Math.min(100, Math.max(1, Math.round(draft.customHeight))),
    outputTarget: draft.outputTarget,
  };
}

export function applyRememberedSettings(
  draft: GenerationDraft,
  memory: GenerationSettingsMemory,
  mode: GenerationMode = draft.mode,
): GenerationDraft {
  const remembered = memory.enabled ? memory.byMode[mode] : undefined;
  return {
    ...draft,
    ...(remembered ?? {}),
    mode,
    prompt: draft.prompt,
    references: draft.references,
    inpaintStrength: draft.inpaintStrength,
  };
}

async function readUxpPayload(): Promise<string | null | undefined> {
  const requireUxp = getUxpRequire();
  if (!requireUxp) return undefined;
  try {
    const folder = await requireUxp("uxp").storage.localFileSystem.getDataFolder() as UxpFolder;
    if (!folder.getEntry) return null;
    return await (await folder.getEntry(DATA_FILE_NAME)).read();
  } catch { return null; }
}

async function writeUxpPayload(payload: string) {
  const requireUxp = getUxpRequire();
  if (!requireUxp) return false;
  const folder = await requireUxp("uxp").storage.localFileSystem.getDataFolder() as UxpFolder;
  let file: UxpFile;
  try {
    if (!folder.getEntry) throw new Error("UXP 数据目录不可读");
    file = await folder.getEntry(DATA_FILE_NAME);
  } catch {
    if (!folder.createFile) throw new Error("UXP 数据目录不可写");
    file = await folder.createFile(DATA_FILE_NAME, { overwrite: true });
  }
  await file.write(payload);
  return true;
}

export async function loadGenerationSettingsMemory(): Promise<GenerationSettingsMemory> {
  const uxpPayload = await readUxpPayload();
  if (uxpPayload !== undefined) {
    if (uxpPayload === null) return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} };
    try { return normalizeGenerationSettingsMemory(JSON.parse(uxpPayload)); } catch { return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} }; }
  }
  if (typeof window === "undefined" || !window.localStorage) return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} };
  const payload = window.localStorage.getItem(STORAGE_KEY);
  if (!payload) return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} };
  try { return normalizeGenerationSettingsMemory(JSON.parse(payload)); } catch { return { ...DEFAULT_GENERATION_SETTINGS_MEMORY, byMode: {} }; }
}

export async function saveGenerationSettingsMemory(memory: GenerationSettingsMemory) {
  const payload = JSON.stringify(normalizeGenerationSettingsMemory(memory));
  if (await writeUxpPayload(payload)) return;
  if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(STORAGE_KEY, payload);
}

export { STORAGE_KEY as GENERATION_SETTINGS_STORAGE_KEY };
