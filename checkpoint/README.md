# checkpoint hook

Git-based checkpoint helper for [`pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

## What it does
- Saves the full worktree (tracked + untracked) at the start of every turn.
- Stores snapshots as Git refs so you can restore code while branching conversations.
- Creates a "before restore" checkpoint automatically to avoid losing current work.

## Setup
```bash
cd checkpoint
npm install
```

Place `checkpoint.ts` where pi can load it:
- **Project scoped**: `mkdir -p .pi/hooks && cp checkpoint/checkpoint.ts .pi/hooks/checkpoint.ts`
- **Global**: add the absolute file path to `~/.pi/agent/settings.json` under `"hooks"`.

## Requirements
- Git repository (hook checks for it automatically)
- Node.js 18+

## License
MIT (see repository root)
