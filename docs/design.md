# Design spec (v1)

Build in Public is a tool for one job: noticing work you haven't talked about yet and turning it into posts. The UI is a quiet graphite workspace. The one thing that carries colour and attention is **unshared work**.

## Signature element: the unshared rail

On a project's Overview, commits are listed newest first along a thin vertical rail. Commits made since your last post sit on a lit amber section of the rail; a horizontal marker labelled "Last shared · <date>" separates them from older, already-shared work, which sits on a dim grey rail. Selecting commits (checkbox per row, shift-click for ranges) highlights their dots, and the action bar offers "Create story from 3 commits".

The same amber appears in exactly three other places: the unshared count on the Projects list, the primary button, and the focus ring. Nowhere else.

## Colour tokens (CSS variables; Tailwind v4 `@theme`)

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--bg` | `#15171C` | `#F6F7F9` | app background |
| `--surface` | `#1B1E25` | `#FFFFFF` | panels, rail, editor |
| `--raised` | `#232731` | `#EEF0F3` | hover rows, popovers, inputs |
| `--line` | `#2B303B` | `#DDE1E7` | 1px borders and dividers |
| `--text` | `#E4E7EC` | `#1A1D23` | primary text |
| `--muted` | `#8A91A0` | `#5F6675` | secondary text, timestamps |
| `--signal` | `#E8B04B` | `#B7801A` | unshared work, primary action, focus |
| `--signal-ink` | `#1A1405` | `#FFFFFF` | text on signal |
| `--ok` | `#6FB7A8` | `#2F7F70` | published |
| `--danger` | `#E07070` | `#B8403F` | errors, destructive |

Light mode exists (via `prefers-color-scheme` + a manual toggle) but dark is the default. Contrast: every text/background pair is ≥ 4.5:1, and `--muted` on `--surface` is ≥ 4.5:1.

## Type

