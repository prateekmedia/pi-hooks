# LSP Extension

Language Server Protocol integration for pi-coding-agent.

## Highlights

- **Hook** (`lsp.ts`): Auto-diagnostics (default at agent end; optional per `write`/`edit`)
- **Tool** (`lsp-tool.ts`): On-demand LSP queries (definitions, references, hover, symbols, diagnostics, signatures)
- Manages one LSP server per project root and reuses them across turns
- **Efficient**: Bounded memory usage via LRU cache and idle file cleanup
- Supports TypeScript/JavaScript, C/C++, Vue, Svelte, Dart/Flutter, Python, Go, Kotlin, Swift, and Rust

## Supported Languages

| Language | Server | Detection |
|----------|--------|-----------|
| TypeScript/JavaScript | `typescript-language-server` | `package.json`, `tsconfig.json`, `jsconfig.json` |
| C/C++ | `clangd --background-index` | nearest `compile_commands.json`, `.clangd`, `CMakeLists.txt` |
| Vue | `vue-language-server` | `package.json`, `vite.config.ts` |
| Svelte | `svelteserver` | `svelte.config.js` |
| Dart/Flutter | `dart language-server` | `pubspec.yaml` |
| Python | `pyright-langserver` | `pyproject.toml`, `requirements.txt` |
| Go | `gopls` | `go.mod` |
| Kotlin | `kotlin-lsp` (fallback: `kotlin-language-server`) | `settings.gradle(.kts)`, `build.gradle(.kts)`, `pom.xml` |
| Swift | `sourcekit-lsp` | `Package.swift`, Xcode (`*.xcodeproj` / `*.xcworkspace`) |
| Rust | `rust-analyzer` | `Cargo.toml` |

### Known Limitations

**rust-analyzer**: Very slow to initialize (30-60+ seconds) because it compiles the entire Rust project before returning diagnostics. This is a known rust-analyzer behavior, not a bug in this extension. For quick feedback, consider using `cargo check` directly.

## Usage

### Installation

Install the package and enable extensions:
```bash
pi install npm:lsp-pi
pi config
```

Dependencies are installed automatically during `pi install`.

### Prerequisites

Install the language servers you need:

```bash
# TypeScript/JavaScript
npm i -g typescript-language-server typescript

# C/C++
# Install clangd from your platform's LLVM package.

# Vue
npm i -g @vue/language-server

# Svelte
npm i -g svelte-language-server

# Python
npm i -g pyright

# Go (install gopls via go install)
go install golang.org/x/tools/gopls@latest

# Kotlin (kotlin-lsp)
brew install JetBrains/utils/kotlin-lsp

# Swift (sourcekit-lsp; macOS)
# Usually available via Xcode / Command Line Tools
xcrun sourcekit-lsp --help

# Rust (install via rustup)
rustup component add rust-analyzer
```

The extension spawns binaries from your PATH.

## How It Works

### Hook (auto-diagnostics)

1. On `session_start`, warms up LSP for detected project type
2. Tracks files touched by `write`/`edit`
3. Default (`agent_end`): at agent end, sends touched files to LSP and posts a diagnostics message
4. Optional (`edit_write`): per `write`/`edit`, appends diagnostics to the tool result
5. Shows notification with diagnostic summary
6. **Memory Management**: Keeps up to 30 files open per LSP server (LRU eviction), automatically closes idle files (> 60s), and shuts down all LSP servers after 2 minutes of post-agent inactivity (servers restart lazily when files are read again).
7. **Robustness**: Reuses cached diagnostics if a server doesn't re-publish them for unchanged files, avoiding false timeouts on re-analysis.

### Tool (on-demand queries)

The `lsp` tool provides these actions:

| Action | Description | Requires |
|--------|-------------|----------|
| `definition` | Jump to definition | `file` + (`line`/`column` or `query`) |
| `references` | Find all references | `file` + (`line`/`column` or `query`) |
| `hover` | Get type/docs info | `file` + (`line`/`column` or `query`) |
| `symbols` | List symbols in file | `file`, optional `query` filter |
| `diagnostics` | Get single file diagnostics | `file`, optional `severity` filter |
| `workspace-diagnostics` | Get diagnostics for multiple files | `files` array, optional `severity` filter |
| `signature` | Get function signature | `file` + (`line`/`column` or `query`) |
| `rename` | Rename symbol across files | `file` + (`line`/`column` or `query`) + `newName` |
| `codeAction` | Get available quick fixes/refactors | `file` + `line`/`column`, optional `endLine`/`endColumn` |

**Query resolution**: For position-based actions, you can provide a `query` (symbol name) instead of `line`/`column`. The tool will find the symbol in the file and use its position.

