import fs from 'node:fs/promises';
const m=JSON.parse(await fs.readFile('out/metrics.json','utf8')),h=m.engines.hyperframes,r=m.engines.remotion;
const sec=x=>x.wallSeconds.toFixed(1)+' s';const size=x=>(Number(x.format.size)/1e6).toFixed(2)+' MB';
const cd=m.capture, p=cd.playwright;
const hm=JSON.parse(await fs.readFile('out/hyperframes-repo-metadata.json','utf8')),rm=JSON.parse(await fs.readFile('out/remotion-repo-metadata.json','utf8'));
const hashes=x=>x.v2.frame150md5===x['v2-repeat'].frame150md5;
const rows=`GO-with-caveats — prefer HyperFrames for BIP, conditional on resolving the GSAP editor-license restriction; both engines delivered the demo and revision.

Measured 2026-11-04, Linux software rendering; same 13 s CDP source/events, 1920×1080, 30 fps, H.264, no audio; v1 16.8 s, v2 15.0 s.

| Acceptance check | Result | Evidence (paths relative to this folder) |
|---|---|---|
| Read-only portfolio copy; homepage, hover/click, scroll down/up | PASS | capture.mjs; out/capture/events.json: ${cd.events} events, 10 action stamps, 2 real nav clicks; source only copied to /tmp/bip-spike-video/site |
| Both recording methods; sharpness/frame comparison | PASS | PW native: 1440×900, 25 fps, ${(Number(p.format.bit_rate)/1e6).toFixed(3)} Mbps, ${size(p)}; CDP: 30 fps CFR, ${(Number(cd.cdp.format.bit_rate)/1e6).toFixed(3)} Mbps, ${size(cd.cdp)} |
| Effective capture rate/drop evidence | PASS | CDP ${cd.cdpDistinctFrames}/13=${cd.cdpEffectiveFps.toFixed(2)} delivered fps; p95/max gap ${(cd.cdpP95Gap*1000).toFixed(0)}/${(cd.cdpMaxGap*1000).toFixed(0)} ms. 390 CFR slots repeat source frames. PW mpdecimate retains 129/14.72=8.76 changed fps; CDP 97/13=7.46. Changed-frame counts are not ground-truth drops. |
| Pick better shared raw; hide real cursor | PASS | out/capture/raw.mp4 = CDP (crisper small text by still inspection); hides CSS cursor AND site's .cur overlay; native PW and normalized MP4 also retained |
| Intro/rounded frame/cursor/ripple/two captions/outro | PASS | Four named MP4s + contact sheets below; title 2.5→1.2 s, outro 2 s; overlays derived from events.json |
| Eased 1.6× click zooms + longest-scroll 2× | FAIL exact centering; other effects PASS | model.mjs: pre-roll .4 s, hold .35 s, return .5→.65 s; top-nav clicks are edge-clamped rather than vertically centered; 10.2–11.6 s source scroll becomes .7 s |
| Official projects and local skills/docs | PASS | hyperframes init --skip-skills --non-interactive; create-video --yes --blank --no-tailwind; official repository skill snapshots in skills/; package-lock.json pins installs |
| Lint/typecheck/runtime/frame inspection | PASS | out/hyperframes-check-v2.json, out/remotion-typecheck.log; native HF snapshot sheets + FFmpeg 4×4 sheets; warnings discussed below |
| Interactive preview | FAIL / PASS | HF background preview: stale server HTTP 500 after dependency cleanup, forced fresh server then connection-refused in this sandbox; stopped investigation. Remotion Studio HTTP 200, composition loaded without page errors (out/preview-check.json). |
| Same conversational revision; commits/diff locality | PASS (scratch adaptation) | out/*-revisions.bundle and *-revision.patch; scratch git repos only under /tmp/bip-spike-video/revisions; repo commit prohibition preserved |
| Render twice, compare decoded frame 150 | ${hashes(h)&&hashes(r)?'PASS':'FAIL'} | HF ${h.v2.frame150md5}; Remotion ${r.v2.frame150md5}; HF repeat ${h['v2-repeat'].frame150md5}; Remotion repeat ${r['v2-repeat'].frame150md5}; no claim of full-file determinism |
| Deliverable format, full decode, size limit | PASS | audit.mjs probes and fully decodes all 6 renders; all four deliverables <20 MB; out/metrics.json; .gitignore excludes node_modules and audited oversized generated paths |

| Score / observation | HyperFrames 0.9.13 | Remotion 4.0.540 |
|---|---|---|
| Visual quality (author assessment) | Clean, restrained; sharp at native source scale; zoom magnifies capture softness | Near equivalent framing/motion; same source softness; watch both before choosing |
| Spec coverage | Requested scenes/effects; 16.8 s v1; exact vertical click-centering not met | Same |
| Agent ergonomics / fix iterations | 1 structural fix (timed video + timed wrapper rejected); verbose generated GSAP keyframes; 1 shared v2 zoom-timing refinement | 0 composition fixes; direct React state/Sequence composition; same shared v2 timing refinement |
| Render wall time v1 / v2 / repeat | ${sec(h.v1)} / ${sec(h.v2)} / ${sec(h['v2-repeat'])} | ${sec(r.v1)} / ${sec(r.v2)} / ${sec(r['v2-repeat'])} |
| Local node_modules (du -sh) | ${h.installSize.split(/\s/)[0]} | ${r.installSize.split(/\s/)[0]} |
| Revision diff --stat | 2 files, 13 insertions / 13 deletions (settings + generated HTML) | 1 file, 3 insertions / 3 deletions (settings) |
| Determinism at frame 150 | ${hashes(h)?'Match':'Mismatch'}; decoded pixels only | ${hashes(r)?'Match':'Mismatch'}; mean RGB error ~0.47/255, 23.12% pixels differ (out/remotion-frame150-diff.json); cause not isolated |
| MIT/company fit | Apache-2.0 core; GSAP 3.15.0 has a separate restricted license; not a blanket MIT stack | Source available, not MIT/OSI; individual PoC free; larger for-profit companies generally need Company License |
| Maintenance signals (live snapshot) | ${hm.stargazers_count.toLocaleString()} stars; latest push ${hm.pushed_at}; pre-1.0 CLI | ${rm.stargazers_count.toLocaleString()} stars; latest push ${rm.pushed_at}; mature 4.x CLI and broad React docs |

Gotchas: Node 22.22.1 / FFmpeg 8.0.1; Playwright 1.61.0 expects browser 1228, so reused cached Chromium 1248 (Chrome 156.0.8078.4) via executablePath and installed its required ffmpeg-1011. chromiumSandbox:false plus XDG_CONFIG_HOME=/tmp/bip-spike-video/config fixed startup. HF uses HYPERFRAMES_BROWSER_PATH; both used two workers and CRF 22. Shared capture dependencies: 18M, excluded from engine sizes; cached browsers also excluded.
Capture needed one corrective recapture: Playwright hover stability delayed the first click to 6.35 s; the second capture retained readable project/experience holds. The hero still occupies too much of the demo. Capture timestamps, not planned action times, drive zooms. CDP is sharper here but its delivery rate is below 30; genuine dropped-frame counts cannot be established from event-driven screencast alone.
HF full check passes with warnings: inline title-card scene structure, 24 px decorative eyebrow, and short readable holds after intro revision/outro entrance. Kept for this identical two-engine brief. FFmpeg contact sheets and native HF snapshots were visually inspected; no audio was authored or auditioned. Host load and caches differ, so times are a local observation, not a general benchmark.
Revision stayed local in authored settings: intro 2.5→1.2, smootherstep zoom return .5→.65, outroAdvance 0→.5; generated HF timing/keyframes also change. No recording, event, caption, or layout edits in v2. The v2 zoom return was refined once to minimize overlap with the next click.
License sources: [HF Apache license](https://github.com/heygen-com/hyperframes/blob/main/LICENSE), [GSAP/Webflow terms](https://webflow.com/legal/product-terms), [Remotion installed-version terms](https://www.remotion.pro/terms-4-0), [Remotion license FAQ](https://www.remotion.dev/docs/license/faq). See out/license-notes.md. BIP's possible overlap with GSAP's no-code-builder restriction is an inference requiring clarification; an MIT wrapper does not erase dependency terms.
Recommendation: prototype Video Studio with pinned HyperFrames and event-driven timing; settle GSAP licensing or prove another supported runtime before distribution. Keep Remotion as an explicitly licensed fallback after resolving its hash failure. Record only after site readiness, use measured action timestamps, and add a capture-quality gate before spending render time.

Watch (paths under out/; sizes v1/v2): hyperframes-v1.mp4 (${size(h.v1)}), hyperframes-v2.mp4 (${size(h.v2)}), remotion-v1.mp4 (${size(r.v1)}), remotion-v2.mp4 (${size(r.v2)}), capture/raw.mp4 (${size(cd.cdp)}).
Contact sheets: out/hyperframes-v1-contact.png, out/hyperframes-v2-contact.png, out/remotion-v1-contact.png, out/remotion-v2-contact.png; out/hyperframes-contact.png and out/remotion-contact.png alias v2. out/*-v2-repeat.mp4 retain the determinism renders.

How to re-run (existing spike sources; no global installs):
\`\`\`bash
cd /home/justbuster/projects/build-in-public/spikes/video
npm ci
node rerun.mjs
\`\`\`
Individual final renders: \`node render.mjs hyperframes v2\` and \`node render.mjs remotion v2\`; inspection: \`cd hyperframes && npx hyperframes snapshot --at 0.8,4,7.5,9,13.5 --output ../out/hyperframes-v2-snapshots\`. Re-run audit/report with \`node audit.mjs && node report.mjs\`.
`;
await fs.writeFile('RESULT.md',rows);console.log('RESULT lines:',rows.split('\n').length);
