import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  useConnectionSettings,
  type ConnectionSettingsController,
} from "../src/hooks/useConnectionSettings";
import type { ConnectionSettings } from "../src/types";

const initialSettings: ConnectionSettings = {
  baseUrl: "https://async.xinbao-ai.com",
  apiKey: "key-a",
  modelOptions: ["auto"],
  connectionStatus: "connected",
  providerSnapshot: null,
};

function Harness({ expose, options }: {
  expose: (controller: ConnectionSettingsController) => void;
  options: Parameters<typeof useConnectionSettings>[0];
}) {
  expose(useConnectionSettings(options));
  return null;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe("useConnectionSettings", () => {
  it("aborts provider refresh and resets capability state when identity changes", async () => {
    let discoverSignal!: AbortSignal;
    let resolveDiscover!: (value: never) => void;
    const providerFactory = vi.fn(() => ({
      discover: vi.fn((signal: AbortSignal) => {
        discoverSignal = signal;
        return new Promise((resolve) => { resolveDiscover = resolve as (value: never) => void; });
      }),
      getBalance: vi.fn(),
      testConnection: vi.fn(),
    }));
    const onIdentityChange = vi.fn();
    let current!: ConnectionSettingsController;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness expose={(value) => { current = value; }} options={{
        initialSettings,
        providerFactory,
        credentialStore: { loadApiKey: async () => "", saveApiKey: async () => undefined, deleteApiKey: async () => undefined },
        notify: vi.fn(),
        onIdentityChange,
      }} />);
    });

    act(() => current.refreshModels());
    await flush();
    expect(current.settings.connectionStatus).toBe("testing");
    act(() => current.setSettings({ ...current.settings, apiKey: "key-b" }));
    expect(discoverSignal.aborted).toBe(true);
    expect(current.settings.apiKey).toBe("key-b");
    expect(current.settings.connectionStatus).toBe("idle");
    expect(current.settings.modelOptions).toEqual([]);
    expect(onIdentityChange).toHaveBeenCalledOnce();
    await act(async () => resolveDiscover({} as never));
    expect(current.settings.apiKey).toBe("key-b");
    expect(current.settings.providerSnapshot).toBeNull();
    act(() => tree.unmount());
  });

  it("saves the trimmed API key through the credential store", async () => {
    const saveApiKey = vi.fn(async () => undefined);
    let current!: ConnectionSettingsController;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness expose={(value) => { current = value; }} options={{
        initialSettings: { ...initialSettings, apiKey: "  secure-key  " },
        providerFactory: vi.fn(),
        credentialStore: { loadApiKey: async () => "", saveApiKey, deleteApiKey: async () => undefined },
        notify: vi.fn(),
      }} />);
    });
    await act(async () => current.saveApiKey());
    expect(saveApiKey).toHaveBeenCalledWith("secure-key");
    expect(current.credentialSaveStatus).toBe("saved");
    act(() => tree.unmount());
  });
});
