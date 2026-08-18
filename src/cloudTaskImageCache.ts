import type { CloudTaskRecord } from "./types";

export class CloudTaskImageCache {
  private readonly entries = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private releaseVersion = 0;

  constructor(
    private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly maxEntries = 12,
  ) {}

  async load(task: CloudTaskRecord, signal?: AbortSignal) {
    const existing = this.entries.get(task.taskId);
    if (existing) {
      this.entries.delete(task.taskId);
      this.entries.set(task.taskId, existing);
      return existing;
    }
    const pending = this.inFlight.get(task.taskId);
    if (pending) return pending;
    if (!task.thumbnailUrl) throw new Error("该任务没有可用缩略图");
    const loadVersion = this.releaseVersion;
    const request = (signal ? this.fetchFn(task.thumbnailUrl, { signal }) : this.fetchFn(task.thumbnailUrl)).then(async (response) => {
      if ([401, 403, 404, 410].includes(response.status)) throw new Error("云端图片已过期或无权访问");
      if (!response.ok) throw new Error(`云端图片加载失败（${response.status}）`);
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!mimeType?.startsWith("image/")) throw new Error("云端记录返回的文件不是图片");
      const blobUrl = URL.createObjectURL(await response.blob());
      if (loadVersion !== this.releaseVersion) {
        URL.revokeObjectURL(blobUrl);
        throw new DOMException("云端记录页已关闭", "AbortError");
      }
      this.entries.set(task.taskId, blobUrl);
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.entries().next().value as [string, string] | undefined;
        if (!oldest) break;
        this.entries.delete(oldest[0]);
        URL.revokeObjectURL(oldest[1]);
      }
      return blobUrl;
    }).finally(() => {
      if (this.inFlight.get(task.taskId) === request) this.inFlight.delete(task.taskId);
    });
    this.inFlight.set(task.taskId, request);
    return request;
  }

  releaseAll() {
    this.releaseVersion += 1;
    this.entries.forEach((url) => URL.revokeObjectURL(url));
    this.entries.clear();
    this.inFlight.clear();
  }

  size() {
    return this.entries.size;
  }
}
