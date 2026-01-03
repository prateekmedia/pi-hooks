# Permission Hook

Layered permission control for pi-coding-agent.

## Levels

| Level | Description | Allowed Operations |
|-------|-------------|-------------------|
| **minimal** | Read-only (default) | `cat`, `ls`, `grep`, `git status/log/diff`, `npm list` |
| **low** | File operations | + `write`/`edit` files |
| **medium** | Dev operations | + `npm install`, `git commit`, build commands |
| **high** | Full operations | + `git push`, deployments, scripts |

**Dangerous commands** (always prompt, even at high): `sudo`, `rm -rf`, `chmod 777`, `dd`, `mkfs`

## Usage

### Interactive Mode

```bash
# Hook loads automatically from ~/.pi/agent/hooks/ or .pi/hooks/
pi
```

**Commands:**
- `/permission` - Show selector to change level
- `/permission medium` - Set level directly (asks session/global)

**When a command needs higher permission:**
```
🔒 Requires Medium: npm install lodash

  [Allow once]           → Execute this command only
  [Allow all (Medium)]   → Update global settings and execute
  [Cancel]               → Don't execute
```

### Print Mode

```bash
# Set level via environment variable
PI_PERMISSION_LEVEL=medium pi -p "install deps and run tests"

# Bypass all permission checks (CI/containers - dangerous!)
PI_PERMISSION_LEVEL=bypassed pi -p "do anything"
```

**If permission is insufficient:**
The command is blocked but execution continues. The agent receives:
```
Blocked by permission (minimal). Command: npm install lodash
Allowed at this level: read-only (cat, ls, grep, git status/diff/log, npm list, version checks)
User can re-run with: PI_PERMISSION_LEVEL=medium pi -p "..."
```

The agent can then work around the limitation or inform the user.

## Environment Variables

| Variable | Values | Description |
|----------|--------|-------------|
| `PI_PERMISSION_LEVEL` | `minimal`, `low`, `medium`, `high`, `bypassed` | Set permission level |

## Settings

Global settings stored in `~/.pi/agent/settings.json`:

```json
{
  "permissionLevel": "medium"
}
```

## Custom Configuration

Configure permission overrides and prefix mappings in `~/.pi/agent/settings.json`:

```json
{
  "permissionLevel": "medium",
  "permissionConfig": {
    "overrides": {
      "minimal": ["tmux list-*", "tmux show-*"],
      "medium": ["tmux attach*", "tmux new*"],
      "high": ["rm -rf *"],
      "dangerous": ["dd if=* of=/dev/*"]
    },
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" },
      { "from": "rbenv exec", "to": "" }
    ]
  }
}
```

### Override Patterns

Glob patterns matched against the full command:
- `*` matches any characters
- `?` matches single character
- Patterns are case-insensitive

Override priority (highest to lowest):
1. `dangerous` - Always prompt, even at high level
2. `high` - Require high permission
3. `medium` - Require medium permission
4. `low` - Require low permission
5. `minimal` - Allow at minimal (read-only)

> **Note:** When a command matches patterns in multiple levels, the **most restrictive** level wins. Avoid overlapping patterns across levels. For example, don't put `tmux *` in medium if you want `tmux list-*` to be minimal.

**Examples:**
```json
{
  "overrides": {
    "minimal": [
      "tmux list-*",      // tmux list-sessions, tmux list-windows, etc.
      "tmux show-*",      // tmux show-options, tmux show-messages, etc.
      "screen -list"      // List screen sessions
    ],
    "medium": [
      "tmux attach*",     // Attach to sessions
      "tmux new*",        // Create new sessions
      "screen -r *"       // Reattach to screen
    ],
    "high": [
      "rm -rf *",         // Force rm with any arguments
      "dd of=/dev/*"      // dd writing to any device
    ],
    "dangerous": [
      "dd if=* of=/dev/*" // dd writing to device from any source
    ]
  }
}
```

### Prefix Mappings

