# Pi LSP Extension

Keeps configured language servers synchronized with successful `edit`/`write` tool results and caches diagnostics without injecting them after every edit.

## Defaults

- C# works out of the box with `csharp-ls` for `.cs` files.
- C# requires a discovered `.sln` or `.slnx`; the extension starts `csharp-ls` with `--solution <file>` from the solution directory.
- On-demand C# diagnostics fall back to `dotnet build <solution> --nologo` when `csharp-ls` exposes no diagnostics for the file.
- Dart/Flutter works with `dart language-server --protocol=lsp` for `.dart` files.
- Flutter projects are detected from `pubspec.yaml`; when detected, the extension prefers Flutter's bundled Dart SDK.
- Go works with `gopls serve` for `.go` files.
- Rust works with `rust-analyzer` for `.rs` files.
- TypeScript is included as a disabled example config.

## Commands

- `/lsp status` - show server, document, diagnostic, and warning state.
- `/lsp diagnostics [path]` - show cached diagnostics, optionally for one path.
- `/lsp restart` - stop all language servers; they restart lazily on the next matching file sync.
- `/lsp stop` - stop all language servers.
- `/lsp config` - show the active config path and config JSON.

## Tool

`lsp_diagnostics({ path?, severity? })` returns cached diagnostics. If `path` is provided, the file is synced first so diagnostics can be requested on demand.

## Diagnostic policy

- `edit`/`write` results sync documents into LSP.
- Diagnostics are cached and displayed in the status line.
- Diagnostics are not injected after every edit.
- Optional turn-end summaries are controlled by `diagnostics.turnEndSummary` in `config.json` (`off`, `errors-only`, or `all`).
