import type { GenerationMode } from "./types";

const STORAGE_KEY = "generative-fill.remote-request-ledger.v1";
const DATA_FILE_NAME = "remote-request-ledger.v1.json";
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export type RemoteRequestStatus =
  | "submitting"
  | "running"
  | "downloading"
  | "completed"
  | "failed"
  | "uncertain";

export interface RemoteRequestAudit {
  localRequestId: string;
  documentId: string;
  mode: GenerationMode;
  submittedAt: number;
  promptHash: string;
}

export interface RemoteRequestRecord extends RemoteRequestAudit {
  model: string;
  postCount: number;
  providerTaskId?: string;
  status: RemoteRequestStatus;
}

export interface RemoteRequestControls {
  beforeGenerationPost(): Promise<void>;
  generationPostResponded(status: number): Promise<void>;
  taskAccepted(taskId: string): Promise<void>;
  setStatus(status: RemoteRequestStatus): Promise<void>;
}

export interface RemoteRequestStorage {
  load(): Promise<unknown>;
  save(records: RemoteRequestRecord[]): Promise<void>;
}

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

function isMode(value: unknown): value is GenerationMode {
  return value === "text" || value === "redraw";
}

function isStatus(value: unknown): value is RemoteRequestStatus {
  return ["submitting", "running", "downloading", "completed", "failed", "uncertain"].includes(String(value));
}

export function normalizeRemoteRequestRecords(value: unknown, now = Date.now()): RemoteRequestRecord[] {
  if (!Array.isArray(value)) return [];
  const cutoff = now - RETENTION_MS;
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.localRequestId !== "string"
      || typeof record.documentId !== "string"
      || !isMode(record.mode)
      || typeof record.model !== "string"
      || typeof record.promptHash !== "string"
      || !isStatus(record.status)
      || !Number.isFinite(record.submittedAt)
      || Number(record.submittedAt) < cutoff
      || Number(record.submittedAt) > now + 60_000
    ) return [];
    return [{
      localRequestId: record.localRequestId,
      documentId: record.documentId,
      mode: record.mode,
      model: record.model,
      submittedAt: Number(record.submittedAt),
      promptHash: record.promptHash,
      postCount: Math.min(1, Math.max(0, Math.trunc(Number(record.postCount) || 0))),
      ...(typeof record.providerTaskId === "string" && record.providerTaskId
        ? { providerTaskId: record.providerTaskId }
        : {}),
      status: record.status,
    }];
  }).sort((a, b) => b.submittedAt - a.submittedAt);
}

async function readUxpPayload(): Promise<string | null | undefined> {
  const requireUxp = getUxpRequire();
  if (!requireUxp) return undefined;
  try {
    const folder = await requireUxp("uxp").storage.localFileSystem.getDataFolder() as UxpFolder;
    if (!folder.getEntry) return null;
    return await (await folder.getEntry(DATA_FILE_NAME)).read();
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

export const defaultRemoteRequestStorage: RemoteRequestStorage = {
  async load() {
    const uxpPayload = await readUxpPayload();
    if (uxpPayload !== undefined) {
      if (uxpPayload === null) return [];
      try { return JSON.parse(uxpPayload); } catch { return []; }
    }
    if (typeof window === "undefined" || !window.localStorage) return [];
    const payload = window.localStorage.getItem(STORAGE_KEY);
    if (!payload) return [];
    try { return JSON.parse(payload); } catch { return []; }
  },
  async save(records) {
    const payload = JSON.stringify(normalizeRemoteRequestRecords(records));
    if (await writeUxpPayload(payload)) return;
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, payload);
    }
  },
};

