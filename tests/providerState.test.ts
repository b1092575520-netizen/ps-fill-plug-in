import { describe, expect, it } from "vitest";
import { createXinbaoSnapshot, snapshotModelOptions } from "../src/backend/providerCapabilities";
import { providerConnectionStatus, resetProviderConnection } from "../src/usePrototypeState";
import type { ConnectionSettings } from "../src/types";

describe("provider identity state", () => {
  it("clears old models and capabilities when Base URL or API Key changes", () => {
    const snapshot = createXinbaoSnapshot();
    const current: ConnectionSettings = {
      baseUrl: "https://async.xinbao-ai.com",
      apiKey: "old-key",
      connectionStatus: "connected",
      providerSnapshot: snapshot,
      modelOptions: snapshotModelOptions(snapshot),
    };
    expect(resetProviderConnection(current, {
      ...current,
      baseUrl: "https://compatible.example",
    })).toMatchObject({
      connectionStatus: "idle",
      providerSnapshot: null,
      modelOptions: [],
    });
    expect(resetProviderConnection(current, current)).toBe(current);
  });

  it("keeps the connection verified when a later model refresh follows a successful balance query", () => {
    const snapshot = createXinbaoSnapshot(false);
    expect(providerConnectionStatus(snapshot, {
      status: "available",
      unit: "积分",
      remaining: 1_490_000,
    })).toBe("connected");
    expect(providerConnectionStatus(snapshot, {
      status: "idle",
      unit: "积分",
    })).toBe("reachable");
  });
});
