import type { ReferenceUploader } from "./contracts";

const UPLOAD_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
const FALLBACK_ENDPOINT = "https://tmpfiles.org/api/v1/upload";
const UPLOAD_TIMEOUT_MS = 30_000;
const UPLOAD_ATTEMPTS = 3;
// Xinbao only fetches the reference while the task starts; one hour keeps
// customer photos online no longer than needed. Keep in step with the upload
// reuse window in AssetLifecycleManager.
export const REFERENCE_UPLOAD_LIFETIME = "1h";

class UploadEndpointError extends Error {
  constructor(readonly service: string, readonly status: number) {
    super(`${service} ${status}`);
  }
}

class UploadTimeoutError extends Error {
  constructor() { super("上传超时"); }
}

class ReferenceUploadError extends Error {
  constructor(readonly reason: string, readonly retryable: boolean, retries: number) {
    super(`参考图上传失败（${reason}），${retries ? `已自动重试 ${retries} 次，` : ""}还没有提交生成，不扣分。请稍后重试`);
  }
}

function ensureNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("已取消上传", "AbortError");
}

function isTransient(error: unknown) {
  if (error instanceof UploadEndpointError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  return error instanceof UploadTimeoutError || (error as Error)?.name === "TypeError";
}

function errorLabel(error: unknown) {
  return error instanceof Error && error.message ? error.message : "上传服务异常";
}

async function withUploadTimeout<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) {
  ensureNotAborted(signal);
  const controller = new AbortController();
  let cancel = () => undefined;
  let timer: ReturnType<typeof setTimeout>;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => {
      controller.abort();
      reject(new DOMException("已取消上传", "AbortError"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      reject(new UploadTimeoutError());
      controller.abort();
    }, UPLOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener("abort", cancel);
  }
}

function waitForRetry(milliseconds: number, signal: AbortSignal) {
  ensureNotAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new DOMException("已取消上传", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
  });
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

async function referenceMultipart(file: Blob, fields: Record<string, string>, fileField: string) {
  // Photoshop UXP 9.3 ignores FormData.append's filename for Blobs, sending
  // filename="blob". Both hosts need an image extension; encode the wire body
  // ourselves so the filename and the original binary bytes survive in UXP.
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff", "image/svg+xml": "svg",
  };
  const filename = `reference.${extensions[file.type] ?? "img"}`;
  const boundary = `----ReferenceUpload${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ascii = (value: string) => Uint8Array.from(value, (character) => character.charCodeAt(0));
  const header = ascii(Object.entries(fields).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  ).join("") + `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const image = new Uint8Array(await file.arrayBuffer());
  const footer = ascii(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(header.length + image.length + footer.length);
  body.set(header);
  body.set(image, header.length);
  body.set(footer, header.length + image.length);
  return { body: body.buffer, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } };
}

/**
 * Uploads references to Litterbox, a temporary host that deletes files after
 * REFERENCE_UPLOAD_LIFETIME. This adapter only contacts Litterbox; the
 * coordinator below handles the separately authorized temporary fallback.
 */
export class LitterboxReferenceUploader implements ReferenceUploader {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async upload(file: Blob, _fileName: string, signal: AbortSignal) {
    ensureNotAborted(signal);
    if (!file.type.startsWith("image/")) throw new Error("参考文件必须是图片");
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withUploadTimeout(signal, async (attemptSignal) => {
          const multipart = await referenceMultipart(file, {
            reqtype: "fileupload", time: REFERENCE_UPLOAD_LIFETIME,
          }, "fileToUpload");
          ensureNotAborted(attemptSignal);
          const response = await this.fetchFn(UPLOAD_ENDPOINT, {
            method: "POST", ...multipart, signal: attemptSignal, credentials: "omit",
          });
          if (!response.ok) throw new UploadEndpointError("Litterbox", response.status);
          const value = (await response.text()).trim();
          return requireHttpsUrl(value, "参考图上传服务").toString();
        });
      } catch (error) {
        ensureNotAborted(signal);
        if ((error as Error)?.name === "AbortError") throw error;
        if (!isTransient(error) || attempt >= UPLOAD_ATTEMPTS - 1) {
          throw new ReferenceUploadError(errorLabel(error), isTransient(error), attempt);
        }
        await waitForRetry(1000 * (attempt + 1), signal);
      }
    }
  }
}

