# Drafts for review

## claude-draft

Timing: 34548 ms; validation: {"valid":true,"xLengths":[254,257,230],"linkedinLength":1028,"hashtagCounts":[0,0,0,0],"hook":true,"schema":{"valid":true,"errors":[]}}

X 1:
1/3 Landed a portfolio rebuild late one night. First I committed the old "Observatory" version so it lives in history, then replaced it with a new "Cosmos" design. Out went the lab experiments, the project/research pages and most of a 6k-line stylesheet.

X 2:
2/3 What's in: a WebGL black hole hero with a 2D fallback, scroll-driven warp jumps between sections, a "mission control" terminal, an aim-check mini-game and a hidden easter egg. There's also /simple, a plain résumé page for people who just want the facts.

X 3:
3/3 The follow-up commits were small: Cloudflare Workers static-assets config, a heading font swap from Syne to Archivo, résumé and thesis links pointed at GitHub instead of PDFs bundled in the repo, and Fibly pulled off the site.

LinkedIn:
I committed my old portfolio right before replacing most of it.

The previous version, "Observatory", had a lab section with small simulations (orbits, pathfinding, a vector field, a dungeon generator) plus project and research pages. I added it to the repo as its own commit. About 15 minutes later I landed a rebuild based on a Claude Design canvas called "Cosmos".

The new home page has a WebGL black hole hero with a 2D fallback, scroll-driven warp jumps between sections, projects shown in orbit, a terminal with its own commands, an aim-check mini-game and an easter egg. If you just want the facts, there's /simple, a plain résumé page.

The rest of the session was small stuff: Cloudflare Workers config for the static export, a heading font swap from Syne to Archivo, résumé and thesis links on GitHub instead of PDFs in the repo, and removing an old project (Fibly) from the site.

The stack is Next.js with a static export, strict TypeScript and plain CSS, with Vitest for the logic and Playwright for browser tests.

Highlights: ["602435b: committed the previous \"Observatory\" site (lab simulations, project/research pages, tests) as a baseline","f520517: rebuilt the portfolio from the Cosmos design: black hole renderer/shader, warp gates, terminal, audio, aim-check, /simple résumé page; removed Observatory pages and components","bb7f683: linked the thesis to the honoursthesis GitHub repo and removed the bundled PDF","c1bb84b: added Cloudflare deployment config (wrangler.jsonc) and deploy instructions","54d8361: switched the heading font from Syne to Archivo","0bf80ab: linked the résumé on GitHub (removed the PDF) and refreshed work descriptions","2646d99: removed Fibly from the site"]

Claims to verify: ["The black hole hero is actually WebGL with a working 2D fallback. This comes from the README; the commits only show black-hole.ts and black-hole-shader.ts.","The Observatory commit (602435b) is an older version imported as history, not new work from that night. The subject says 'previous version', but the code may predate the commit.","Most of the ~6k-line globals.css was cut in f520517. The stat shows heavy deletions, but the exact net size isn't confirmed.","The site is live on Cloudflare. c1bb84b only adds the config, so the posts avoid saying it's deployed.","Fibly is a past project of yours; the commit only says it was removed from the site.","'Cosmos' is the right name for the Claude Design canvas. The README calls the canvas 'sauravsinghchandel.com — revamp' and uses 'Cosmos mode' for the page."]

Verbatim structured output:

