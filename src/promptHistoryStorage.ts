import type { GenerationMode, PromptHistoryEntry } from "./types";

const STORAGE_KEY = "generative-fill.prompt-history.v1";
const DATA_FILE_NAME = "prompt-history.v1.json";
const MAX_HISTORY = 50;

type UxpRequire = (moduleName: string) => any;
type UxpFile = { read: () => Promise<string>; write: (value: string) => Promise<void> };
type UxpFolder = {
  getEntry?: (name: string) => Promise<UxpFile>;
  createFile?: (name: string, options?: { overwrite?: boolean }) => Promise<UxpFile>;
};

function getUxpRequire(): UxpRequire | null {
  const candidate = (globalThis as typeof globalThis & { require?: UxpRequire }).require;
  if (typeof candidate !== "function") return null;
  try { candidate("uxp"); return candidate; } catch { return null; }
}

function isMode(value: unknown): value is GenerationMode {
  return value === "text" || value === "redraw" || value === "inpaint";
}

export function normalizePromptHistory(value: unknown): PromptHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt || seen.has(prompt) || !isMode(record.mode) || !Number.isFinite(record.lastUsedAt)) return [];
    seen.add(prompt);
    return [{
      id: typeof record.id === "string" && record.id ? record.id : `history-${Number(record.lastUsedAt)}-${index}`,
      prompt,
      mode: record.mode,
      lastUsedAt: Number(record.lastUsedAt),
    }];
  }).sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_HISTORY);
}

export function recordPromptHistory(
  current: PromptHistoryEntry[],
  promptValue: string,
  mode: GenerationMode,
  now = Date.now(),
) {
  const prompt = promptValue.trim();
  if (!prompt) return normalizePromptHistory(current);
  const next: PromptHistoryEntry = {
    id: `history-${now}`,
    prompt,
    mode,
    lastUsedAt: now,
  };
  return normalizePromptHistory([next, ...current.filter((entry) => entry.prompt !== prompt)]);
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

export async function loadPromptHistory(): Promise<PromptHistoryEntry[]> {
  const uxpPayload = await readUxpPayload();
  if (uxpPayload !== undefined) {
    if (uxpPayload === null) return [];
    try { return normalizePromptHistory(JSON.parse(uxpPayload)); } catch { return []; }
  }
  if (typeof window === "undefined" || !window.localStorage) return [];
  const payload = window.localStorage.getItem(STORAGE_KEY);
  if (!payload) return [];
  try { return normalizePromptHistory(JSON.parse(payload)); } catch { return []; }
}

export async function savePromptHistory(entries: PromptHistoryEntry[]) {
  const payload = JSON.stringify(normalizePromptHistory(entries));
  if (await writeUxpPayload(payload)) return;
  if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(STORAGE_KEY, payload);
}

export { MAX_HISTORY as PROMPT_HISTORY_LIMIT, STORAGE_KEY as PROMPT_HISTORY_STORAGE_KEY };
