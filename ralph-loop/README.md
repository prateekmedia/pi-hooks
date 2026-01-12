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

## Features

- Takes a prompt and exit condition (exit condition optional)
- Can supply max iterations and minimum delay between each
- Optionally supply model and thinking

Example prompt: "Use ralph loop to check the current time five times, sleeping 1s between iterations."

## Examples

- Use chain ralph loop to implement a quick fix, then write a brief self-review of the patch.
- Use parallel ralph loop to summarize `README.md` and `CONTRIBUTING.md` at the same time.

## Notes

- `conditionCommand` must print `true` to continue; any other output stops the loop.
- `maxIterations` defaults to `Number.MAX_SAFE_INTEGER` when omitted.
- Includes a built-in `worker` fallback; user/project agents override it if present.
- Defaults to agent `worker` and the latest user prompt when `agent`/`task` are omitted.
