import { describe, expect, it, vi } from "vitest";
import { LitterboxReferenceUploader } from "../src/backend/referenceUploader";

describe("LitterboxReferenceUploader", () => {
  it("uploads a local image for 24 hours and returns an HTTPS URL", async () => {
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
    const body = fetchFn.mock.calls[0][1]?.body as FormData;
    expect(body.get("reqtype")).toBe("fileupload");
    expect(body.get("time")).toBe("24h");
    expect((body.get("fileToUpload") as File).name).toBe("参考图.png");
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
    await expect(failed.upload(
      new Blob(["x"], { type: "image/png" }),
      "a.png",
      new AbortController().signal,
    )).rejects.toThrow(/上传失败/);
  });

  it("falls back to a verified direct HTTPS image URL when Litterbox returns 500", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response(
        '<script>PF.obj.config.auth_token = "0123456789abcdef";</script>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        image: { url: "https://iili.io/example.png" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const uploader = new LitterboxReferenceUploader(fetchFn);

    await expect(uploader.upload(
      new Blob(["image"], { type: "image/png" }),
      "参考图.png",
      new AbortController().signal,
    )).resolves.toBe("https://iili.io/example.png");

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls[1][0]).toBe("https://freeimage.host");
    expect(fetchFn.mock.calls[2][0]).toBe("https://freeimage.host/json");
    const fallbackRequest = fetchFn.mock.calls[2][1];
    expect(fallbackRequest).toMatchObject({ method: "POST" });
    expect(fallbackRequest?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
    });
    expect(fallbackRequest?.body).toBeInstanceOf(ArrayBuffer);
    const multipart = new TextDecoder("latin1").decode(fallbackRequest?.body as ArrayBuffer);
    expect(multipart).toContain('name="source"; filename="reference.png"');
    expect(multipart).toContain("Content-Type: image/png\r\n\r\nimage");
    expect(multipart).toContain('name="type"\r\n\r\nfile');
    expect(multipart).toContain('name="action"\r\n\r\nupload');
    expect(multipart).toContain('name="auth_token"\r\n\r\n0123456789abcdef');
    expect(multipart).toMatch(/\r\n------CodexReferenceUpload[a-z0-9]+--\r\n$/);
  });
});
