# LSP diagnostics hook

Minimal Language Server Protocol diagnostics hook for [`pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

## Highlights
- Runs `write`/`edit` results through the matching LSP and appends diagnostics to tool output.
- Manages one LSP server per project root and reuses them across turns.
- Ships with presets for TypeScript/JavaScript, Vue, Svelte, Astro, Dart/Flutter, Python, Go, Rust, and JSON. Extend by editing the `servers` table in `lsp-hook.ts`.

## Setup
```bash
cd lsp
npm install
```

Expose the hook to pi:
- **Project scoped**
  ```bash
  mkdir -p .pi/hooks
  cp lsp/lsp-hook.ts .pi/hooks/lsp-hook.ts
  ```
- **Global settings** (`~/.pi/agent/settings.json`)
  ```json
  {
    "hooks": [
      "/absolute/path/to/pi-hooks/lsp/lsp-hook.ts"
    ]
  }
  ```

## Prerequisites
Install the language servers you care about (e.g. `npm i -g typescript-language-server typescript`, `npm i -g @vue/language-server`, `npm i -g svelte-language-server`, `npm i -g pyright`, etc.). The hook simply spawns the binaries already on your PATH.

## License
MIT (see repository root)
