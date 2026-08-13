# MartinLoop 0.4.6 — Terminal UX polish

> Superseded: 0.4.6 was not published. Its retained user-facing changes are included in MartinLoop 0.5.0.

This draft is retained for historical context only.

## What changed

- **Arcade auto-exit**: the Space Invaders game now closes automatically 2 seconds after the governed run completes — the terminal is restored without requiring the user to press Q
- **Rating keypress**: the post-run feedback rating (1–5) now registers on a single keypress with no Enter required
- **Star CTA browser open**: the star prompt at the end of a successful run now accepts a single keypress — press Enter to open `https://github.com/Keesan12/martin-loop` directly in the browser, or `s` to skip; non-TTY and piped output retain the static text form unchanged

## Package lines in this release

- No `0.4.6` package was published.
- Retained changes moved into the `0.5.0` release line.

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
