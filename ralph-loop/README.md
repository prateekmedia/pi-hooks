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

- Runs single or chain subagent tasks until a condition returns false
- Takes a prompt and exit condition (exit condition optional)
- Can supply max iterations and minimum delay between each
- Optionally supply model and thinking
- Interactive steering + control commands when running in UI mode

## Interactive Controls

While `ralph_loop` is running in interactive mode:

- `/ralph-steer <message>` to append steering instructions (`--once` for one-off)
- `/ralph-follow <message>` to queue a follow-up message
- `/ralph-clear` to clear queued steering messages
- `/ralph-pause` / `/ralph-resume` to pause/resume the currently running iteration
- `/ralph-stop` to abort the loop
- `/ralph-status` to show loop status

Tool results render with the rich UI by default (no collapsed trim). Ctrl+O still expands nested tool outputs. Steering and follow-up messages are sent to the current iteration when possible, otherwise queued for the next iteration; queued/sent messages show in the UI.

Example prompt: "Use ralph loop to check the current time five times, sleeping 1s between iterations."

## Examples

- Use chain ralph loop to implement a quick fix, then write a brief self-review of the patch.
- Use chain ralph loop to summarize `README.md`, then `CONTRIBUTING.md`.

## Notes

- `conditionCommand` must print `true` to continue; any other output stops the loop.
- `maxIterations` defaults to `Number.MAX_SAFE_INTEGER` when omitted.
- Includes a built-in `worker` fallback; user/project agents override it if present.
- Defaults to agent `worker` and the latest user prompt when `agent`/`task` are omitted.
