const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "uxp");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "plugin.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const sharedSource = fs.readFileSync(path.resolve(__dirname, "..", "src", "components", "Shared.tsx"), "utf8");

if (/type=["']module["']/.test(html)) {
  throw new Error("UXP entry must not use type=module");
}
if (!/<script src="\.\/plugin\.js"><\/script>/.test(html)) {
  throw new Error("UXP entry is missing the classic plugin.js script");
}
if (/^\s*(?:import|export)\s/m.test(js)) {
  throw new Error("UXP plugin.js still contains ESM syntax");
}
if (manifest.manifestVersion !== 5 || manifest.main !== "index.html") {
  throw new Error("UXP manifest entry is invalid");
}
if (/\.plugin-panel \.panel-scroll\s*\{[^}]*max-height\s*:\s*calc\([^}]*100vh/s.test(css)) {
  throw new Error("UXP panel scroll area still depends on 100vh calc");
}
if (sharedSource.includes("css-icon")) {
  throw new Error("UXP UI still depends on CSS pseudo-element icons");
}
for (const icon of ["settings", "plus", "refresh", "close"]) {
  if (!sharedSource.includes(`name="${icon}"`)) {
    throw new Error(`UXP UI is missing the real DOM icon: ${icon}`);
  }
}
if (!js.includes("data-uxp-icon")) {
  throw new Error("UXP bundle is missing real DOM icon markup");
}
if (/<img[^>]+data-uxp-icon/.test(js)) {
  throw new Error("UXP bundle still depends on host image decoding for UI icons");
}

console.log("UXP build verified: classic IIFE entry, valid manifest, and real DOM symbol UI icons");
