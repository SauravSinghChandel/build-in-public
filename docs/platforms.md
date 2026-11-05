# Platforms

| Platform | Status |
|---|---|
| Linux (x86-64) | Supported. Developed and tested on Ubuntu with Node 22.22, Git, FFmpeg 8 and Playwright's Chromium. |
| macOS | Expected to work, untested. |
| Windows | Not supported. WSL 2 is untested. |

## Linux notes

- Install the requirements with your package manager, for example `sudo apt install git ffmpeg` (Debian/Ubuntu), `sudo dnf install git ffmpeg` (Fedora, with RPM Fusion enabled: BIP encodes with `libx264`, which Fedora's own `ffmpeg-free` lacks), or `sudo pacman -S git ffmpeg` (Arch). Node 22 or later can come from your distribution, nodejs.org, or a version manager.
- Chromium: `npx --yes pnpm@10.34.9 exec playwright install chromium`. If Chromium fails to start because system libraries are missing, `npx --yes pnpm@10.34.9 exec playwright install --with-deps chromium` installs them (it uses `sudo`).
- With Ubuntu's packaged Node, `corepack enable` fails with a permission error, so the docs use `npx --yes pnpm@10.34.9`.
- `bip start` opens the session URL with `xdg-open`. Set `BIP_NO_OPEN=1` on a headless machine and open the printed URL yourself.
- Secrets use the Secret Service (GNOME Keyring, KWallet) through `@napi-rs/keyring`. Without a running secret service (headless machines, some minimal desktops) BIP uses the encrypted file fallback described in [security.md](security.md).
- Scheduled posts while the app is closed use a systemd user timer ([scheduling.md](scheduling.md)).
- Video capture uses hardware WebGL (`--use-angle=gl`) when the GPU driver allows it and falls back to Chromium's software renderer otherwise; heavy pages may then record as "Choppy". `BIP_CAPTURE_GPU=0` forces the fallback.
- If Chromium crashes at start-up because its config directory is read-only (seen in sandboxed environments), set `XDG_CONFIG_HOME` to a writable folder.

## macOS: known differences

BIP uses POSIX process groups and signals, which macOS also has. These parts behave differently and have not been tested on a Mac:

- **Opening the browser:** `bip start` uses `open` on macOS instead of `xdg-open`.
- **Secrets:** `@napi-rs/keyring` stores tokens in the login keychain (visible in Keychain Access under `build-in-public`). macOS may ask you to allow access the first time.
- **Chromium path for video:** BIP uses Playwright's own executable path first, which works on macOS. Its fallback search of the Playwright cache only looks for Linux builds (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`). If HyperFrames can't find a browser, set `chromiumPath` in `config.json` or `HYPERFRAMES_BROWSER_PATH`.
- **Scheduling:** there is no systemd. Run `node /path/to/build-in-public/apps/server/dist/cli.js publish-due` every minute from a `launchd` agent instead, with no catch-up runs.
- **Paths:** data still goes to `~/.local/share/build-in-public` and config to `~/.config/build-in-public` (XDG layout, not `~/Library`), unless `XDG_DATA_HOME`, `XDG_CONFIG_HOME` or `BIP_HOME` are set.
- **Requirements:** `brew install node git ffmpeg`.
- **WebGL capture:** the GPU flags were measured on Linux only.

## Windows: why it isn't supported

- **Signals and process groups:** agent CLIs are started in their own process group (`detached: true`) and cancelled by signalling the group (`process.kill(-pid, …)`, SIGINT → SIGTERM → SIGKILL). Windows has no POSIX process groups or SIGINT delivery to child processes, so cancellation would leave agents running. (The helper that runs HyperFrames, FFmpeg and ffprobe already skips the group on `win32`; the agent harness does not.)
- **Paths:** the path allowlist, the `.bip/` store (symlink checks, atomic renames over existing files) and Git discovery have only been exercised with POSIX paths. Drive letters, UNC paths and case-insensitive comparisons are untested.
- **System tools:** backups call `tar`, and the docs assume `git`, `ffmpeg` and `ffprobe` on `PATH`; scheduling assumes systemd.
- **Browser opening:** `bip start` only knows `open` and `xdg-open`.

Contributions that make these work on Windows are welcome; keep platform checks in small helpers rather than spread through the code.
