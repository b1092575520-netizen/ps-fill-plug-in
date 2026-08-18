import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    base: "./",
    publicDir: "uxp-static",
    build: {
      outDir: "uxp",
      emptyOutDir: true,
      target: "es2018",
      modulePreload: false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: "src/main.tsx",
        output: {
          format: "iife",
          name: "GenerativeFillPlugin",
          inlineDynamicImports: true,
          entryFileNames: "plugin.js",
          assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".css")
            ? "style.css"
            : "assets/[name][extname]",
        },
      },
    },
  }),
);
