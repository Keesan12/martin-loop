# MartinLoop 0.4.6 — Terminal UX polish

`0.4.6` ships two post-Arcade UX fixes that were committed to `main` immediately after the `0.4.5` release.

## What changed

- **Arcade auto-exit**: the Space Invaders game now closes automatically 2 seconds after the governed run completes — the terminal is restored without requiring the user to press Q
- **Rating keypress**: the post-run feedback rating (1–5) now registers on a single keypress with no Enter required
- **Star CTA browser open**: the star prompt at the end of a successful run now accepts a single keypress — press Enter to open `https://github.com/Keesan12/martin-loop` directly in the browser, or `s` to skip; non-TTY and piped output retain the static text form unchanged

## Commits on main ahead of 0.4.5

- `51cc188` — `fix(arcade): auto-exit game 2 s after governed run completes`
- `ebea7f5` — `feat(ux): single-keypress rating and interactive star CTA with browser open`

## Package lines in this release

- root package advances to `0.4.6`
- standalone `@martinloop/mcp` remains at `0.3.8` (no MCP server changes in this release)

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
