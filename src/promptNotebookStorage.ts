import type { GenerationMode, PromptNote } from "./types";

const STORAGE_KEY = "generative-fill.prompt-notebook.v1";
const DATA_FILE_NAME = "prompt-notebook.v1.json";

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

function isMode(value: unknown): value is GenerationMode | "all" {
  return value === "all" || value === "text" || value === "redraw";
}

function finiteOr(value: unknown, fallback: number) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/** Favorites the user reaches for most come first; ties keep saving order. */
export function normalizePromptNotes(value: unknown): PromptNote[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt || seen.has(prompt)) return [];
    seen.add(prompt);
    const now = Date.now();
    return [{
      id: typeof record.id === "string" && record.id.trim() ? record.id : `note-${now}-${index}`,
      title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : noteTitleFromPrompt(prompt),
      prompt,
      mode: isMode(record.mode) ? record.mode : "all",
      pinned: record.pinned === true,
      order: finiteOr(record.order, index),
      createdAt: finiteOr(record.createdAt, now),
      updatedAt: finiteOr(record.updatedAt, now),
      useCount: Math.max(0, Math.round(finiteOr(record.useCount, 0))),
      lastUsedAt: finiteOr(record.lastUsedAt, 0),
    }];
  }).sort((a, b) => b.useCount - a.useCount || a.order - b.order || a.createdAt - b.createdAt)
    .map((note, order) => ({ ...note, order }));
}

const TITLE_LENGTH = 10;

/** A short label for a chip: the start of the prompt's first line. */
export function noteTitleFromPrompt(prompt: string) {
  const firstLine = prompt.trim().split(/\r?\n/)[0].trim();
  const characters = Array.from(firstLine);
  return characters.length > TITLE_LENGTH ? `${characters.slice(0, TITLE_LENGTH).join("")}…` : firstLine;
}

export function findNoteByPrompt(notes: PromptNote[], prompt: string) {
  const text = prompt.trim();
  return text ? notes.find((note) => note.prompt === text) : undefined;
}

export function addFavoritePrompt(notes: PromptNote[], prompt: string, now = Date.now()) {
  const text = prompt.trim();
  if (!text || findNoteByPrompt(notes, text)) return notes;
  return normalizePromptNotes([...notes, {
    id: `note-${now}`,
    title: noteTitleFromPrompt(text),
    prompt: text,
    mode: "all",
    pinned: false,
    order: notes.length,
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    lastUsedAt: 0,
  }]);
}

export function markPromptNoteUsed(notes: PromptNote[], id: string, now = Date.now()) {
  return normalizePromptNotes(notes.map((note) => note.id === id
    ? { ...note, useCount: note.useCount + 1, lastUsedAt: now }
    : note));
}

export function renamePromptNote(notes: PromptNote[], id: string, title: string, now = Date.now()) {
  const name = title.trim();
  return normalizePromptNotes(notes.map((note) => note.id === id
    ? { ...note, title: name || noteTitleFromPrompt(note.prompt), updatedAt: now }
    : note));
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
    if (uxpPayload === null) return [];
    try {
      return normalizePromptNotes(JSON.parse(uxpPayload));
    } catch {
      return [];
    }
  }
  if (typeof window === "undefined") return [];
  const payload = window.localStorage?.getItem(STORAGE_KEY);
  if (payload === null || payload === undefined) return [];
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
