# md-live-viewer

A local, browser-based markdown viewer that **updates as the file changes** — no manual refresh. Run it in any folder:

[![npm Package Version](https://img.shields.io/npm/v/md-live-viewer)](https://www.npmjs.com/package/md-live-viewer)

```bash
npx md-live-viewer
```

It serves the **current directory**, opens a browser tab, and re-renders the open file whenever it is written by anything — another editor, a script, or an **AI coding agent** editing files in the background.

## Installation

Run it directly with `npx` (no install):

```bash
npx md-live-viewer
```

Or install it globally:

```bash
npm install -g md-live-viewer
```

This puts these equivalent commands on your `PATH` (the examples below use `md-view`):

```
md-view
md-live-viewer
```

You can also install `md-live-viewer` with [pnpm](https://pnpm.io/), [yarn](https://yarnpkg.com/), or [slnpm](https://github.com/beenotung/slnpm).

## Why

Cursor's markdown preview does not always pick up changes written by an external process (e.g. an AI agent) without toggling between preview and source. This viewer watches the file itself, so any write shows up instantly.

## Features

- **Live updates** — watches the tree with `fs.watch` plus a periodic mtime scan (a safety net that also catches atomic saves `fs.watch` can miss) and pushes changes over Server-Sent Events; the open file re-renders in place.
- **Recently changed** — after a live update, changed blocks get a green tint that fades over ~20 s. The clock pauses while the tab is hidden, so you don't miss edits made while away, and a block is also cleared after a few further updates so bursts don't pile up.
- **Cursor-style file switcher** — press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>P</kbd> to search markdown files by name or path. The search is fuzzy and tolerates typos (subsequences, one missing/extra char, and swapped adjacent characters) — e.g. `chng` finds `changelog.md`.
  - **Combine a folder word with a file word** using spaces, e.g. `docs config` — each token must match a path segment, which disambiguates files with the same name in different folders.
  - Opening with an **empty** box shows a **Recent** section (recently opened files) above **All files**.
  - A **view toggle** (top-right of the palette) switches between the flat searchable **List** (default) and a **Tree** of the folder structure. Tree mode auto-opens at the folder of the current file and highlights its siblings, so nearby files are quick to find. Click a folder to expand/collapse; typing still does a flat search. The choice is remembered.
  - **Hover**, `↑`/`↓`, and scrolling all move the same selection (the one `Enter` opens), so keyboard and mouse stay in sync.
  - Each row has a **⧉** button (copy the absolute path without opening); rows under **Recent** also have a **✕** to drop them from the list.
- **Bookmarkable, shareable links** — the open file is kept in the URL hash (`#file=path/to/file.md`), so you can bookmark it, copy the address, or open it in another browser. The 🔗 button copies the full link; the 📋 button copies the absolute filesystem path. Slashes stay literal (`/`) so links stay readable; `%2F` links still work.
- **Scoped by design** — the server serves exactly the folder you launch it with (the argument, defaulting to the current directory) and **cannot be re-pointed from the UI or a URL**. File access is further confined to that tree, including a realpath check that rejects symlinks pointing outside it.
- **In-preview navigation** — links to other markdown files open inside the viewer; images and other files are served through it too.
- **Drag & drop** — drop a `.md` file onto the window to open it (an overlay appears while dragging). Browsers hide a dropped file's path, so it's matched by name against the served folder; when several files share the name, **size and mtime** (`File.lastModified`) pick the right one. A unique match opens the real (live-watched) file; otherwise it's shown as a static, read-only preview, or the palette opens to choose.
- **Full markdown rendering** — GitHub Flavored Markdown (tables, task lists, strikethrough) via `micromark`.
- **Math** — `$inline$` and `$$block$$` via KaTeX (with currency-safe parsing, so `HK$528K` is not treated as math).
- **Mermaid diagrams** — ` ```mermaid ` blocks render to SVG.
- **Syntax highlighting** — fenced code blocks are highlighted with [Prism](https://prismjs.com/) (JS/TS/JSX/TSX, JSON, YAML, bash, Python, Markdown, SQL, Go, Rust, CSS), with light/dark token themes.
- **Relative images/links** — resolved against the markdown file's folder and served through the viewer.
- **Light / dark theme** — click the theme button in the header to cycle **system → light → dark**. The choice is remembered per browser; the default follows your OS setting.
- **Copy the raw Markdown** — click the 📄 button to copy the open file's source.
- **Copy the absolute path** — click the 📋 button to copy the open file's full path to the clipboard (handy for pasting into a terminal or another tool).
- **Copy the link** — click the 🔗 button to copy a URL that reopens the same file (works across browsers).
- **Save as PDF** — click the 🖨 button to open the browser's print dialog and save the rendered page as a PDF (no app chrome, and the PDF's metadata title is set to the file name).
- Zero runtime dependencies on the server; the client bundle is prebuilt, so `npx` just works.

## Usage

```bash
md-view [options] [dir]
```

Options and the optional `[dir]` may appear in any order.

### Options

| Option | Description |
| --- | --- |
| `[dir]` | Folder to serve. Defaults to the current directory. |
| `-p, --port <n>` | Port (default `8137`; use `0` for a random free port). |
| `--host <h>` | Host to bind (default `localhost`). |
| `--open` / `--no-open` | Open the browser automatically (default on). |
| `--all` | List all files, not only markdown. |
| `-h, --help` | Show help. |

Long options accept both `--port 8200` and `--port=8200`.

### Examples

```bash
# serve the repo you are in
cd ~/workspace/github.com/me/project && md-view

# serve your notes on a fixed port, without opening a browser
md-view --port 8200 --no-open ~/notes
```

> With `npm start`, put script flags after `--`: `npm start -- --port 8200` (without `--`, npm consumes `--port` as its own config).

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl`/`Cmd` + `P` | Open the fuzzy file switcher |
| `↑` / `↓` | Move the selection |
| `Enter` | Open the selected file |
| `Esc` | Close the switcher |
| `Ctrl`/`Cmd` + `R` | Force re-read the current file |

The open file lives in the URL as `#file=<path>`, so a bookmark or a copied address reopens exactly that file — including in another browser.

The served folder is fixed when you launch the server. To view a different folder, stop it and start again with that folder as the argument, e.g. `md-view ~/notes`.

## How it works

- The Node server (`src/server/`) lists files, serves them, and watches the root with `fs.watch({ recursive: true })` **plus** a periodic mtime scan as a safety net (which also catches atomic saves — temp file + rename — that `fs.watch` alone can miss). Change events are debounced and broadcast over SSE at `/api/events`.
- The browser client (`src/client/`) fetches the file, renders it, and re-fetches only the currently open file when its path changes.
- Edits are **view-only by design** — the viewer never writes to your files, so it is safe to leave open next to an agent that is editing the same folder. Safe concurrent *editing* was considered and deliberately left out: a WYSIWYG preview re-serializes the whole file on save (the converter normalizes tables/spacing), so a 1-word edit becomes a whole-file diff and cannot be auto-merged with the agent's whole-file writes without conflicts. Editing in Cursor and keeping this as a live viewer avoids that entirely.

## HTTP API

| Endpoint | Description |
| --- | --- |
| `GET /api/files` | List markdown files (relative paths) and the served root. |
| `GET /api/search?q=&limit=` | Fuzzy-ranked file search (supports space-separated tokens). |
| `GET /api/file?path=` | Read one file (JSON, `content` field). |
| `GET /api/stat?path=` | File `size` and `mtimeMs` (used to disambiguate a dropped file). |
| `GET /raw/<path>` | Serve a file raw (images, attachments). |
| `GET /api/events` | Server-Sent Events stream of file changes. |

All file endpoints reject paths that escape the served root, including through symlinks. There is no endpoint that changes the served folder or writes files.

## License

This project is licensed with [BSD-2-Clause](./LICENSE)

This is free, libre, and open-source software. It comes down to four essential freedoms [[ref]](https://seirdy.one/2021/01/27/whatsapp-and-the-domestication-of-users.html#fnref:2):

- The freedom to run the program as you wish, for any purpose
- The freedom to study how the program works, and change it so it does your computing as you wish
- The freedom to redistribute copies so you can help others
- The freedom to distribute copies of your modified versions to others

Markdown rendering logic is adapted from [html-markdown-editor](https://github.com/beenotung/html-markdown-editor) (same author, same license) for consistent output.
