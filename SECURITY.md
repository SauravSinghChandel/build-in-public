# Security policy

## Supported versions

Security fixes go into the `main` branch and the latest release. Older releases are not patched.

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue:

- Use GitHub's private reporting: the repository's **Security** tab → **Report a vulnerability**.
- Or email sauravca527@gmail.com with "Build in Public security" in the subject.

Include what you found, the steps to reproduce it, the version or commit, and your OS. You'll get an acknowledgement within 7 days. Once a fix is ready we'll agree on a disclosure date with you and credit you in the release notes unless you'd rather not be named.

## Scope

In scope: the BIP server and web UI, its handling of repositories, agent processes, compositions, captured pages, stored secrets, and publishing. Examples: bypassing the session cookie or `Host`/`Origin` checks, reading or writing files outside the allowed roots, getting an agent to run with a repository's hooks or MCP servers, script execution in the render origin that escapes its restrictions, leaking tokens, or publishing without a matching approval.

Out of scope: problems in Claude Code, Codex, Playwright, HyperFrames, FFmpeg or Git themselves (report those upstream), attacks that need code already running as your user, and the best-effort nature of the secret-pattern checks.

The threat model and mitigations are described in [docs/security.md](docs/security.md).