export class RemoteRequestCoordinator {
  private records: RemoteRequestRecord[] = [];
  private loaded: Promise<void> | null = null;
  private activeRequestId: string | null = null;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storage: RemoteRequestStorage = defaultRemoteRequestStorage,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(
    audit: RemoteRequestAudit,
    model: string,
    operation: (controls: RemoteRequestControls) => Promise<T>,
  ): Promise<T> {
    await this.ensureLoaded();
    const duplicate = this.inFlight.get(audit.localRequestId) as Promise<T> | undefined;
    if (duplicate) return duplicate;
    if (this.activeRequestId) {
      throw new Error("已有一个付费远程任务正在运行，请等待完成后再试");
    }
    if (this.records.some((record) => record.localRequestId === audit.localRequestId && record.postCount > 0)) {
      throw new Error("该生成请求已经提交过，已阻止重复扣费");
    }

    const record: RemoteRequestRecord = {
      ...audit,
      model,
      postCount: 0,
      status: "submitting",
    };
    this.records = normalizeRemoteRequestRecords([record, ...this.records], this.now());
    this.activeRequestId = audit.localRequestId;

    const currentRecord = () => {
      const current = this.records.find((item) => item.localRequestId === audit.localRequestId);
      if (!current) throw new Error("远程请求账本记录丢失，已阻止付费提交");
      return current;
    };

    const controls: RemoteRequestControls = {
      beforeGenerationPost: async () => {
        const current = currentRecord();
        if (current.postCount !== 0) throw new Error("该生成请求已经提交过，已阻止重复扣费");
        current.postCount = 1;
        current.status = "submitting";
        await this.persist();
      },
      generationPostResponded: async (status) => {
        currentRecord().status = status >= 400 && status < 500 ? "failed" : "running";
        await this.persist();
      },
      taskAccepted: async (taskId) => {
        const current = currentRecord();
        current.providerTaskId = taskId;
        current.status = "running";
        await this.persist();
      },
      setStatus: async (status) => {
        currentRecord().status = status;
        await this.persist();
      },
    };

    const promise = this.persist()
      .then(() => operation(controls))
      .then(async (result) => {
        currentRecord().status = "completed";
        await this.persist();
        this.release(audit.localRequestId);
        return result;
      })
      .catch(async (error) => {
        const current = currentRecord();
        if (current.postCount === 0 || current.status === "failed") {
          current.status = "failed";
          this.release(audit.localRequestId);
        } else {
          current.status = "uncertain";
        }
        await this.persist();
        throw error;
      });
    this.inFlight.set(audit.localRequestId, promise);
    void promise.finally(() => this.inFlight.delete(audit.localRequestId)).catch(() => undefined);
    return promise;
  }

  snapshot() {
    return this.records.map((record) => ({ ...record }));
  }

  async listRecords() {
    await this.ensureLoaded();
    return this.snapshot();
  }

  async reconcileProviderTask(taskId: string, status: string) {
    await this.ensureLoaded();
    const record = this.records.find((item) => item.providerTaskId === taskId);
    if (!record) return;
    const normalizedStatus = status.trim().toLowerCase();
    if (["succeeded", "completed", "success"].includes(normalizedStatus)) record.status = "completed";
    else if (["failed", "error", "cancelled", "canceled", "not_found"].includes(normalizedStatus)) record.status = "failed";
    else return;
    this.release(record.localRequestId);
    await this.persist();
  }

  isBusy() {
    return this.activeRequestId !== null;
  }

  private async ensureLoaded() {
    if (!this.loaded) {
      this.loaded = this.storage.load().then((value) => {
        this.records = normalizeRemoteRequestRecords(value, this.now());
        const unresolved = this.records.find((record) => (
          record.postCount > 0 && ["submitting", "running", "downloading", "uncertain"].includes(record.status)
        ));
        this.activeRequestId = unresolved?.localRequestId ?? null;
      });
    }
    await this.loaded;
  }

  private persist() {
    this.records = normalizeRemoteRequestRecords(this.records, this.now());
    return this.storage.save(this.records);
  }

  private release(localRequestId: string) {
    if (this.activeRequestId === localRequestId) this.activeRequestId = null;
  }
}

function utf8Bytes(value: string) {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

export function hashPrompt(value: string) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotate = (number: number, bits: number) => (number >>> bits) | (number << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[index] + words[index]) >>> 0;
      const sum0 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      [a, b, c, d, e, f, g, h] = [(sum1 + sum0 + majority) >>> 0, a, b, c, (d + sum1) >>> 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = (hash[index] + value) >>> 0; });
  }
  return `sha256:${hash.map((value) => value.toString(16).padStart(8, "0")).join("")}`;
}

export const remoteRequestCoordinator = new RemoteRequestCoordinator();

export { RETENTION_MS as REMOTE_REQUEST_RETENTION_MS, STORAGE_KEY as REMOTE_REQUEST_STORAGE_KEY };
