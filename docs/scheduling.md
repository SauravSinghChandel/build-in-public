# Scheduling posts

Scheduling needs a connected account (Settings → Accounts) and an approved post.
"Schedule…" in the publish sheet stores `status: scheduled` and `scheduledAt` on the
post. Editing the text or media clears approval **and** unschedules it.

## While the app is running

The server checks every 30 seconds and enqueues a publish job for each scheduled post
that is due. Each job re-checks that the approved revision is still the current one
right before calling the platform API.

A post more than **2 minutes** past its time (for example because Build in Public was
closed) is shown as **Overdue** in Content → Scheduled and in the story editor. Overdue
posts are never posted automatically: choose **Post now** or **Reschedule**.

## While the app is closed (optional)

`bip publish-due` runs one scheduler pass and exits. If the app is already running it
does nothing (the running app owns scheduling). Run it every minute with a systemd user
timer so posts stay within the 2-minute window:

`~/.config/systemd/user/bip-publish-due.service`

```ini
[Unit]
Description=Build in Public: publish due scheduled posts

[Service]
Type=oneshot
# Use the absolute path of your checkout (or of a globally linked `bip`).
ExecStart=/usr/bin/node /path/to/build-in-public/apps/server/dist/cli.js publish-due
# Optional: match the app's environment if you customised it.
# Environment=BIP_HOME=/path/to/data
```

`~/.config/systemd/user/bip-publish-due.timer`

```ini
[Unit]
Description=Run bip publish-due every minute

[Timer]
OnCalendar=*-*-* *:*:00
AccuracySec=5s
Persistent=false

[Install]
WantedBy=timers.target
```

Enable it with:

```sh
systemctl --user daemon-reload
systemctl --user enable --now bip-publish-due.timer
systemctl --user list-timers bip-publish-due.timer
journalctl --user -u bip-publish-due.service   # one line per post, never tokens
```

`Persistent=false` matters: after the machine was off, systemd must not run a catch-up
pass, and even if it did, posts more than 2 minutes late stay Overdue.

Tokens are read from the same keychain (or encrypted fallback file) as the app. On a
headless machine without a running secret service the keychain is unavailable to the
timer, so the encrypted file fallback is used there; connect accounts from an app
started in the same environment.

Exit status is non-zero when any due post failed; the error is also shown on the post.
