import type { AspectRatio, Candidate } from "./types";

const PALETTES = [
  ["#7968ff", "#48d8ff", "#17172a"],
  ["#ff8c5a", "#ff4f9a", "#27152c"],
  ["#41d8a5", "#9fe76d", "#102821"],
  ["#ffc857", "#ff785a", "#2b1d1a"],
  ["#6eb5ff", "#b97cff", "#171f35"],
  ["#ff77a9", "#79ecff", "#291a30"],
];

function ratioDimensions(ratio: string) {
  const [width, height] = ratio.split(":").map(Number);
  const base = 720;
  if (!width || !height) return { width: base, height: Math.round(base * 0.75) };
  return width >= height
    ? { width: base, height: Math.round((base * height) / width) }
    : { width: Math.round((base * width) / height), height: base };
}
function xmlEscape(value: string) {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}

export function createArtworkDataUrl(index: number, prompt: string, ratio: string) {
  const { width, height } = ratioDimensions(ratio);
  const [primary, secondary, background] = PALETTES[index % PALETTES.length];
  const label = xmlEscape(prompt.trim().slice(0, 24) || "Context-aware fill");
  const circleX = Math.round(width * (0.22 + ((index * 13) % 31) / 100));
  const circleY = Math.round(height * (0.28 + ((index * 7) % 22) / 100));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="${background}"/>
          <stop offset="0.56" stop-color="${primary}"/>
          <stop offset="1" stop-color="${secondary}"/>
        </linearGradient>
        <filter id="blur"><feGaussianBlur stdDeviation="${Math.max(16, width / 35)}"/></filter>
        <pattern id="grain" width="30" height="30" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="7" r="1" fill="white" opacity=".08"/>
          <circle cx="18" cy="20" r="1.4" fill="white" opacity=".05"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <circle cx="${circleX}" cy="${circleY}" r="${Math.round(width * 0.22)}" fill="${secondary}" opacity=".66" filter="url(#blur)"/>
      <path d="M0 ${Math.round(height * 0.72)} Q ${Math.round(width * 0.32)} ${Math.round(height * 0.43)}, ${Math.round(width * 0.62)} ${Math.round(height * 0.7)} T ${width} ${Math.round(height * 0.55)} V ${height} H0Z" fill="${background}" opacity=".72"/>
      <rect width="100%" height="100%" fill="url(#grain)"/>
      <g fill="white" font-family="Inter,Segoe UI,sans-serif">
        <text x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.84)}" font-size="${Math.max(16, Math.round(width / 30))}" font-weight="650">${label}</text>
        <text x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.91)}" font-size="${Math.max(11, Math.round(width / 52))}" opacity=".62">CONCEPT ${String(index + 1).padStart(2, "0")}</text>
      </g>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function createCandidates(count: number, prompt: string, ratio: AspectRatio | string): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `candidate-${Date.now()}-${index}`,
    title: `第 ${index + 1} 张`,
    url: createArtworkDataUrl(index, prompt, ratio),
    aspectRatio: ratio,
    selected: index === 0,
  }));
}
