import { describe, expect, it } from "vitest";
import {
  fileFromCapturedReference,
  filesFromUxpEntries,
  planReferenceFiles,
  removeReferenceById,
} from "../src/backend/referenceSelection";
import type { ReferenceImage } from "../src/types";

function image(name: string, size = 10, lastModified = 1) {
  return new File(["x".repeat(size)], name, { type: "image/png", lastModified });
}

describe("reference image selection", () => {
  it("rejects duplicate images from repeated add events", () => {
    const existingFile = image("same.png");
    const existing: ReferenceImage[] = [{
      id: "existing",
      name: existingFile.name,
      order: 0,
      url: "blob:existing",
      file: existingFile,
    }];

    const result = planReferenceFiles(existing, [image("same.png"), image("new.png")]);

    expect(result.accepted.map((file) => file.name)).toEqual(["new.png"]);
    expect(result.duplicateCount).toBe(1);
  });

  it("converts a captured Photoshop selection into an addable PNG file", () => {
    const file = fileFromCapturedReference({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      fileName: "selection-1.png",
    });
    expect([file.name, file.type, file.size]).toEqual(["selection-1.png", "image/png", 3]);
    expect(planReferenceFiles([], [file]).accepted).toEqual([file]);
  });

  it("caps the combined reference list at nine images", () => {
    const existing = Array.from({ length: 8 }, (_, index): ReferenceImage => ({
      id: String(index),
      name: `${index}.png`,
      order: index,
      url: `blob:${index}`,
      file: image(`${index}.png`),
    }));
    const result = planReferenceFiles(existing, [image("ninth.png"), image("tenth.png")]);
    expect(result.accepted.map((file) => file.name)).toEqual(["ninth.png"]);
    expect(result.overflowCount).toBe(1);
  });

  it("ignores non-image local files", () => {
    const textFile = new File(["notes"], "notes.txt", { type: "text/plain" });
    const result = planReferenceFiles([], [textFile]);
    expect(result.accepted).toEqual([]);
    expect(result.ignoredCount).toBe(1);
  });

  it("reads multiple UXP file entries as image files with stable fingerprints", async () => {
    const modified = new Date("2026-07-27T00:00:00Z");
    const entries = [
      {
        name: "first.png",
        dateModified: modified,
        read: async () => new Uint8Array([1, 2]),
      },
      {
        name: "second.JPG",
        dateModified: modified,
        read: async () => new Uint8Array([3]),
      },
      {
        name: "ignored.txt",
        read: async () => new Uint8Array([4]),
      },
      {
        name: "modern.AVIF",
        read: async () => new Uint8Array([5, 6, 7]),
      },
    ];
    const files = await filesFromUxpEntries(entries, "binary");
    expect(files.map((file) => [file.name, file.type, file.size, file.lastModified])).toEqual([
      ["first.png", "image/png", 2, modified.getTime()],
      ["second.JPG", "image/jpeg", 1, modified.getTime()],
      ["modern.AVIF", "image/avif", 3, 0],
    ]);
    expect(planReferenceFiles([], files).accepted).toHaveLength(3);
    expect(planReferenceFiles([{
      id: "existing",
      name: files[0].name,
      order: 0,
      url: "blob:existing",
      file: files[0],
    }], files).duplicateCount).toBe(1);
  });

  it("removes one reference, normalizes order, and permits adding the same file again", () => {
    const first = image("first.png");
    const second = image("second.png");
    const existing: ReferenceImage[] = [first, second].map((file, order) => ({
      id: `ref-${order}`,
      name: file.name,
      order,
      url: `blob:${order}`,
      file,
    }));
    const result = removeReferenceById(existing, "ref-0");
    expect(result.removed?.file).toBe(first);
    expect(result.references.map((item) => [item.name, item.order])).toEqual([["second.png", 0]]);
    expect(planReferenceFiles(result.references, [first]).accepted).toEqual([first]);
  });
});
