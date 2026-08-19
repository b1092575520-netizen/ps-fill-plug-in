import type { GenerationMode, PromptNote } from "./types";

const STORAGE_KEY = "generative-fill.prompt-notebook.v1";
const DATA_FILE_NAME = "prompt-notebook.v1.json";

export const DEFAULT_PROMPT_NOTES: PromptNote[] = [
  {
    id: "note-sunset-garden",
    title: "黄昏花海",
    prompt: "柔和黄昏光里的紫色花海，电影感摄影，细腻层次",
    mode: "all",
    pinned: true,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "note-product-studio",
    title: "产品棚拍",
    prompt: "极简产品棚拍，柔和侧光，干净背景，商业广告质感",
    mode: "text",
    pinned: false,
    order: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "note-architecture",
    title: "建筑空间",
    prompt: "现代建筑空间，暖色自然光，真实材质，广角摄影",
    mode: "redraw",
    pinned: false,
    order: 2,
    createdAt: 0,
    updatedAt: 0,
  },
];

type UxpRequire = (moduleName: string) => any;
type UxpFile = { read: () => Promise<string>; write: (value: string) => Promise<void> };
type UxpFolder = {
  getEntry?: (name: string) => Promise<UxpFile>;
  createFile?: (name: string, options?: { overwrite?: boolean }) => Promise<UxpFile>;
};

function getUxpRequire(): UxpRequire | null {
  const candidate = (globalThis as typeof globalThis & { require?: UxpRequire }).require;
  if (typeof candidate !== "function") return null;
  try {
    candidate("uxp");
    return candidate;
  } catch {
    return null;
  }
}

function cloneNotes(notes: PromptNote[]) {
  return notes.map((note) => ({ ...note }));
}

function isMode(value: unknown): value is GenerationMode | "all" {
  return value === "all" || value === "text" || value === "redraw";
}

export function normalizePromptNotes(value: unknown): PromptNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) return [];
    const now = Date.now();
    return [{
      id: typeof record.id === "string" && record.id.trim() ? record.id : `note-${now}-${index}`,
      title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : `提示词 ${index + 1}`,
      prompt,
      mode: isMode(record.mode) ? record.mode : "all",
      pinned: record.pinned === true,
      order: Number.isFinite(record.order) ? Number(record.order) : index,
      createdAt: Number.isFinite(record.createdAt) ? Number(record.createdAt) : now,
      updatedAt: Number.isFinite(record.updatedAt) ? Number(record.updatedAt) : now,
    }];
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.updatedAt - b.updatedAt)
    .map((note, order) => ({ ...note, order }));
}

async function readUxpPayload(): Promise<string | null | undefined> {
  const requireUxp = getUxpRequire();
  if (!requireUxp) return undefined;
  try {
    const folder = await requireUxp("uxp").storage.localFileSystem.getDataFolder() as UxpFolder;
    if (!folder.getEntry) return null;
    const file = await folder.getEntry(DATA_FILE_NAME);
    return await file.read();
  } catch {
    return null;
  }
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

export async function loadPromptNotes(): Promise<PromptNote[]> {
  const uxpPayload = await readUxpPayload();
  if (uxpPayload !== undefined) {
    if (uxpPayload === null) return cloneNotes(DEFAULT_PROMPT_NOTES);
    try {
      return normalizePromptNotes(JSON.parse(uxpPayload));
    } catch {
      return [];
    }
  }
  if (typeof window === "undefined") return cloneNotes(DEFAULT_PROMPT_NOTES);
  const payload = window.localStorage?.getItem(STORAGE_KEY);
  if (payload === null || payload === undefined) return cloneNotes(DEFAULT_PROMPT_NOTES);
  try {
    return normalizePromptNotes(JSON.parse(payload));
  } catch {
    return [];
  }
}

export async function savePromptNotes(notes: PromptNote[]) {
  const payload = JSON.stringify(normalizePromptNotes(notes));
  if (await writeUxpPayload(payload)) return;
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem(STORAGE_KEY, payload);
}

export { STORAGE_KEY as PROMPT_NOTE_STORAGE_KEY };
