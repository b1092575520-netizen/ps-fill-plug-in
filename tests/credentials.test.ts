import { describe, expect, it, vi } from "vitest";
import { MemoryCredentialStore, SecureCredentialStore } from "../src/backend/credentials";

describe("credential stores", () => {
  it("keeps browser credentials in memory", async () => {
    const store = new MemoryCredentialStore();
    await store.saveApiKey("secret");
    expect(await store.loadApiKey()).toBe("secret");
    await store.deleteApiKey();
    expect(await store.loadApiKey()).toBe("");
  });

  it("encodes, reads and deletes UXP secureStorage values", async () => {
    const secureStorage = {
      setItem: vi.fn(async () => undefined),
      getItem: vi.fn(async () => new TextEncoder().encode("secret")),
      removeItem: vi.fn(async () => undefined),
    };
    const store = new SecureCredentialStore(secureStorage);
    await store.saveApiKey("secret");
    expect(secureStorage.setItem).toHaveBeenCalledWith(
      "generative-fill.api-key",
      "secret",
    );
    expect(await store.loadApiKey()).toBe("secret");
    await store.deleteApiKey();
    expect(secureStorage.removeItem).toHaveBeenCalled();
  });

  it("does not expose an API key through secureStorage write errors", async () => {
    const secureStorage = {
      setItem: vi.fn(async () => {
        throw new Error("could not store secret-value");
      }),
      getItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    };
    const store = new SecureCredentialStore(secureStorage);
    await expect(store.saveApiKey("secret-value")).rejects.toThrow("UXP 安全存储写入失败");
    await expect(store.saveApiKey("secret-value")).rejects.not.toThrow("secret-value");
  });

  it("overwrites the same secureStorage key without creating alternate records", async () => {
    const secureStorage = {
      setItem: vi.fn(async () => undefined),
      getItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    };
    const store = new SecureCredentialStore(secureStorage);
    await store.saveApiKey("first");
    await store.saveApiKey("second");
    expect(secureStorage.setItem.mock.calls).toEqual([
      ["generative-fill.api-key", "first"],
      ["generative-fill.api-key", "second"],
    ]);
  });

  it("sanitizes secureStorage read and delete failures", async () => {
    const secureStorage = {
      setItem: vi.fn(async () => undefined),
      getItem: vi.fn(async () => {
        throw new Error("read secret-value");
      }),
      removeItem: vi.fn(async () => {
        throw new Error("delete secret-value");
      }),
    };
    const store = new SecureCredentialStore(secureStorage);
    await expect(store.loadApiKey()).rejects.toThrow("UXP 安全存储读取失败");
    await expect(store.deleteApiKey()).rejects.toThrow("UXP 安全存储删除失败");
  });
});
