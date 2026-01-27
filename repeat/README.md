# Repeat Extension

Repeat past tool calls (bash/edit/write) from the current branch.

## Usage

- Run `/repeat` to open the picker of previous bash/edit/write tool calls (type to search).
- Bash entries load into the editor as `!command` for tweaking and running.
- Write entries open a temp editor (if `$EDITOR` is set) and apply only when you save.
- Edit entries can repeat the edit (may fail) or open `$EDITOR` at the first changed line; repeat uses a temp editor and applies on save.

## Notes

- Uses `$VISUAL` or `$EDITOR` when available.
- Only shows tool calls from the current branch.
