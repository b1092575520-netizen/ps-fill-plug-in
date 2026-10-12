import type { ReferenceUploader } from "./contracts";

const UPLOAD_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
// Xinbao only fetches the reference while the task starts; one hour keeps
// customer photos online no longer than needed. Keep in step with the upload
// reuse window in AssetLifecycleManager.
export const REFERENCE_UPLOAD_LIFETIME = "1h";

class UploadEndpointError extends Error {
  constructor(readonly service: string, readonly status: number) {
    super(`${service} ${status}`);
  }
}

function requireHttpsUrl(value: string, service: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${service} 未返回有效地址`);
  }
  if (url.protocol !== "https:") throw new Error(`${service} 未返回 HTTPS 地址`);
  return url;
}

/**
 * Uploads references to Litterbox, a temporary host that deletes files after
 * REFERENCE_UPLOAD_LIFETIME. There is deliberately no fallback host: a failed
 * upload must not send customer photos somewhere they never expire.
 */
export class LitterboxReferenceUploader implements ReferenceUploader {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async upload(file: Blob, fileName: string, signal: AbortSignal) {
    if (!file.type.startsWith("image/")) throw new Error("参考文件必须是图片");
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("time", REFERENCE_UPLOAD_LIFETIME);
      form.append("fileToUpload", file, fileName);
      const response = await this.fetchFn(UPLOAD_ENDPOINT, {
        method: "POST",
        body: form,
        signal,
      });
      const value = (await response.text()).trim();
      if (!response.ok) throw new UploadEndpointError("Litterbox", response.status);
      return requireHttpsUrl(value, "参考图上传服务").toString();
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") throw error;
      const reason = error instanceof UploadEndpointError
        ? `${error.service} ${error.status}`
        : error instanceof Error && error.message ? error.message : "上传服务异常";
      throw new Error(`参考图上传失败（${reason}），还没有提交生成，不扣分。请稍后重试`);
    }
  }
}