```json
{
  "x": {
    "parts": [
      "1/3 Landed a portfolio rebuild late one night. First I committed the old \"Observatory\" version so it lives in history, then replaced it with a new \"Cosmos\" design. Out went the lab experiments, the project/research pages and most of a 6k-line stylesheet.",
      "2/3 What's in: a WebGL black hole hero with a 2D fallback, scroll-driven warp jumps between sections, a \"mission control\" terminal, an aim-check mini-game and a hidden easter egg. There's also /simple, a plain résumé page for people who just want the facts.",
      "3/3 The follow-up commits were small: Cloudflare Workers static-assets config, a heading font swap from Syne to Archivo, résumé and thesis links pointed at GitHub instead of PDFs bundled in the repo, and Fibly pulled off the site."
    ]
  },
  "linkedin": {
    "text": "I committed my old portfolio right before replacing most of it.\n\nThe previous version, \"Observatory\", had a lab section with small simulations (orbits, pathfinding, a vector field, a dungeon generator) plus project and research pages. I added it to the repo as its own commit. About 15 minutes later I landed a rebuild based on a Claude Design canvas called \"Cosmos\".\n\nThe new home page has a WebGL black hole hero with a 2D fallback, scroll-driven warp jumps between sections, projects shown in orbit, a terminal with its own commands, an aim-check mini-game and an easter egg. If you just want the facts, there's /simple, a plain résumé page.\n\nThe rest of the session was small stuff: Cloudflare Workers config for the static export, a heading font swap from Syne to Archivo, résumé and thesis links on GitHub instead of PDFs in the repo, and removing an old project (Fibly) from the site.\n\nThe stack is Next.js with a static export, strict TypeScript and plain CSS, with Vitest for the logic and Playwright for browser tests."
  },
  "highlights": [
    "602435b: committed the previous \"Observatory\" site (lab simulations, project/research pages, tests) as a baseline",
    "f520517: rebuilt the portfolio from the Cosmos design: black hole renderer/shader, warp gates, terminal, audio, aim-check, /simple résumé page; removed Observatory pages and components",
    "bb7f683: linked the thesis to the honoursthesis GitHub repo and removed the bundled PDF",
    "c1bb84b: added Cloudflare deployment config (wrangler.jsonc) and deploy instructions",
    "54d8361: switched the heading font from Syne to Archivo",
    "0bf80ab: linked the résumé on GitHub (removed the PDF) and refreshed work descriptions",
    "2646d99: removed Fibly from the site"
  ],
  "claims_to_verify": [
    "The black hole hero is actually WebGL with a working 2D fallback. This comes from the README; the commits only show black-hole.ts and black-hole-shader.ts.",
    "The Observatory commit (602435b) is an older version imported as history, not new work from that night. The subject says 'previous version', but the code may predate the commit.",
    "Most of the ~6k-line globals.css was cut in f520517. The stat shows heavy deletions, but the exact net size isn't confirmed.",
    "The site is live on Cloudflare. c1bb84b only adds the config, so the posts avoid saying it's deployed.",
    "Fibly is a past project of yours; the commit only says it was removed from the site.",
    "'Cosmos' is the right name for the Claude Design canvas. The README calls the canvas 'sauravsinghchandel.com — revamp' and uses 'Cosmos mode' for the page."
  ]
}
```

## codex-draft

Timing: 58423 ms; validation: {"valid":true,"xLengths":[269],"linkedinLength":993,"hashtagCounts":[0,0],"hook":true,"schema":{"valid":true,"errors":[]}}

X 1:
Over Nov 1–2, I rebuilt my portfolio from the older Observatory structure into a Cosmos-focused site, added Cloudflare deployment config, switched the heading font to Archivo, linked thesis/resume to GitHub, and removed Fibly. The commits show the edit; not deployment.

LinkedIn:
A portfolio rebuild is mostly an editing exercise.
I started from the earlier Observatory version of my portfolio and rebuilt it around the Cosmos design. The old version had separate project, research, contact, and lab routes. The rebuild removes that structure and adds a Cosmos page alongside a simpler résumé mode.

The next commits were small but practical: I added Cloudflare deployment configuration, changed the heading font from Syne to Archivo, linked the thesis to its GitHub repository, and linked the résumé on GitHub. I also refreshed several work descriptions.

One decision I like is the one that looks least additive: removing Fibly from the site. That keeps the portfolio closer to what I want to present now, instead of treating every previous entry as permanent.

The history is compact—most of the work landed between November 1 and 2. I’m describing the repository changes here, not claiming a live deployment or runtime behavior that the commit records do not establish.

