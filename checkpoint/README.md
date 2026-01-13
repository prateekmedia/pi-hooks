# checkpoint extension

Git-based checkpoint extension for [`pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

## What it does

- Saves the full worktree (tracked + untracked) at the start of every turn
- Stores snapshots as Git refs so you can restore code while forking conversations
- Creates a "before restore" checkpoint automatically to avoid losing current work
- Offers restore options: files + conversation, conversation only, or files only

## Setup

Place the `checkpoint/` directory where pi can load it:

- **Project scoped**: `cp -r checkpoint .pi/extensions/`
- **Global**: `cp -r checkpoint ~/.pi/agent/extensions/`

Or add to `~/.pi/agent/settings.json`:
```json
{
  "extensions": ["/absolute/path/to/checkpoint"]
}
```

Or use CLI:
```bash
pi --extension ./checkpoint/
```

## File structure

```
checkpoint/
  checkpoint.ts        # Extension (entry point + state management + event handlers)
  checkpoint-core.ts   # Core git operations (no pi dependencies)
  package.json         # Declares extension via "pi" field
  tests/
    checkpoint.test.ts # Tests for core git operations
```

## Testing

```bash
npm test
```

## Requirements

- Git repository (extension auto-detects)
- Node.js 18+

## How it works

1. **On turn start**: Creates a checkpoint capturing HEAD, index, and worktree state
2. **On fork/tree navigation**: Prompts with restore options:
   - **Restore all**: Restore files and navigate conversation
   - **Conversation only**: Keep current files, navigate conversation
   - **Code only**: Restore files, stay at current conversation position
   - **Cancel**: Do nothing

Checkpoints are stored as Git refs under `refs/pi-checkpoints/` and persist across sessions.

## Smart Filtering

To avoid bloating snapshots with large or generated files, the extension automatically excludes:

### Ignored Directories
These directories are never included in snapshots (even if not in `.gitignore`):
- `node_modules`, `.venv`, `venv`, `env`, `.env`
- `dist`, `build`
- `.pytest_cache`, `.mypy_cache`, `.cache`, `.tox`, `__pycache__`

### Size Limits
- **Large files**: Untracked files larger than 10 MiB are excluded
- **Large directories**: Untracked directories with more than 200 files are excluded

### Safe Restore
On restore, the extension **never deletes**:
- Files in ignored directories
- Large files/directories that were excluded from the snapshot
- Pre-existing untracked files that existed when the checkpoint was created

## License

MIT (see repository root)
