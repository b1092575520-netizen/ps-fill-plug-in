import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/backend/runtime", () => ({
  isUxpRuntime: () => false,
  createCredentialStore: () => ({
    loadApiKey: async () => "",
    saveApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
  }),
  pickUxpReferenceFiles: async () => [],
  createPhotoshopGateway: () => ({
    getContext: async () => ({
      documentId: "browser-demo",
      documentName: "浏览器演示模式",
      width: 0,
      height: 0,
      colorMode: "Demo",
      selection: null,
    }),
    getOpenDocumentIds: async () => ["browser-demo"],
    insert: vi.fn(),
    captureReference: vi.fn(),
    preview: vi.fn(),
    discardPreview: vi.fn(async () => undefined),
    cleanupPluginResiduals: vi.fn(async () => undefined),
  }),
}));

import { usePrototypeState, type PrototypeController } from "../src/usePrototypeState";

function Harness({ expose }: { expose: (controller: PrototypeController) => void }) {
  const controller = usePrototypeState();
  expose(controller);
  return null;
}

describe("browser generation cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        visibilityState: "visible",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not restore a cancelled browser task to running when queued timers fire", () => {
    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<Harness expose={(controller) => { current = controller; }} />);
    });
    act(() => current.updateDraft({ prompt: "browser cancellation", model: "gpt-image-2-oai", count: 1 }));
    expect(current.startGeneration()).toBe(true);
    expect(current.status).toBe("queued");

    act(() => current.cancelGeneration());
    act(() => { vi.advanceTimersByTime(1_000); });

    expect(current.status).toBe("cancelled");
    expect(current.stage).toBe("idle");
    expect(current.progress).toBe(0);
    expect(current.candidates).toHaveLength(0);
    act(() => tree.unmount());
  });
});
