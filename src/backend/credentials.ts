import type { CredentialStore } from "./contracts";

const API_KEY_NAME = "generative-fill.api-key";

export interface SecureStorageLike {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<ArrayBuffer | Uint8Array | undefined>;
  removeItem(key: string): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private apiKey = "";

  async loadApiKey() {
    return this.apiKey;
  }

  async saveApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  async deleteApiKey() {
    this.apiKey = "";
  }
}

export class SecureCredentialStore implements CredentialStore {
  constructor(private readonly storage: SecureStorageLike) {}

  async loadApiKey() {
    try {
      const value = await this.storage.getItem(API_KEY_NAME);
      if (!value) return "";
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    } catch {
      throw new Error("UXP 安全存储读取失败");
    }
  }

  async saveApiKey(apiKey: string) {
    try {
      await this.storage.setItem(API_KEY_NAME, apiKey);
    } catch {
      throw new Error("UXP 安全存储写入失败");
    }
  }

  async deleteApiKey() {
    try {
      await this.storage.removeItem(API_KEY_NAME);
    } catch {
      throw new Error("UXP 安全存储删除失败");
    }
  }
}