Highlights: ["602435b — Added the earlier Observatory portfolio version.","f520517 — Rebuilt the portfolio around the Cosmos design.","bb7f683 — Linked the thesis to its GitHub repository.","c1bb84b — Added Cloudflare deployment configuration.","54d8361 — Switched the heading font from Syne to Archivo.","0bf80ab — Linked the résumé on GitHub and refreshed work descriptions.","2646d99 — Removed Fibly from the site."]

Claims to verify: ["Whether the current site builds, passes browser tests, or is live on Cloudflare is not established by the supplied commit history."]

Verbatim structured output:

```json
{
  "x": {
    "parts": [
      "Over Nov 1–2, I rebuilt my portfolio from the older Observatory structure into a Cosmos-focused site, added Cloudflare deployment config, switched the heading font to Archivo, linked thesis/resume to GitHub, and removed Fibly. The commits show the edit; not deployment."
    ]
  },
  "linkedin": {
    "text": "A portfolio rebuild is mostly an editing exercise.\nI started from the earlier Observatory version of my portfolio and rebuilt it around the Cosmos design. The old version had separate project, research, contact, and lab routes. The rebuild removes that structure and adds a Cosmos page alongside a simpler résumé mode.\n\nThe next commits were small but practical: I added Cloudflare deployment configuration, changed the heading font from Syne to Archivo, linked the thesis to its GitHub repository, and linked the résumé on GitHub. I also refreshed several work descriptions.\n\nOne decision I like is the one that looks least additive: removing Fibly from the site. That keeps the portfolio closer to what I want to present now, instead of treating every previous entry as permanent.\n\nThe history is compact—most of the work landed between November 1 and 2. I’m describing the repository changes here, not claiming a live deployment or runtime behavior that the commit records do not establish."
  },
  "highlights": [
    "602435b — Added the earlier Observatory portfolio version.",
    "f520517 — Rebuilt the portfolio around the Cosmos design.",
    "bb7f683 — Linked the thesis to its GitHub repository.",
    "c1bb84b — Added Cloudflare deployment configuration.",
    "54d8361 — Switched the heading font from Syne to Archivo.",
    "0bf80ab — Linked the résumé on GitHub and refreshed work descriptions.",
    "2646d99 — Removed Fibly from the site."
  ],
  "claims_to_verify": [
    "Whether the current site builds, passes browser tests, or is live on Cloudflare is not established by the supplied commit history."
  ]
}
```

## claude-rewrite

Timing: 13557 ms; validation: {"valid":true,"xLengths":[266,267,239],"linkedinLength":null,"hashtagCounts":[0,0,0],"hook":true,"schema":{"valid":true,"errors":[]}}

X 1:
1/3 Rebuilt my portfolio the other night. Before tearing anything out, I committed the old "Observatory" version as-is so it lives in git history. Then I swapped in the new "Cosmos" design and deleted the lab sims, the project pages and most of a 6k-line stylesheet.

X 2:
2/3 The new home page is the fun part: a WebGL black hole hero (with a 2D fallback), warp jumps between sections as you scroll, a little terminal, an aim-check mini-game and an easter egg. I also added /simple, a plain résumé page for anyone who just wants the facts.

X 3:
3/3 The rest of the night was small cleanup: Cloudflare Workers config, swapping the heading font from Syne to Archivo, and pointing the résumé and thesis links at GitHub instead of keeping PDFs in the repo. I also took Fibly off the site.

Verbatim structured output:

```json
{
  "x": {
    "parts": [
      "1/3 Rebuilt my portfolio the other night. Before tearing anything out, I committed the old \"Observatory\" version as-is so it lives in git history. Then I swapped in the new \"Cosmos\" design and deleted the lab sims, the project pages and most of a 6k-line stylesheet.",
      "2/3 The new home page is the fun part: a WebGL black hole hero (with a 2D fallback), warp jumps between sections as you scroll, a little terminal, an aim-check mini-game and an easter egg. I also added /simple, a plain résumé page for anyone who just wants the facts.",
      "3/3 The rest of the night was small cleanup: Cloudflare Workers config, swapping the heading font from Syne to Archivo, and pointing the résumé and thesis links at GitHub instead of keeping PDFs in the repo. I also took Fibly off the site."
    ]
  }
}
```