- **IBM Plex Sans** (400/500/600) for all UI text. **IBM Plex Mono** (400) only for literal code values: commit SHAs, branch names, file paths. Self-host via `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (no network fonts).
- Scale (px / line-height): 12/16 meta · 13/18 secondary · **14/20 body (base)** · 16/24 section heading · 20/28 page title · 28/34 empty-state headline.
- Sentence case everywhere. No all-caps labels, no letter-spaced eyebrows, and no arrows appended to buttons.
- Numbers in lists use `font-variant-numeric: tabular-nums`.

## Shape, depth, motion

- Radii: 4px for chips, 6px for buttons and inputs, 10px for panels and dialogs. List rows are square (they're rows, not cards).
- No drop shadows except popovers and dialogs (`0 8px 24px rgb(0 0 0 / .35)` in dark mode). Separation comes from `--line` and `--surface` vs `--bg`.
- Spacing on a 4px grid. Page padding 24px (16px under 640px).
- Motion: 140 ms ease-out, only in response to user actions (open, expand, select, confirm). One ambient moment: the amber rail segment draws downward over 400 ms on first load of an Overview. All motion is disabled under `prefers-reduced-motion`.
- Focus: 2px `--signal` outline with a 2px offset on every interactive element.

## App frame

```
┌────────────┬───────────────────────────────────────────────────────────┐
│ Build in   │  Page title                         [secondary] [primary] │
│ Public     ├───────────────────────────────────────────────────────────┤
│            │                                                           │
│ Projects   │  content                                                  │
│ Content    │                                                           │
│ Settings   │                                                           │
│            │                                                           │
│ ⌘K Search  │                                                           │
└────────────┴───────────────────────────────────────────────────────────┘
```
- Left rail: 216px wide, collapsible to 56px (icons only, tooltips). Below 900px the rail becomes a top bar with a menu.
- Icons: `lucide-react`, 16px, stroke 1.75.
- `⌘K` / `Ctrl+K` opens the command palette (shadcn `Command`): jump to project, add folder, rescan, new story.

## Screens (M1)

### Projects (home)
A list, not a card grid. Sorted by unshared commits (most first); a sort menu offers Name and Recent activity.
```
Projects                                        [Rescan] [Add projects]
┌──────────────────────────────────────────────────────────────────────┐
│ portfolio            main      ● 12 unshared   Last post 3 weeks ago │
│ ~/projects/portfolio                                                  │
├──────────────────────────────────────────────────────────────────────┤
│ simulation-pipeline  feat/gpu  ● 4 unshared    No posts yet           │
│ ...                                                                   │
└──────────────────────────────────────────────────────────────────────┘
```
- Row: name (14/500), path below it (12, muted, mono), branch (mono chip), unshared count (amber dot + number; grey "Up to date" when 0), last post (muted, relative time; absolute time on hover).
- A missing project gets a row in danger tone: "Folder not found" with "Locate…" and "Stop tracking" actions.
- Empty state: headline "Add the folder where your projects live", body "Build in Public finds the Git repositories inside it. You choose which ones to track.", and a primary "Add folder" button.

### Add projects (dialog, two steps)
1. Choose a folder: a path input with server-side autocomplete (directory listing under `$HOME`), plus a "Scan depth" select (1–3, default 2). Primary button: "Find repositories".
2. Pick repositories: a checklist of discovered repos (name, path, branch, last commit relative time); already-tracked repos appear checked and disabled. A "Select all" toggle. Primary button: "Track 5 projects". Secondary tab: "Add a single repository" (path input).

### Project workspace
Header: project name (20/600), path (mono, muted, with a copy button), branch chip, "Open folder" (copies the path in M1). Tabs (underline style; the active tab gets a 2px `--text` underline, not amber): Overview, Stories, Media, Context, Settings. In M1, Stories and Media are empty states that say what's coming ("Stories arrive in the next update: you'll turn commits into X and LinkedIn drafts here.").

**Overview:** two columns ≥ 1100px (timeline 1fr, sidebar 320px); stacked below.
- Timeline grouped by day ("Today", "Yesterday", "Mon 2 Nov"). Commit row: checkbox, subject (14), short SHA (mono, muted), author when it isn't you, `+120 −30` diffstat (tabular, muted), files changed count. Click a row to expand the full message + file list.
- The unshared rail and the "Last shared" marker as described above. If the project has never been shared: "Nothing shared yet. Everything below is new." Marker control: "Mark everything up to here as shared" from a row's menu (sets `lastSharedCommit`).
- Paging: 50 commits, then "Show older".
- Sidebar: "About this project" (first lines of `context.md`, or a prompt to write it), "Active stories" (empty in M1), "Last post" (empty in M1).

**Context:** two editors side by side ≥ 1100px, stacked below: "Shareable notes" (`context.md`) and "Private notes" (`private.md`, with the helper text "Never included in posts. Agents use it only to know what to avoid."). Plain textarea with Markdown monospaced, autosave after 800 ms idle with a quiet "Saved" status. Below: a "Commit context.md to this repository" switch with an explanation, and the `.bip` folder size plus a "Back up now" button.

**Settings (project):** display name, scan options, "Locate folder" (relink), "Stop tracking" (untracks; leaves `.bip/`), and "Delete Build in Public data" (removes `.bip/` after typing the project name to confirm).

### Settings (app)
Sections in a left sub-nav: Folders (tracked parent folders, depth, remove), Agents (status of `claude` and `codex`: installed version, signed in or not, with fix hints such as "Run `claude` once in a terminal to sign in"), Appearance (Dark / Light / System), Storage (app data path, backups list), About (version, licenses link).

## Writing rules
- Plain verbs, sentence case, and the same name for an action through the whole flow ("Track 5 projects" → toast "Tracking 5 projects").
- Errors say what happened and what to do: "Couldn't read ~/projects/foo: permission denied. Check the folder's permissions, then rescan."
- No exclamation marks, no "Oops".
