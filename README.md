# Cyphant Pi Extensions

Custom Pi extensions packaged as a local/git-installable Pi package.

## Install locally

```bash
pi install /Users/fabianfreimuller/Development/Cyphant/pi-extensions
```

## Extensions

- `auto-compact` — automatic context compaction helper.
- `lsp` — LSP-backed diagnostics tool.
- `read-guard` — guards edits based on prior reads.
- `safety-gate` — reviews or blocks risky shell commands.

## Config

Committed `config.example.json` files are examples only. Live global config is currently read by some extensions from:

```text
~/.pi/agent/extensions/<extension-name>/config.json
```

Copy an example file there when needed, or use the extension's Pi commands if available to update global config.
