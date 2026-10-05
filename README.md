# paniolo-obsidian

An Obsidian plugin that is a **thin shell over the `paniolo` CLI** — it brings
paniolo's lint, staleness, and workspace-search surfaces into the reader where
the human actually is. Every feature is `execFile → paniolo → render`; no
business logic lives in the plugin.

Desktop only (`isDesktopOnly: true`) — it shells out to the `paniolo` binary.

## Features

- **Lint this page** — command runs `paniolo scan` (per-file) and `paniolo
  wiki` (when the file lives under a `wiki/` root) against the nearest
  `paniolo.config.json`, then renders findings as CodeMirror diagnostics:
  squiggles, hover messages, and a lint gutter. Findings count appears in the
  status bar.

## Requirements

- `paniolo` on `PATH` (or an explicit path in the plugin settings).
- A `paniolo.config.json` above the edited file — the plugin walks up from the
  file to find it. Unconfigured vaults get a visible Notice, never a silent
  no-op.

## Development

```bash
pnpm install
pnpm run dev      # esbuild watch; copies main.js/manifest.json/styles.css
                  # into the dev vault's .obsidian/plugins/paniolo-obsidian/
pnpm run build    # typecheck + production bundle
```

Set `PANIOLO_VAULT_PLUGINS` to target a different vault's plugin directory.

Reload the plugin in Obsidian after each change (disable/enable in Community
plugins, or use the Hot-Reload plugin).

## Design

Thin-adapter rule, per the harness: JS only as a shell around the Rust
products (`paniolo scan` / `wiki` / `stale` / `qmd`). See
`paniolo-wiki/wiki/plan-paniolo-obsidian-plugin.md` for the full card list and
`design-paniolo-obsidian-plugin.md` for the product rationale.
