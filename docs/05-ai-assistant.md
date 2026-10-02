# AI assistant: how it works, what was verified, and its limits

_Last verified 2026-10-02: Claude Code 2.1.287 and Codex CLI 0.153.4, each signed in with a personal subscription._

## What the person sees

- **✦ Assistant** in the top bar (or **Ctrl+K**) opens a panel in place of the left column.
- The person types a request in everyday words, for example "make these windows pulse blue with the music", then "slower", then "only these windows".
- "These" and "this" mean the parts currently selected on the picture. The panel shows that selection above the text box.
- Changes appear in the preview straight away.
- **What changed** lists each change in plain words, for example: Changed "Blue beat pulse": flash on Every beat → Every other beat.
- Every request is **one undo step**:
  - **Undo** on a request removes only that request's changes and keeps everything done since.
  - If a later change builds on it, the panel explains why it can't be undone on its own and changes nothing.
  - Ctrl+Z works as usual.
- The assistant builds the same effects and layers as the visual tools. What it makes is selected in the Inspector, so it can be adjusted by hand right away.
- Nothing in Before Effects requires the assistant. Every journey test makes, animates, previews and exports without it.

## No API keys: the person's own subscription

Before Effects never asks for, stores or uses an API key. It drives the official command-line tools the person already has, signed in with their subscription:

| | Claude | ChatGPT |
|---|---|---|
| Tool | Claude Code (`claude -p`, headless mode) | Codex (`codex exec`, non-interactive mode) |
| Sign-in it uses | The Claude.ai login (Pro/Max) | "Sign in with ChatGPT" |
| Status check | `claude auth status` → `authMethod: "claude.ai"`, `subscriptionType` | `codex login status` → "Logged in using ChatGPT" |
| Live check per request | The session-start event reports `apiKeySource`. On this PC it reported `"none"` (subscription). Any other value stops the request before work starts. | — |
| Usage shown | The `rate_limit_event` reports the share used of the 5-hour and weekly allowances. The panel shows it (e.g. "N% of the 5-hour allowance used"). | Not reported by `codex exec`. The panel says it uses the ChatGPT plan's Codex allowance. |
| Paid extra usage | `rate_limit_event.isUsingOverage`. If it becomes true, the request is stopped (extra usage is off by default). | Not applicable (plan limits only) |

Billing safeguards:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `OPENAI_API_KEY` and `CODEX_API_KEY` are removed from the tool's environment. Any of them would switch the tool to pay-per-use billing.
  - Per Anthropic's docs, an `ANTHROPIC_API_KEY` overrides the subscription.
  - In Codex source, `CODEX_API_KEY` takes precedence in `exec`.
- `--bare` is **never** used for Claude Code. Per the docs it "never reads OAuth credentials", so it would require an API key.
- If a tool reports an API-key login (`authMethod: api_key`, `api_key_helper`, or Codex "API key"), the panel marks it not ready. It explains how to switch to the subscription and does not run it.

## Policy notes (honest reading, not legal advice)

- **Claude:** headless `claude -p` is a documented Claude Code feature, and here the person runs their own installed tool for their own personal use, which is this project's licence scope. Anthropic's Agent SDK docs say third-party developers may not offer Claude.ai login or subscription rate limits in their products without prior approval. That applies to distributing an app that signs people in with Claude.ai. **If Before Effects is ever distributed to others, this route must be revisited**: get approval, or offer the person's own API key as an explicit, clearly billed option.
- **ChatGPT/Codex:**
  - `codex exec` with ChatGPT sign-in is documented. Pricing lists "`codex exec` and scriptable workflows" for Plus, Pro, Business and Enterprise.
  - OpenAI recommends API keys for CI and automation, which this isn't: one person runs it on their own PC.
  - For distributed apps, OpenAI's new "Sign in with ChatGPT" for third-party apps (Sept 2026) is the sanctioned route.

## Architecture

```
Editor window (renderer)            Main process                         Person's CLI (subscription)
 AssistantPanel ── run() ─────────► assistant.ts ── spawn ─────────────► claude -p … / codex exec …
 tools.ts ◄── assistant:tool ────── named pipe server ◄─ JSON lines ──── mcp-bridge.js (stdio MCP server,
   (typed ops → History,             (one-time token)                     started by the CLI, runs as
    one undo group per request)                                           Before Effects.exe + ELECTRON_RUN_AS_NODE)
```

- **Tools** (`packages/core/src/assistant.ts`):
  - `get_show`: parts, groups, effects and settings, other layers, media with tempo, the selection, the playhead. This is structure only; no pictures, video or audio are sent.
  - `list_effects`: every effect with its settings, ranges and defaults.
  - `apply_effect` and `change_effect`: these take part names or ids, group names, "windows" or "selected"; colours as `#rrggbb`; times in seconds.
  - `remove_effect`.
  - `list_operations` and `run_operations`: every low-level operation with its JSON Schema, for anything effects don't cover.
  - `show_moment`.
- **Confinement:**
  - Claude Code runs with `--tools ""` (no built-in tools), `--strict-mcp-config --mcp-config <file>` (only Before Effects' server), `--allowedTools mcp__be` and `--permission-mode dontAsk`. It also runs with `--setting-sources ""` and its own system prompt in an empty working folder.
  - Codex runs with `--sandbox read-only --ignore-user-config --skip-git-repo-check -C <empty folder>`, `features.shell_tool=false` and web search disabled. Before Effects' tools are marked `approve`, because `exec` otherwise denies MCP calls that need approval.
- **Follow-ups:** the conversation continues with `--resume <session>` (Claude) or `codex exec resume <thread>`. Each request also carries the current selection, the playhead and the effects made earlier, so "slower" and "only these windows" refer to the right things.
- **Errors:**
  - Tool errors go back to the model in plain words (e.g. "These parts don't exist: chimney"), so it can correct itself or ask.
  - Usage limits, sign-in problems, network failures and busy services become plain messages in the panel.
  - **Stop** ends the request and its process.

## Verified (2026-10-02)

| Check | Result |
|---|---|
| Both tools detected, signed in with subscriptions | Claude via Claude Code; ChatGPT via Codex. Both "ready", billing = subscription |
| Headless Claude on the subscription | `apiKeySource: "none"`, model claude-opus-5-5; usage events reported the share of the 5-hour window used |
| Live, Claude (dev build and packaged app) | "Make these windows pulse blue with the music": Move with the beat in blue on the 4 selected windows. "Slower": every other beat, longer fade. "Only these windows": moved to windows 5–6. About 4–7 s per request. |
| Live, Codex | The same three requests, all correct. About 13–22 s per request |
| Scripted journey (no AI usage, real bridge) | One undo step per request; the new effect is selected for hand edits; "slower" keeps the colour; "only these" retargets; undoing the last request keeps later hand edits; dependent undo is refused with an explanation; plain tool errors; Stop leaves no processes |
| Not set up | The panel explains how to install and sign in to either tool; no paid option is offered; "Check again" finds them |

## Limits and open items

- Changes apply live and are undoable. There is no separate "proposal" mode that previews before anything changes.
- Edits are kept to what was asked by the tool design and instructions, not by a hard scope lock. `run_operations` can change anything, but always as one undoable step.
- After one selective undo, an earlier request can't be selectively undone past it (normal Undo still works).
- Codex doesn't report plan usage in `exec`, so the panel can't show a percentage for ChatGPT.
- No local or offline model yet.
- Not yet tested with first-time users (see the usability kit).
