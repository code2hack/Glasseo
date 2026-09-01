import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["app/build/**", "build/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["web/**/*.ts"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        indexedDB: "readonly",
        WebSocket: "readonly",
        crypto: "readonly",
        location: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Uint8Array: "readonly",
        setTimeout: "readonly",
      },
    },
  },
);
