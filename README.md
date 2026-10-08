# paniolo-obsidian

An Obsidian plugin that is a **thin shell over the `paniolo` CLI** — it brings
paniolo's lint, staleness, and workspace-search surfaces into the reader where
the human actually is. Every feature is `execFile → paniolo → render`; no
business logic lives in the plugin.

Agents write, humans read. Paniolo keeps the knowledge your agents produce
verified and disciplined; this plugin puts the checks where you read it.

Desktop only (`isDesktopOnly: true`) — it shells out to the `paniolo` binary.

## Features

- **Lint this page** — runs `paniolo scan` per-file, plus `paniolo wiki`
  when the file lives under a `wiki/` root, against the nearest
  `paniolo.config.json`. Findings render as CodeMirror diagnostics —
  squiggles, hover messages, and a lint gutter — with the error/warn count
  in the status bar.
- **Paniolo ▸ action bar** — a per-note footer button that opens a menu over
  the same commands the palette exposes. Wiki entries only appear when the
  open file is under a `wiki/` root, so ordinary notes never see them.
- **Search for related pages** — uses the open note's title and opening text
  to query qmd, then opens one of the top ranked wiki pages in the vault.
- **New wiki page** — a modal front-end for `paniolo wiki new`: pick the
  wiki, kind, slug, tags, title, and source. Before stamping the page, the
  plugin claims the slug vault-wide — colliding loose notes are renamed
  aside so existing `[[slug]]` links follow, while a managed page blocks
  the claim outright.
- **Wiki ops on the open page** — rename, move to another wiki, set status,
  show references, apply safe autofixes, archive, and delete — from the
  palette, the action bar, or the file-explorer context menu. Archive and
  delete show the CLI's dry-run plan in a confirm dialog before `--apply`
  ever runs.

## Requirements

- `paniolo` on `PATH` (or an explicit path in the plugin settings). Install
  it with `npm install -g @paniolo/cli`, or try the read-only scan first:
  `npx @paniolo/cli scan .`
- A `paniolo.config.json` above the edited file — the plugin walks up from
  the file to find it. Unconfigured vaults get a visible Notice, never a
  silent no-op.

## Install

Until it lands in the community directory, install manually:

1. Build from source (below) or grab `main.js`, `manifest.json`, and
   `styles.css` from a release.
1. Copy them into `<vault>/.obsidian/plugins/paniolo-obsidian/`.
1. Enable **Paniolo** under Settings → Community plugins.

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
products (`paniolo scan` / `wiki` / `stale` / `qmd`). The product rationale
and MVP card list live in the paniolo-wiki repo as
`design-paniolo-obsidian-plugin` and `plan-paniolo-obsidian-plugin`.

## Paniolo.ai

The plugin and `paniolo` CLI are free and run locally. Paniolo builds tools
for keeping knowledge produced with AI agents accurate and useful. Learn more
at [Paniolo.ai](https://paniolo.ai).
