import { describe, expect, it, vi } from "vitest";
import { LitterboxReferenceUploader } from "../src/backend/referenceUploader";

describe("LitterboxReferenceUploader", () => {
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
    const body = fetchFn.mock.calls[0][1]?.body as FormData;
    expect(body.get("reqtype")).toBe("fileupload");
    expect(body.get("time")).toBe("1h");
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

  it("never sends the image to another host when Litterbox fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const uploader = new LitterboxReferenceUploader(fetchFn);

    await expect(uploader.upload(
      new Blob(["image"], { type: "image/png" }),
      "参考图.png",
      new AbortController().signal,
    )).rejects.toThrow(/参考图上传失败（Litterbox 500）.*不扣分/);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(fetchFn.mock.calls[0][0])).toContain("litterbox.catbox.moe");
  });
});
