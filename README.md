# pi-auto-rename

Modern automatic session renaming for [pi](https://github.com/earendil-works/pi). After the
first user message, your session gets a short, meaningful title in the session selector —
instead of showing the first message's full text. Zero-config: install and it works; every
behavior is configurable and predictable, and it never overwrites a name you set yourself.

## Features

- **Auto-naming on session start** — names the session once from the first 3 non-empty
  user/assistant messages (4000 chars each). Resumed sessions that have messages but no
  name get named too.
- **Language-aware, concise titles** — Chinese conversations get Chinese titles (≤12
  chars), English conversations get 2–6 word titles. Titles are capped at 80 chars, with
  no quotes or trailing punctuation.
- **Continuous re-naming (off by default)** — after a topic shift (≥5 minutes since the
  last auto name **and** ≥3 new messages), the title is re-evaluated and updated if the
  topic changed. Single-flight guarded, never spams.
- **Manual names are never overwritten** — `/name`, `/rename <name>`, and `/rename` (AI)
  all mark the session as manual. The flag is persisted in the session, so it survives
  restart and `/resume`. External renames are detected and protected too.
- **Model follows your session** — naming uses your current session model by default, no
  configuration needed. Override it per-session-globally with `/rename-config model`.
- **Graceful degradation** — if the naming model is unavailable or has no API key, auto
  naming skips silently with a warning notification; `/rename` reports a clear error.

## Requirements

- pi ≥ 0.84 with `@earendil-works/pi-ai` ≥ 0.84 (naming calls use the
  `@earendil-works/pi-ai/compat` subpath, where `complete()` lives in 0.84).
- Node.js with jiti-based TS loading (pi's default; no compilation step).

## Installation

Install as a pi package (from a git URL or a local directory):

```bash
pi install git:github.com/you/pi-auto-rename
# or from a local checkout
pi install /path/to/pi-auto-rename
```

Or symlink directly into the auto-discovered extensions directory (hot-reloadable with
`/reload`):

```bash
mkdir -p ~/.pi/agent/extensions/pi-auto-rename
ln -s $PWD/index.ts $PWD/config.ts $PWD/state.ts $PWD/naming.ts ~/.pi/agent/extensions/pi-auto-rename/
```

Then run `/reload` inside pi (or restart pi).

## Commands

| Command | Behavior |
|---|---|
| `/rename` | Generate a new title from the full conversation history (≤8000 chars) and set it. Marks the session as **manual**. |
| `/rename <name>` | Set the session name directly. Marks the session as **manual**. |
| `/rename-config` | Interactive wizard: model / style / auto / continuous / language / show / reset / done (TUI). Loops back to the menu after each change; `esc` exits. Falls back to showing the config in UI-less modes. |
| `/rename-config model` | Interactive model picker (when a TUI is available). |
| `/rename-config model provider/id` | Use a specific model for naming. |
| `/rename-config model none` | Clear the override; naming follows the session model again. |
| `/rename-config style concise\|formal\|playful\|custom [desc]` | Set the naming style. `custom` requires a description. |
| `/rename-config auto on\|off` | Master switch for automatic naming (default `on`). |
| `/rename-config continuous on\|off` | Continuous re-naming on topic shift (default `off`). |
| `/rename-config language auto\|zh\|en` | Title language (default `auto` = follow the conversation). |

All subcommands and values support tab-completion.

## Configuration

Persisted to `<agentDir>/pi-auto-rename.json` (`~/.pi/agent/pi-auto-rename.json`):

```json
{
  "style": "concise",
  "autoRename": true,
  "continuousRename": false,
  "language": "auto"
}
```

| Field | Default | Meaning |
|---|---|---|
| `model` | *(absent)* | `{ provider, id }` naming-model override; absent = follow session model. |
| `style` | `concise` | `concise` \| `formal` \| `playful` \| `custom` |
| `customStyle` | *(absent)* | Free-form style description when `style` is `custom`. |
| `autoRename` | `true` | Master switch for automatic naming. |
| `continuousRename` | `false` | Re-name on topic shift (≥5 min + ≥3 new messages). |
| `language` | `auto` | Title language: `auto` (follows the conversation), `zh`, or `en`. |

Read failures fall back to defaults; write failures keep the runtime config and show a
warning, so the extension always stays usable.

## Manual-name protection

- `pi.setSessionName()` / `/name`, `/rename <name>`, and `/rename` (AI) all mark the
  session as **manual**; automatic naming (including continuous) is then disabled for the
  rest of the session.
- The manual flag is stored with `pi.appendEntry("pi-auto-rename:state", ...)` (a custom
  entry that does not enter the LLM context), so it survives restarts, `/reload`, and
  `/resume`.
- External renames are detected in `session_info_changed` by comparing the reported name
  with the name this extension last set.

## Known limitations

- `session_info_changed` does not reveal who renamed the session. The extension uses a
  name-comparison heuristic: a change that does not match the extension's last-set name is
  treated as a manual rename. One accepted edge case: if the user manually renames a
  session *back* to the exact auto-generated name, the extension cannot tell and may treat
  it as its own call — harmless in practice because no auto naming re-runs for an
  unchanged name.
- Naming runs only when a TUI is available for the model picker; in `print`/`json`/`rpc`
  modes `/rename-config model` (no args) shows a usage hint instead of a picker. Auto
  naming itself still works.
- Continuous naming never fires while an earlier naming request is in flight, and requires
  both the 5-minute and 3-message thresholds — so title updates lag topic shifts slightly
  by design.

## Layout

```
index.ts     # Entry: event bindings, state machine, commands
config.ts    # Global config type, defaults, read/write
state.ts     # Per-session state persistence (pi.appendEntry)
naming.ts    # Model resolution, prompt building, complete() call, title sanitizing
ui-config.ts # Interactive /rename-config wizard (TUI pickers, searchable model list)
```

## License

MIT
