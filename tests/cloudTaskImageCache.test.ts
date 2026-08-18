import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudTaskImageCache } from "../src/cloudTaskImageCache";
import type { CloudTaskRecord } from "../src/types";

const task = (taskId: string): CloudTaskRecord => ({
  taskId,
  model: "gpt-image-2-oai",
  status: "succeeded",
  createdAt: null,
  completedAt: null,
  thumbnailUrl: `https://cdn.example/${taskId}.png`,
  origin: "external-or-unknown",
});

afterEach(() => vi.unstubAllGlobals());

describe("cloud task image cache", () => {
  it("shares one in-flight thumbnail fetch for repeated clicks", async () => {
    const createObjectURL = vi.fn(() => "blob:cloud-shared");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    let resolveResponse!: (response: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const cache = new CloudTaskImageCache(fetchFn as typeof fetch);

    const first = cache.load(task("same"));
    const second = cache.load(task("same"));
    expect(fetchFn).toHaveBeenCalledOnce();
    resolveResponse(new Response(new Blob(["image"], { type: "image/png" }), {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    await expect(Promise.all([first, second])).resolves.toEqual(["blob:cloud-shared", "blob:cloud-shared"]);
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes a thumbnail that finishes after the page is released", async () => {
    const createObjectURL = vi.fn(() => "blob:cloud-late");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let resolveResponse!: (response: Response) => void;
    const cache = new CloudTaskImageCache(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }) as ReturnType<typeof fetch>);
    const pending = cache.load(task("late"));
    cache.releaseAll();
    resolveResponse(new Response(new Blob(["image"], { type: "image/png" }), { headers: { "content-type": "image/png" } }));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cloud-late");
    expect(cache.size()).toBe(0);
  });

  it("loads lazily, reuses a task image and revokes it on release", async () => {
    const createObjectURL = vi.fn(() => "blob:cloud-a");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
    const cache = new CloudTaskImageCache(fetchFn);

    await expect(cache.load(task("a"))).resolves.toBe("blob:cloud-a");
    await expect(cache.load(task("a"))).resolves.toBe("blob:cloud-a");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith("https://cdn.example/a.png");
    cache.releaseAll();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cloud-a");
    expect(cache.size()).toBe(0);
  });

  it("passes a defined abort signal without emitting undefined UXP fetch options", async () => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:cloud-signalled"), revokeObjectURL: vi.fn() });
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    const cache = new CloudTaskImageCache(fetchFn);
    const controller = new AbortController();

    await cache.load(task("signalled"), controller.signal);

    expect(fetchFn).toHaveBeenCalledWith("https://cdn.example/signalled.png", { signal: controller.signal });
  });

  it("bounds the cache and revokes the oldest image", async () => {
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}:${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const cache = new CloudTaskImageCache(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }), 1);

    await cache.load(task("a"));
    await cache.load(task("b"));
    expect(cache.size()).toBe(1);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("reports expired images without creating a Blob URL", async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const cache = new CloudTaskImageCache(async () => new Response(null, { status: 410 }));

    await expect(cache.load(task("expired"))).rejects.toThrow("图片已过期");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
