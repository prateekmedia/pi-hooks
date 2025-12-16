# DM Authorization

By default, mom does not respond to direct messages. This prevents unauthorized users from consuming your API credits.

---

## Security Model

- DMs are **disabled by default**
- To enable DMs for everyone (private servers): set `allowDMs: true`
- To restrict to specific users: set `allowDMs: true` with `dmAllowlist`
- Unauthorized DMs are **silently ignored** (no response)
- Message logging still occurs for unauthorized DMs

---

## Discord Prerequisite

Before DMs will work on Discord, users must enable DMs in their server privacy settings:

1. Click the server name dropdown
2. Select "Privacy Settings"
3. Enable "Direct Messages and Friend Requests"

Without this, Discord blocks the DM at the platform level before it even reaches mom.

---

## Enable DMs

Add to `settings.json` in your workspace root:

**Allow all DMs (private servers):**
```json
{
  "allowDMs": true
}
```

**Restrict to specific users:**
```json
{
  "allowDMs": true,
  "dmAllowlist": ["U123ABC", "456789012345678901"]
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `allowDMs` | boolean | `false` | Master switch for DM handling |
| `dmAllowlist` | string[] | `[]` | User IDs allowed to DM (empty = allow all)

---

## Finding User IDs

### Slack

1. Open the user's profile
2. Click the "..." menu
3. Select "Copy member ID"

Format: `U` followed by alphanumeric (e.g., `U0123ABCDEF`)

### Discord

1. Enable Developer Mode: User Settings > App Settings > Advanced > Developer Mode
2. Right-click the user
3. Select "Copy User ID"

Format: 18-digit number (e.g., `123456789012345678`)

---

## Unified Allowlist

The `dmAllowlist` works for both Slack and Discord. You can mix user IDs from both platforms:

```json
{
  "allowDMs": true,
  "dmAllowlist": [
    "U0123ABCDEF",
    "U9876ZYXWVU",
    "123456789012345678",
    "987654321098765432"
  ]
}
```

---

## Behavior Matrix

| `allowDMs` | `dmAllowlist` | Result |
|------------|---------------|--------|
| `false` (default) | - | All DMs ignored |
| `true` | `[]` or missing | All DMs allowed |
| `true` | `["U123"]` | Only U123 can DM |

---

## What Still Works

Even when DMs are blocked:

- Messages are still logged to `log.jsonl`
- User can still @mention mom in shared channels

Only the **agent trigger** is blocked for unauthorized DMs.
