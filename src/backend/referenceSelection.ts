import type { ReferenceImage } from "../types";
import type { CapturedReference } from "./contracts";

export interface ReferenceSelectionPlan {
  accepted: File[];
  duplicateCount: number;
  overflowCount: number;
  ignoredCount: number;
}

export interface UxpFileEntryLike {
  name: string;
  dateModified?: Date | number;
  read(options: { format: unknown }): Promise<ArrayBuffer | Uint8Array>;
}

function imageMimeType(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "bmp") return "image/bmp";
  if (extension === "avif") return "image/avif";
  return extension === "png" ? "image/png" : "";
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || Boolean(imageMimeType(file.name));
}

export async function filesFromUxpEntries(
  entries: Iterable<UxpFileEntryLike>,
  binaryFormat: unknown,
) {
  const files: File[] = [];
  for (const entry of entries) {
    const type = imageMimeType(entry.name);
    if (!type) continue;
    const data = await entry.read({ format: binaryFormat });
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const file = new Blob([buffer], { type }) as File;
    Object.defineProperties(file, {
      name: { configurable: true, enumerable: true, value: entry.name },
      lastModified: {
        configurable: true,
        enumerable: true,
        value: entry.dateModified instanceof Date
          ? entry.dateModified.getTime()
          : Number(entry.dateModified ?? 0),
      },
    });
    files.push(file);
  }
  return files;
}

export function fileFromCapturedReference(capture: CapturedReference) {
  const bytes = capture.bytes.buffer.slice(
    capture.bytes.byteOffset,
    capture.bytes.byteOffset + capture.bytes.byteLength,
  ) as ArrayBuffer;
  const file = new Blob([bytes], { type: capture.mimeType }) as File;
  Object.defineProperties(file, {
    name: { configurable: true, enumerable: true, value: capture.fileName },
    lastModified: { configurable: true, enumerable: true, value: Date.now() },
  });
  return file;
}

function fileFingerprint(file: File) {
  return [file.name, file.type, file.size, file.lastModified].join("\u0000");
}

function isFileLike(value: unknown): value is File {
  return Boolean(
    value
    && typeof value === "object"
    && "name" in value
    && "type" in value
    && "size" in value
    && "lastModified" in value,
  );
}

export function planReferenceFiles(
  existing: ReferenceImage[],
  incoming: Iterable<File>,
  limit = 9,
): ReferenceSelectionPlan {
  const seen = new Set(existing.flatMap((reference) => (
    isFileLike(reference.file) ? [fileFingerprint(reference.file)] : []
  )));
  const accepted: File[] = [];
  let duplicateCount = 0;
  let ignoredCount = 0;
  let overflowCount = 0;

  for (const file of incoming) {
    if (!isImageFile(file)) {
      ignoredCount += 1;
      continue;
    }
    const fingerprint = fileFingerprint(file);
    if (seen.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(fingerprint);
    if (existing.length + accepted.length >= limit) {
      overflowCount += 1;
      continue;
    }
    accepted.push(file);
  }

  return { accepted, duplicateCount, overflowCount, ignoredCount };
}

export function removeReferenceById(references: ReferenceImage[], id: string) {
  const removed = references.find((item) => item.id === id);
  return {
    removed,
    references: references
      .filter((item) => item.id !== id)
      .map((item, order) => ({ ...item, order })),
  };
}