Normalize version manager commands to their base tools:
- `fvm flutter build` → treated as `flutter build` (medium)
- `rbenv exec ruby` → treated as `ruby` (classified normally)

**Common mappings:**
```json
{
  "prefixMappings": [
    { "from": "fvm flutter", "to": "flutter" },
    { "from": "nvm exec", "to": "" },
    { "from": "rbenv exec", "to": "" },
    { "from": "pyenv exec", "to": "" }
  ]
}
```

**How it works:**
1. Commands are checked against prefix mappings first
2. If a prefix matches, it's replaced with the mapped value
3. The normalized command is then classified

### /permission config Command

View and manage configuration from the CLI:

```
/permission config show    # Display current configuration
/permission config reset   # Reset to default (empty)
```

Edit `~/.pi/agent/settings.json` directly for full control.

## Command Classification

The principle: **building/installing is MEDIUM, running code is HIGH**.

### Minimal Level (Read-only)
- File reading: `cat`, `less`, `head`, `tail`, `bat`
- Directory: `ls`, `tree`, `pwd`, `find`, `fd`
- Search: `grep`, `rg`, `ag`
- Info: `echo`, `whoami`, `date`, `uname`, `ps`, `env`
- Git read: `git status`, `git log`, `git diff`, `git show`, `git branch`, `git fetch`
- Package info: `npm list`, `pip list`, `cargo tree`

### Medium Level (Build/Install/Test - Reversible)
- **Node.js**: `npm install/ci/test/build`, `yarn install/add/build/test`, `pnpm`, `bun`
- **npm run** (safe scripts only): `build`, `test`, `lint`, `format`, `check`, `typecheck`
- **Python**: `pip install`, `poetry install/build`, `pytest`
- **Rust**: `cargo build/test/check/clippy/fmt` (NOT `cargo run`)
- **Go**: `go build/test/get/mod` (NOT `go run`)
- **Ruby**: `gem install`, `bundle install`
- **CocoaPods**: `pod install`, `pod update`, `pod repo update`
- **PHP**: `composer install`
- **Java**: `mvn compile/test`, `gradle build/test`
- **.NET**: `dotnet build/test`
- **Git local**: `git add`, `git commit`, `git pull`, `git checkout`, `git merge`, `git clone`
- **Build tools**: `make`, `cmake`, `ninja`
- **Linters**: `eslint`, `prettier`, `black`, `rustfmt`, `mypy`
- **File ops**: `mkdir`, `touch`, `cp`, `mv`

### High Level (Runs Code / Irreversible)
- **Running code**: `python script.py`, `node app.js`, `cargo run`, `go run`
- **npm run** (unsafe scripts): `dev`, `start`, `serve`, `watch`, `preview`
- **Package executors**: `npx`, `bunx`, `pnpx` (run arbitrary packages)
- **Git remote**: `git push`, `git push --force`
- **Git irreversible**: `git reset --hard`, `git clean`, `git restore`
- **Network**: `curl`, `wget` (can't verify trusted endpoints)
- **Deployment**: `docker push`, `kubectl`, `helm`, `terraform`
- **Remote access**: `ssh`, `scp`, `rsync`
- **Shell execution**: `eval`, `exec`, `source`, `xargs`

### Dangerous (Always Prompt)
- `sudo` (any form)
- `rm` with `-r` AND `-f` flags
- `chmod 777` or `a+rwx`
- `dd of=/dev/...`
- `mkfs`, `mkfs.ext4`, `fdisk`, `parted`
- `shutdown`, `reboot`, `halt`, `poweroff`

## Shell Trick Detection

Commands containing these patterns require HIGH permission:
- Command substitution: `$(cmd)`, `` `cmd` ``
- Process substitution: `<(cmd)`, `>(cmd)`
- Dangerous expansions: `${VAR:-$(cmd)}` (nested command substitution)

## Installation

1. Copy to hooks directory:
   ```bash
   cp -r permission ~/.pi/agent/hooks/
   ```

2. Install dependencies:
   ```bash
   cd ~/.pi/agent/hooks/permission
   npm install
   ```

## License

MIT
