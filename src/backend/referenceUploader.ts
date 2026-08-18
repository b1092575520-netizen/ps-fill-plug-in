import type { ReferenceUploader } from "./contracts";

const UPLOAD_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
const FALLBACK_UPLOAD_PAGE = "https://freeimage.host";
const FALLBACK_UPLOAD_ENDPOINT = "https://freeimage.host/json";

class UploadEndpointError extends Error {
  constructor(readonly service: string, readonly status: number) {
    super(`${service} ${status}`);
  }
}

function imageExtension(fileName: string, mimeType: string) {
  const byMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/bmp": "bmp",
  };
  if (byMime[mimeType]) return byMime[mimeType];
  const match = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match?.[1] ?? "png";
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

function uploadErrorLabel(error: unknown, fallback: string) {
  if (error instanceof UploadEndpointError) return `${error.service} ${error.status}`;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function asciiBytes(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

async function encodeMultipartImage(
  file: Blob,
  fileName: string,
  fields: Record<string, string>,
) {
  const extension = imageExtension(fileName, file.type);
  const boundary = `----CodexReferenceUpload${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const fieldHeaders = Object.entries(fields).map(([name, value]) => (
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
    + `${value}\r\n`
  )).join("");
  const header = asciiBytes(
    fieldHeaders
    + `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="source"; filename="reference.${extension}"\r\n`
    + `Content-Type: ${file.type}\r\n\r\n`,
  );
  const payload = new Uint8Array(await file.arrayBuffer());
  const footer = asciiBytes(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(header.length + payload.length + footer.length);
  body.set(header, 0);
  body.set(payload, header.length);
  body.set(footer, header.length + payload.length);
  return {
    body: body.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export class LitterboxReferenceUploader implements ReferenceUploader {
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async upload(file: Blob, fileName: string, signal: AbortSignal) {
    if (!file.type.startsWith("image/")) throw new Error("参考文件必须是图片");
    try {
      return await this.uploadToLitterbox(file, fileName, signal);
    } catch (primaryError) {
      if (signal.aborted || (primaryError as Error).name === "AbortError") throw primaryError;
      try {
        return await this.uploadToFallback(file, fileName, signal);
      } catch (fallbackError) {
        if (signal.aborted || (fallbackError as Error).name === "AbortError") throw fallbackError;
        const primary = uploadErrorLabel(primaryError, "主服务异常");
        const fallback = uploadErrorLabel(fallbackError, "备用服务异常");
        throw new Error(`参考图上传失败（${primary}；${fallback}）`);
      }
    }
  }

  private async uploadToLitterbox(file: Blob, fileName: string, signal: AbortSignal) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "24h");
    form.append("fileToUpload", file, fileName);
    const response = await this.fetchFn(UPLOAD_ENDPOINT, {
      method: "POST",
      body: form,
      signal,
    });
    const value = (await response.text()).trim();
    if (!response.ok) throw new UploadEndpointError("Litterbox", response.status);
    return requireHttpsUrl(value, "参考图上传服务").toString();
  }

  private async uploadToFallback(file: Blob, fileName: string, signal: AbortSignal) {
    const pageResponse = await this.fetchFn(FALLBACK_UPLOAD_PAGE, { signal });
    const page = await pageResponse.text();
    if (!pageResponse.ok) throw new UploadEndpointError("备用服务", pageResponse.status);
    const authToken = page.match(/PF\.obj\.config\.auth_token\s*=\s*"([a-f0-9]+)"/i)?.[1];
    if (!authToken) throw new Error("备用上传服务未返回上传令牌");
    const multipart = await encodeMultipartImage(file, fileName, {
      type: "file",
      action: "upload",
      timestamp: String(Date.now()),
      auth_token: authToken,
    });
    const response = await this.fetchFn(FALLBACK_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": multipart.contentType,
      },
      body: multipart.body,
      signal,
    });
    const value = (await response.text()).trim();
    if (!response.ok) throw new UploadEndpointError("备用服务", response.status);
    let payload: {
      image?: { url?: string };
    };
    try {
      payload = JSON.parse(value);
    } catch {
      throw new Error("备用上传服务未返回有效地址");
    }
    if (!payload.image?.url) {
      throw new Error("备用上传服务未返回有效地址");
    }
    return requireHttpsUrl(payload.image.url, "备用上传服务").toString();
  }
}
