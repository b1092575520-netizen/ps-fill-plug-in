import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LitterboxReferenceUploader, TemporaryReferenceUploader } from "../src/backend/referenceUploader";

async function readMultipart(options: RequestInit) {
  // UXP ignores FormData.append's filename for Blobs and sends filename="blob".
  // Parse the bytes that fetch will send, including the explicit filename.
  expect(options.body).toBeInstanceOf(ArrayBuffer);
  return new Response(options.body, { headers: options.headers }).formData();
}

describe("LitterboxReferenceUploader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uploads a local image for one hour and returns an HTTPS URL", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(
      "https://litter.catbox.moe/example.png\n",
      { status: 200 },
    ));
    const uploader = new LitterboxReferenceUploader(fetchFn);
    const result = await uploader.upload(
      new Blob(["image"], { type: "image/png" }),
      "参考图.png",
      new AbortController().signal,
    );
    expect(result).toBe("https://litter.catbox.moe/example.png");
    expect(String(fetchFn.mock.calls[0][0])).toContain("litterbox.catbox.moe");
    const body = await readMultipart(fetchFn.mock.calls[0][1]);
    expect(body.get("reqtype")).toBe("fileupload");
    expect(body.get("time")).toBe("1h");
    expect((body.get("fileToUpload") as File).name).toBe("reference.png");
  });

  it("rejects non-HTTPS and failed upload responses", async () => {
    const badUrl = new LitterboxReferenceUploader(vi.fn().mockResolvedValue(
      new Response("http://example.com/a.png", { status: 200 }),
    ));
    await expect(badUrl.upload(
      new Blob(["x"], { type: "image/png" }),
      "a.png",
      new AbortController().signal,
    )).rejects.toThrow(/HTTPS/);

    const failed = new LitterboxReferenceUploader(vi.fn().mockResolvedValue(
      new Response("upload failed", { status: 500 }),
    ));
    const failure = expect(failed.upload(
      new Blob(["x"], { type: "image/png" }),
      "a.png",
      new AbortController().signal,
    )).rejects.toThrow(/上传失败/);
    await vi.runAllTimersAsync();
    await failure;
  });

  it("retries temporary server failures before returning the uploaded URL", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("https://litter.catbox.moe/recovered.png"));
    const result = expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "参考图.png", new AbortController().signal,
    )).resolves.toBe("https://litter.catbox.moe/recovered.png");
    await vi.runAllTimersAsync();
    await result;
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchFn.mock.calls) {
      expect((await readMultipart(options)).get("time")).toBe("1h");
      expect(options.signal.aborted).toBe(false);
    }
  });

  it("retries an interrupted network connection", async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(new Response("https://litter.catbox.moe/recovered.png"));
    const result = expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "a.png", new AbortController().signal,
    )).resolves.toContain("recovered.png");
    await vi.runAllTimersAsync();
    await result;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 413, 415, 422])("does not retry a permanent upload rejection (%s)", async (status) => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("rejected", { status }));
    await expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "a.png", new AbortController().signal,
    )).rejects.toThrow(`Litterbox ${status}`);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("bounds stalled requests even if fetch ignores abort, and aborts each timed-out attempt", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => undefined));
    const failure = expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "a.png", new AbortController().signal,
    )).rejects.toThrow(/上传超时.*不扣分/);
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
  });

  it("can cancel while a request is stalled without starting another upload", async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const failure = expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "a.png", controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await failure;
    await vi.runAllTimersAsync();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("does not upload when already cancelled", async () => {
    const fetchFn = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "a.png", controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("cancels during retry backoff without starting another request", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const controller = new AbortController();
    const failure = expect(new LitterboxReferenceUploader(fetchFn).upload(
      new Blob(["image"], { type: "image/png" }), "a.png", controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await failure;
    await vi.runAllTimersAsync();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("never sends the image to another host when Litterbox fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const uploader = new LitterboxReferenceUploader(fetchFn);

    const failure = expect(uploader.upload(
      new Blob(["image"], { type: "image/png" }),
      "参考图.png",
      new AbortController().signal,
    )).rejects.toThrow(/参考图上传失败（Litterbox 500）.*不扣分/);
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls.every(([url]) => String(url).includes("litterbox.catbox.moe"))).toBe(true);
  });
});

describe("TemporaryReferenceUploader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const pageUrl = "https://tmpfiles.org/file-id/reference.png";
  const imageUrl = "https://tmpfiles.org/dl/1792409999.signature/file-id/reference.png";
  const file = () => new Blob(["image"], { type: "image/png" });
  const success = () => new Response(JSON.stringify({ status: "success", data: { url: pageUrl } }));
  const page = (url = imageUrl) => new Response(`<a class="download" href="${url}">Download</a>`);
  const primaryFailure = () => new Response("unavailable", { status: 500 });
  const failingPrimary = () => vi.fn().mockImplementationOnce(primaryFailure)
    .mockImplementationOnce(primaryFailure).mockImplementationOnce(primaryFailure);

  it("uses only Litterbox when the primary upload succeeds", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("https://litter.catbox.moe/a.png"));
    await expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "a.png", new AbortController().signal))
      .resolves.toBe("https://litter.catbox.moe/a.png");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("falls back with an explicit one-hour expiry and verifies the actual image without credentials", async () => {
    const fetchFn = failingPrimary().mockResolvedValueOnce(success()).mockResolvedValueOnce(page())
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
    const result = expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "客人.png", new AbortController().signal))
      .resolves.toBe(imageUrl);
    await vi.runAllTimersAsync();
    await result;
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(fetchFn.mock.calls[3][0]).toBe("https://tmpfiles.org/api/v1/upload");
    const body = await readMultipart(fetchFn.mock.calls[3][1]);
    expect(body.get("expire")).toBe("3600");
    expect((body.get("file") as File).name).toBe("reference.png");
    expect(fetchFn.mock.calls.slice(4).map(([url]) => url)).toEqual([pageUrl, imageUrl]);
    for (const [, options] of fetchFn.mock.calls) {
      expect(options.credentials).toBe("omit");
      expect(new Headers(options.headers).has("authorization")).toBe(false);
    }
  });

  it("preserves binary image bytes and MIME extension without relying on native FormData", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 34, 200, 1]);
    const fetchFn = failingPrimary().mockResolvedValueOnce(success()).mockResolvedValueOnce(page())
      .mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "image/jpeg" } }));
    const nativeFormData = vi.spyOn(globalThis, "FormData").mockImplementation(function () {
      throw new Error("UXP FormData must not serialize reference images");
    });
    try {
      const result = new TemporaryReferenceUploader(fetchFn).upload(
        new Blob([bytes], { type: "image/jpeg" }), '中文"\r\n.jpg', new AbortController().signal,
      ).then((url) => ({ url }), (error) => ({ error }));
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ url: imageUrl });
      expect(nativeFormData).not.toHaveBeenCalled();
    } finally {
      nativeFormData.mockRestore();
    }
    for (const [index, field] of [[0, "fileToUpload"], [3, "file"]] as const) {
      const body = await readMultipart(fetchFn.mock.calls[index][1]);
      const image = body.get(field) as File;
      expect(image.name).toBe("reference.jpg");
      expect(image.type).toBe("image/jpeg");
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    }
  });

  it("rejects a download address that actually serves HTML", async () => {
    const fetchFn = failingPrimary().mockResolvedValueOnce(success()).mockResolvedValueOnce(page())
      .mockResolvedValueOnce(new Response("<html>expired</html>", { headers: { "content-type": "text/html" } }));
    const failure = expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "a.png", new AbortController().signal))
      .rejects.toThrow(/不是图片.*不扣分/);
    await vi.runAllTimersAsync();
    await failure;
  });

  it("rejects an upload response pointing to another site without fetching that site", async () => {
    const fetchFn = failingPrimary().mockResolvedValueOnce(new Response(JSON.stringify({
      status: "success", data: { url: "https://unexpected.example/a.png" },
    })));
    const failure = expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "a.png", new AbortController().signal))
      .rejects.toThrow(/地址.*不扣分/);
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("rejects a page with an external download link without fetching it", async () => {
    const fetchFn = failingPrimary().mockResolvedValueOnce(success()).mockResolvedValueOnce(page("https://unexpected.example/a.png"));
    const failure = expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "a.png", new AbortController().signal))
      .rejects.toThrow(/地址.*不扣分/);
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("does not send a rejected file or cancelled request to the fallback", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("too large", { status: 413 }));
    await expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "a.png", new AbortController().signal))
      .rejects.toThrow(/413/);
    expect(fetchFn).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    await expect(new TemporaryReferenceUploader(fetchFn).upload(file(), "a.png", controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