function requireFallbackUrl(value: string) {
  const url = requireHttpsUrl(value, "备用临时图床");
  if (url.origin !== "https://tmpfiles.org" || url.username || url.password) {
    throw new Error("备用临时图床返回了非本站地址");
  }
  return url;
}

/** The user-authorized fallback also deletes references after one hour. */
export class TemporaryReferenceUploader implements ReferenceUploader {
  private readonly primary: LitterboxReferenceUploader;

  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.primary = new LitterboxReferenceUploader(fetchFn);
  }

  async upload(file: Blob, fileName: string, signal: AbortSignal) {
    try {
      return await this.primary.upload(file, fileName, signal);
    } catch (primaryError) {
      ensureNotAborted(signal);
      if (!(primaryError instanceof ReferenceUploadError) || !primaryError.retryable) throw primaryError;
      try {
        return await withUploadTimeout(signal, (fallbackSignal) => this.uploadToFallback(file, fallbackSignal));
      } catch (fallbackError) {
        ensureNotAborted(signal);
        if ((fallbackError as Error)?.name === "AbortError") throw fallbackError;
        throw new Error(`参考图上传失败（${primaryError.reason}；备用临时图床：${errorLabel(fallbackError)}），还没有提交生成，不扣分。请稍后重试`);
      }
    }
  }

  private async uploadToFallback(file: Blob, signal: AbortSignal) {
    if (file.size > 100 * 1024 * 1024) throw new Error("参考图超过备用服务的 100 MB 限制");
    const multipart = await referenceMultipart(file, { expire: "3600" }, "file");
    ensureNotAborted(signal);
    const response = await this.fetchFn(FALLBACK_ENDPOINT, {
      method: "POST", ...multipart, signal, credentials: "omit",
    });
    if (!response.ok) throw new UploadEndpointError("tmpfiles", response.status);
    let payload: { status?: string; data?: { url?: string } };
    try { payload = await response.json(); } catch { throw new Error("备用临时图床返回格式异常"); }
    if (payload?.status !== "success" || typeof payload.data?.url !== "string") {
      throw new Error("备用临时图床未返回有效地址");
    }
    const pageUrl = requireFallbackUrl(payload.data.url);
    ensureNotAborted(signal);
    const pageResponse = await this.fetchFn(pageUrl.toString(), { signal, credentials: "omit" });
    if (!pageResponse.ok) throw new UploadEndpointError("tmpfiles", pageResponse.status);
    const html = await pageResponse.text();
    // tmpfiles now issues signed download links; adding /dl to the page URL
    // redirects to HTML and cannot be used as an image reference.
    const downloadTag = html.match(/<a\b[^>]*>/gi)?.find((tag) => /\bclass\s*=\s*["'][^"']*\bdownload\b/i.test(tag));
    const href = downloadTag?.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) throw new Error("备用临时图床未返回图片直链");
    const imageUrl = requireFallbackUrl(new URL(href.replace(/&amp;/g, "&"), pageUrl).toString());
    if (!imageUrl.pathname.startsWith("/dl/")) throw new Error("备用临时图床返回的不是图片下载地址");
    ensureNotAborted(signal);
    const imageResponse = await this.fetchFn(imageUrl.toString(), { signal, credentials: "omit" });
    if (!imageResponse.ok) throw new UploadEndpointError("tmpfiles 图片下载", imageResponse.status);
    if (!imageResponse.headers.get("content-type")?.toLowerCase().startsWith("image/")) {
      throw new Error("备用临时图床返回的内容不是图片");
    }
    if (!(await imageResponse.arrayBuffer()).byteLength) throw new Error("备用临时图床返回空图片");
    ensureNotAborted(signal);
    return imageUrl.toString();
  }
}
