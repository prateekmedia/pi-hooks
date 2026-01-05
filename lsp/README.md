# LSP Extension

Language Server Protocol integration for pi-coding-agent.

## Highlights

- **Hook** (`lsp.ts`): Runs `write`/`edit` results through the matching LSP and appends diagnostics to tool output
- **Tool** (`lsp-tool.ts`): On-demand LSP queries (definitions, references, hover, symbols, diagnostics, signatures)
- Manages one LSP server per project root and reuses them across turns
- **Efficient**: Bounded memory usage via LRU cache and idle file cleanup
- Supports TypeScript/JavaScript, Vue, Svelte, Dart/Flutter, Python, Go, and Rust

## Supported Languages

| Language | Server | Detection |
|----------|--------|-----------|
| TypeScript/JavaScript | `typescript-language-server` | `package.json`, `tsconfig.json` |
| Vue | `vue-language-server` | `package.json`, `vite.config.ts` |
| Svelte | `svelteserver` | `svelte.config.js` |
| Dart/Flutter | `dart language-server` | `pubspec.yaml` |
| Python | `pyright-langserver` | `pyproject.toml`, `requirements.txt` |
| Go | `gopls` | `go.mod` |
| Rust | `rust-analyzer` | `Cargo.toml` |

### Known Limitations

**rust-analyzer**: Very slow to initialize (30-60+ seconds) because it compiles the entire Rust project before returning diagnostics. This is a known rust-analyzer behavior, not a bug in this extension. For quick feedback, consider using `cargo check` directly.

## Usage

### Installation

1. Copy to extensions directory:
   ```bash
   cp -r lsp ~/.pi/agent/extensions/
   ```

2. Install dependencies:
   ```bash
   cd ~/.pi/agent/extensions/lsp
   npm install
   ```

Or add to global settings (`~/.pi/agent/settings.json`):
```json
{
  "extensions": ["/absolute/path/to/lsp"]
}
```

Or use CLI:
```bash
# Load both hook and tool (recommended)
pi --extension ./lsp/

# Load individually
pi --extension ./lsp/lsp.ts        # Just auto-diagnostics hook
pi --extension ./lsp/lsp-tool.ts   # Just the LSP tool
```

### Prerequisites

Install the language servers you need:

```bash
# TypeScript/JavaScript
npm i -g typescript-language-server typescript

# Vue
npm i -g @vue/language-server

# Svelte
npm i -g svelte-language-server

# Python
npm i -g pyright

# Go (install gopls via go install)
go install golang.org/x/tools/gopls@latest

# Rust (install via rustup)
rustup component add rust-analyzer
```

The extension spawns binaries from your PATH.

## How It Works

### Hook (auto-diagnostics)

1. On `session_start`, warms up LSP for detected project type
2. After each `write`/`edit`, sends file to LSP and waits for diagnostics
3. Appends errors/warnings to tool result so agent can fix them
4. Shows notification with diagnostic summary
5. **Memory Management**: Keeps up to 30 files open per LSP server (LRU eviction) and automatically closes idle files (> 60s) to prevent memory bloat in long-running sessions.
6. **Robustness**: Reuses cached diagnostics if a server doesn't re-publish them for unchanged files, avoiding false timeouts on re-analysis.

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

## File Structure

| File | Purpose |
|------|---------|
| `lsp.ts` | Hook extension (auto-diagnostics after write/edit) |
| `lsp-tool.ts` | Tool extension (on-demand LSP queries) |
| `lsp-core.ts` | LSPManager class, server configs, singleton manager |
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
