# Ralph Loop Extension

Looped subagent execution via the `ralph_loop` tool.

## Installation (only ralph-loop)

1. Copy the extension folder:
   ```bash
   cp -r ralph-loop ~/.pi/agent/extensions/
   ```

2. Add only this extension to `~/.pi/agent/settings.json`:
   ```json
   {
     "extensions": [
       "/absolute/path/to/pi-hooks/ralph-loop"
     ]
   }
   ```

No npm install is required for this extension (pi provides the runtime deps).

## Notes

- `conditionCommand` must print `true` to continue; any other output stops the loop.
- Defaults to agent `worker` and the latest user prompt when `agent`/`task` are omitted.