**Severity filtering**: For `diagnostics` and `workspace-diagnostics` actions, use the `severity` parameter to filter results:
- `all` (default): Show all diagnostics
- `error`: Only errors
- `warning`: Errors and warnings
- `info`: Errors, warnings, and info
- `hint`: All including hints

**Workspace diagnostics**: The `workspace-diagnostics` action analyzes multiple files at once. Pass an array of file paths in the `files` parameter. Each file will be opened, analyzed by the appropriate LSP server, and diagnostics returned. Files are cleaned up after analysis to prevent memory bloat.

```bash
# Find all TypeScript files and check for errors
find src -name "*.ts" -type f | xargs ...

# Example tool call
lsp action=workspace-diagnostics files=["src/index.ts", "src/utils.ts"] severity=error
```

Example questions the LLM can answer using this tool:
- "Where is `handleSessionStart` defined in `lsp-hook.ts`?"
- "Find all references to `getManager`"
- "What type does `getDefinition` return?"
- "List symbols in `lsp-core.ts`"
- "Check all TypeScript files in src/ for errors"
- "Get only errors from `index.ts`"
- "Rename `oldFunction` to `newFunction`"
- "What quick fixes are available at line 10?"

## Settings

Use `/lsp` to configure the auto diagnostics hook:
- Mode: default at agent end; can run after each edit/write or be disabled
- Scope: session-only or global (`~/.pi/agent/settings.json`)

To disable auto diagnostics, choose "Disabled" in `/lsp` or set in `~/.pi/agent/settings.json`:
```json
{
  "lsp": {
    "hookMode": "disabled"
  }
}
```
Other values: `"agent_end"` (default) and `"edit_write"`.

Agent-end mode analyzes files touched during the full agent response (after all tool calls complete) and posts a diagnostics message only once. Disabling the hook does not disable the model-facing `lsp` tool.

### Language server configuration

Builtins are the defaults. Optional JSON configuration is read from:

- Global: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lsp.json`
- Project: `.pi/lsp.json` (Pi's configured project directory name is used at runtime)

Neither file is created automatically. The global file can override builtins or add servers:

```json
{
  "servers": {
    "clangd": {
      "args": ["--background-index", "--clang-tidy"],
      "diagnosticsWaitMs": 5000
    },
    "example-ls": {
      "command": "example-language-server",
      "args": ["--stdio"],
      "extensions": [".example"],
      "rootMarkers": ["example.toml"],
      "languageIds": { ".example": "example" },
      "initializationOptions": { "feature": true }
    }
  }
}
```

Global server fields are `command`, `args`, `extensions`, `rootMarkers`, `languageIds`, `initializationOptions`, `diagnosticsWaitMs`, and `disabled`. A new server requires `command`, nonempty dot-prefixed `extensions`, and nonempty `rootMarkers`. Extensions and language-ID keys are normalized to lowercase. `command` must be a bare executable name resolved from `PATH` or an absolute path.

Dart/Flutter, TypeScript, Kotlin, and Swift have builtin executable discovery or fallbacks. Overriding their `command` or `args` switches to the configured command directly; Pi reports a configuration warning when this happens.

Project configuration is intentionally tuning-only. For an existing builtin or global server it may set only:

```json
{
  "servers": {
    "clangd": { "diagnosticsWaitMs": 10000 },
    "rust-analyzer": { "disabled": true }
  }
}
```

A project cannot add a server, change its executable, arguments, extensions, roots, language IDs, or initialization options, and cannot re-enable a globally disabled server. `diagnosticsWaitMs` is clamped to 250–60000 ms. Invalid JSON or invalid entries are ignored without disabling builtins.

**Safety model:** commands are spawned directly without a shell. Configuration never installs or downloads servers, runs installer commands, reads an environment-variable command map, or writes scaffolding. Prototype-pollution keys are rejected. Project restrictions apply regardless of project trust.

## File Structure

| File | Purpose |
|------|---------|
| `lsp.ts` | Hook extension (auto-diagnostics; default at agent end) |
| `lsp-tool.ts` | Tool extension (on-demand LSP queries) |
| `lsp-core.ts` | LSPManager class, builtin server definitions, singleton manager |
| `lsp-config.ts` | Safe global/project configuration resolver |
| `package.json` | Declares both extensions via "pi" field |

## Testing

```bash
# Unit tests (root detection, configuration)
npm test

# Tool tests
npm run test:tool

# Integration tests (spawns real language servers)
npm run test:integration

# Run rust-analyzer tests (slow, disabled by default)
RUST_LSP_TEST=1 npm run test:integration
```

## License

MIT
