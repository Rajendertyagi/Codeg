import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import eslintConfigPrettier from "eslint-config-prettier"
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/target/**",
    "src-tauri/experts/**",
    "public/vs/**",
    // Dead custom-workflow archive copies: unwired since the purge; their
    // i18n namespace (CustomWorkflows) no longer exists. Kept as patch
    // archive, excluded from lint + type-check.
    "newplugin/frontend/automation-editor.tsx",
    "newplugin/frontend/custom-page.tsx",
  ]),
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
  {
    rules: {
      "prettier/prettier": "error",
    },
  },
  {
    // Conversation render path: the aggregate workspace hook subscribes to
    // the high-frequency fileTabs slice, so any consumer here would
    // re-render on every keystroke / watcher reload in the file editor.
    // Use the narrow slice hooks instead.
    files: [
      "src/components/chat/**",
      "src/components/message/**",
      "src/components/ai-elements/**",
      "src/components/conversations/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='useWorkspaceContext']",
          message:
            "Hot path: use useWorkspaceActions / useWorkspaceView / useWorkspaceFileTabs instead of the aggregate useWorkspaceContext (it re-renders on every fileTabs change).",
        },
      ],
    },
  },
])

export default eslintConfig
