# Implementation Summary: Permission Overrides & Prefix Mappings

## Overview

Two new configurable features have been added to the permission system:

1. **Permission Overrides** - Configure custom permission levels for command patterns
2. **Prefix Mappings** - Normalize version manager commands to their base tools

## Review Fixes Applied

Based on code review, the following issues were addressed:

### Critical Fixes
1. **Override consistency** - Changed `checkOverrides()` to use normalized command (after prefix mapping) for consistent behavior
2. **Schema validation** - Added `validateConfig()` function with runtime type checking and limits
3. **Substring offset bug** - Fixed case-insensitive prefix matching to use correct substring offset

### Warning Fixes
1. **Bounded regex cache** - Added `MAX_REGEX_CACHE_SIZE = 500` with FIFO eviction
2. **Removed redundant double-star** - Simplified glob-to-regex conversion
3. **Null checks in pattern arrays** - Added proper null/undefined/type guards in `matchesAnyPattern()`
4. **Removed duplicate code** - Eliminated redundant `ctx.hasUI` branches in `handleConfigSubcommand()`
5. **Fixed magic number** - Replaced `arg.substring(6)` with regex-based extraction
6. **Better word boundary detection** - Updated prefix matching to handle tabs and multiple spaces

### New Security Limits
- Max 100 patterns per override level
- Max 50 prefix mappings
- Max 500 cached regex patterns
- Invalid config entries filtered at load time

## Changes Made

### 1. permission-core.ts

#### New Types
```typescript
export interface PermissionConfig {
  overrides?: {
    minimal?: string[];
    low?: string[];
    medium?: string[];
    high?: string[];
    dangerous?: string[];
  };
  prefixMappings?: Array<{
    from: string;
    to: string;
  }>;
}
```

#### New Functions
- `loadPermissionConfig()` - Load config from settings.json
- `savePermissionConfig(config)` - Save config to settings.json
- `invalidateConfigCache()` - Clear cached config/regex
- `globToRegex(pattern)` - Convert glob patterns to RegExp
- `matchesAnyPattern(command, patterns)` - Check if command matches any pattern
- `applyPrefixMappings(command, mappings)` - Normalize command using prefix mappings
- `checkOverrides(command, overrides)` - Check for override classification

#### Modified Functions
- `classifyCommand(command, config?)` - Now accepts optional config for testing

### 2. permission-hook.ts

#### New Handler
- `handleConfigSubcommand(state, args, ctx)` - Handle `/permission config` subcommands

#### Updated Handler
- `handlePermissionCommand(state, args, ctx)` - Routes config subcommand

#### New Imports
- `loadPermissionConfig`, `savePermissionConfig`, `invalidateConfigCache`, `type PermissionConfig`

### 3. tests/permission.test.ts

Added comprehensive tests:
- `override: custom minimal patterns`
- `override: custom medium patterns`
- `override: custom high patterns`
- `override: dangerous patterns`
- `override: priority order`
- `prefix: fvm flutter normalization`
- `prefix: multiple prefix mappings`
- `prefix: empty mapping (strip prefix)`
- `prefix: combined with overrides`
- `config: empty config doesn't break classification`
- `config: null/undefined patterns handled`
- `config: case insensitivity`

### 4. README.md

Added documentation for:
- Configuration schema
- Override patterns with examples
- Prefix mappings with examples
- `/permission config` command usage

## Configuration Examples

### Override Patterns
```json
{
  "permissionConfig": {
    "overrides": {
      "minimal": ["tmux list-*", "tmux show-*"],
      "medium": ["tmux *", "screen *"],
      "high": ["rm -rf *"],
      "dangerous": ["dd if=* of=/dev/*"]
    }
  }
}
```

### Prefix Mappings
```json
{
  "permissionConfig": {
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "nvm exec", "to": "" },
      { "from": "rbenv exec", "to": "" }
    ]
  }
}
```

### Combined Configuration
```json
{
  "permissionLevel": "medium",
  "permissionConfig": {
    "overrides": {
      "minimal": ["tmux list-*", "flutter doctor"],
      "medium": ["tmux *"]
    },
    "prefixMappings": [
      { "from": "fvm flutter", "to": "flutter" },
      { "from": "rbenv exec", "to": "" }
    ]
  }
}
```

## Usage

### View Current Configuration
```bash
/permission config show
```

### Reset Configuration
```bash
/permission config reset
```

### Edit Configuration Directly
Edit `~/.pi/agent/settings.json` for full control.

## Implementation Details

### Classification Flow

1. **Prefix Normalization** - Apply prefix mappings first
   - `fvm flutter build` → `flutter build`

2. **Override Check** - Check for configured overrides
   - If `flutter doctor` matches `minimal` override → return minimal

3. **Built-in Classification** - Use existing classification logic
   - `flutter build` → medium

### Pattern Matching

- Glob patterns converted to RegExp
- `*` → `.*` (any characters)
- `?` → `.` (single character)
- Case-insensitive matching
- Full command string matching (must match from start to end)

### Priority Order

Overrides are checked in this order:
1. `dangerous` → { level: "high", dangerous: true }
2. `high` → { level: "high", dangerous: false }
3. `medium` → { level: "medium", dangerous: false }
4. `low` → { level: "low", dangerous: false }
5. `minimal` → { level: "minimal", dangerous: false }

### Caching

- Config cached for 5 seconds (TTL)
- Compiled regex patterns cached indefinitely
- Cache invalidated on config changes

### Testing Support

- `classifyCommand(command, config)` accepts optional config
- Allows testing without modifying global settings

## Test Results

All 138 tests pass:
- 115 existing tests (unchanged)
- 23 new tests including:
  - Override patterns (minimal, medium, high, dangerous, priority)
  - Prefix mappings (fvm flutter, multiple mappings, empty mapping)
  - Combined features (prefix + override)
  - Security edge cases (wildcard bypass, dangerous mapping, consistency)
  - Whitespace handling (tabs, multiple spaces, partial match)
  - Pattern edge cases (question mark, special regex chars, empty arrays)

## Backward Compatibility

- All new configuration is optional
- Defaults to empty config (no overrides, no mappings)
- Existing `settings.json` files without new fields work unchanged
