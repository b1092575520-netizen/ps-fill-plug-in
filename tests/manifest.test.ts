import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("UXP manifest permissions", () => {
  it("uses the UXP all-domains form required by configurable providers and result CDNs", () => {
    const manifest = JSON.parse(readFileSync("uxp-static/manifest.json", "utf8")) as {
      requiredPermissions?: {
        network?: { domains?: unknown };
        localFileSystem?: unknown;
      };
    };

    expect(manifest.requiredPermissions?.network?.domains).toBe("all");
    expect(manifest.requiredPermissions?.localFileSystem).toBe("request");
  });
});
