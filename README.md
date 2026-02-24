# pi-blindtest

Blind model testing extension for [pi](https://github.com/badlogic/pi-mono).

## What it does

- Registers a virtual provider/model: `blindtest/blind`
- At session start, randomly assigns one real model from a configured model pool (once per session)
- Exposes `blindtest/blind` for blind routing, but you can still switch models manually at any time
- Routes all requests in the background to the assigned real model
- Adds `/another-model` to retry the first prompt in a new session with a different hidden model
- Adds `/rate` to rate the current hidden model in this session
- Adds `/ratings` to show per-model average and number of ratings across all saved sessions

## Model pool configuration

Optional config files:

- Global: `~/.pi/agent/pi-blindtest.json`
- Project: `.pi/blindtest.json` (overrides global)

Format:

```json
{
  "models": [
    "openai-codex/gpt-5.3-codex",
    "anthropic/claude-sonnet-4-6"
  ]
}
```

If no config is provided, pi-blindtest uses `enabledModels` from pi settings when available; otherwise it falls back to all authenticated models (excluding `blindtest/blind`).

If you use `enabledModels`, include `blindtest/blind` there as well so it appears in `/model` picker.

## Commands

- `/another-model`
  - Starts a new session (with the current session set as parent).
  - Draws a new hidden model from the same pool, excluding the previous session's assigned hidden model when possible.
  - Replays the first user message from the previous session automatically.
  - Edge cases:
    - if no first user message exists, it starts the new session and asks you to type a prompt manually;
    - if only one model is available in the pool, it warns and does not switch.

- `/rate <1-5> [optional note]`
  - Example: `/rate 4 solid output`
  - If no score is provided in interactive mode, it opens a 1–5 picker.
  - Confirmation shows session average and (when available) global average for the rated model.

- `/ratings`
  - Shows global stats across all saved session files:
    - current hidden model average
    - overall average
    - per-model average and rating count
  - In interactive mode, posts a non-interactive content block into chat history (so it scrolls naturally).

## Notes

- Hidden model assignment is persisted in session custom entries (`pi-blindtest-assignment`) and reused when you switch back to that session.
- `/another-model` creates a fresh session assignment; it does not mutate the previous session’s assignment.
- Ratings are persisted in session custom entries (`pi-blindtest-rating`).
- `/ratings` aggregates across all saved session files and uses a fast prefilter (ripgrep when available, streamed marker scan fallback) before parsing entries.
