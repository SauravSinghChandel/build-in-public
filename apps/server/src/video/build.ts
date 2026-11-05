import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { VideoCompositionData } from "@bip/shared";
import { outputTime, speedRamp, zoomState, type EventLog } from "./model.js";
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
// IBM Plex Sans 600 advance widths (1/1000 em) for ASCII 32..126, measured from the bundled font.
const PLEX_SANS_600 = [
  236, 309, 471, 656, 600, 960, 713, 260, 337, 337, 556, 600, 299, 402, 299,
  437, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 319, 319, 600, 600,
  600, 493, 899, 672, 663, 642, 689, 600, 577, 712, 719, 423, 545, 678, 521,
  817, 719, 712, 641, 712, 664, 611, 580, 689, 638, 949, 655, 632, 599, 329,
  437, 329, 600, 559, 600, 559, 600, 513, 600, 558, 350, 545, 588, 275, 275,
  562, 294, 888, 588, 563, 600, 600, 393, 499, 374, 588, 524, 819, 544, 524,
  502, 363, 376, 363, 600,
];
/** Width of `text` in em for the title font (Plex Mono is a fixed 0.6 em). */
export function textEm(text: string, mono = false) {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    em += mono
      ? 0.6
      : code >= 32 && code < 127
        ? PLEX_SANS_600[code - 32] / 1000
        : 0.72;
  }
  return em * 1.03; // headroom for kerning and rounding
}
/**
 * Largest font size in vw (≤ base) at which every word fits within maxVw of the frame width
 * and the text wraps to at most `lines` lines. Deterministic: no layout measurement needed.
 */
export function fitTitle(
  text: string,
  { base = 7, maxVw = 90, lines = 3, mono = false } = {},
) {
  const words = text.split(/\s+/).filter(Boolean),
    space = textEm(" ", mono);
  for (let f = base; f > 1; f -= 0.25) {
    const limit = maxVw / f;
    let count = 1,
      line = 0,
      fits = true;
    for (const word of words) {
      const w = textEm(word, mono);
      if (w > limit) {
        fits = false;
        break;
      }
      if (line && line + space + w > limit) {
        count++;
        line = w;
      } else line = line ? line + space + w : w;
    }
    if (fits && count <= lines) return Math.round(f * 100) / 100;
  }
  return 1;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function generatedHtml(html: string) {
  const marker = /\n<!-- BIP-generated:([a-f0-9]{64}) -->$/.exec(html);
  return !!marker && digest(html.slice(0, -marker[0].length)) === marker[1];
}
export function patchCaptionHtml(
  html: string,
  captions: VideoCompositionData["captions"],
) {
  let result = html;
  for (const [i, caption] of captions.entries()) {
    const pattern = new RegExp(
      `<div\\b(?=[^>]*\\bid=["']caption-${i}["'])[^>]*>[\\s\\S]*?<\\/div>`,
      "i",
    );
    let found = false;
    result = result.replace(pattern, (element) => {
      found = true;
      let tag = element.slice(0, element.indexOf(">") + 1);
      for (const [attr, value] of [
        ["data-start", caption.startMs / 1000],
        ["data-duration", (caption.endMs - caption.startMs) / 1000],
      ] as const) {
        const re = new RegExp(`${attr}=["'][^"']*["']`, "i");
        tag = re.test(tag)
          ? tag.replace(re, `${attr}="${value}"`)
          : tag.replace(/>$/, ` ${attr}="${value}">`);
      }
      return tag + escape(caption.text) + "</div>";
    });
    if (!found)
      throw Error(
        `Caption ${i + 1} slot is missing from custom HTML; use an agent edit to repair it`,
      );
  }
  return result;
}
export async function buildHtml(
  dir: string,
  c: VideoCompositionData,
  logs: Map<string, EventLog>,
  width = 1920,
  height = 1080,
  dimensions = new Map<
    string,
    { width: number; height: number; hasAudio?: boolean }
  >(),
) {
  const html: string[] = [],
    animations: object[] = [];
  for (const [i, s] of c.scenes.entries()) {
    const start = s.startMs / 1000,
      dur = (s.endMs - s.startMs) / 1000,
      attrs = `class="clip" data-start="${start}" data-duration="${dur}" data-track-index="${i}"`;
    if (s.kind === "title" || s.kind === "outro") {
      // First line is the headline, the rest (e.g. the project website) is a subline.
      const [headline, ...rest] = (s.notes || c.title).split("\n"),
        sub = rest.join(" ").trim(),
        mono = c.style === "technical";
      const fit = fitTitle(headline, { mono }),
        tall = fitTitle(headline, { base: 10, lines: 4, mono });
      html.push(
        `<section id="scene-${i}" ${attrs}><div class="clip card"><h1 style="--fit:${fit}vw;--fit-tall:${tall}vw">${escape(headline)}</h1>${sub ? `<p>${escape(sub)}</p>` : ""}</div></section>`,
      );
      animations.push({
        id: `scene-${i}`,
        frames: [
          { opacity: 0, transform: "translateY(20px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        duration: Math.min(450, s.endMs - s.startMs),
        delay: s.startMs,
      });
    } else if (s.kind === "still") {
      html.push(
        `<section id="scene-${i}" ${attrs}>${s.sourceSha ? `<img id="still-${i}" class="still" src="assets/${s.sourceSha}">` : `<div class="clip card"><pre>${escape(s.notes || c.title)}</pre></div>`}${c.style === "technical" && s.sourceSha && s.notes ? `<div class="callout">${escape(s.notes)}</div>` : ""}</section>`,
      );
      animations.push({
        id: `scene-${i}`,
        frames: [{ opacity: 0 }, { opacity: 1 }],
        duration: Math.min(350, s.endMs - s.startMs),
        delay: s.startMs,
      });
      if (s.sourceSha)
        animations.push({
          id: `still-${i}`,
          frames: [
            { transform: "scale(1) translateX(-1%)" },
            { transform: "scale(1.08) translateX(1%)" },
          ],
          duration: s.endMs - s.startMs,
          delay: s.startMs,
        });
    } else {
      const log = logs.get(s.sourceSha!),
        ramp = log ? speedRamp(log.events) : undefined,
        parts = ramp
          ? [
              { a: 0, b: ramp.start, rate: 1, media: 0 },
              {
                a: ramp.start,
                b: outputTime(ramp.end, ramp),
                rate: 2,
                media: ramp.start,
              },
              {
                a: outputTime(ramp.end, ramp),
                b: dur,
                rate: 1,
                media: ramp.end,
              },
            ]
          : [{ a: 0, b: dur, rate: 1, media: 0 }];
      html.push(
        `<section id="scene-${i}" class="scene"><div class="viewport" style="--source-ratio:${log ? log.viewport.width / log.viewport.height : dimensions.has(s.sourceSha!) ? dimensions.get(s.sourceSha!)!.width / dimensions.get(s.sourceSha!)!.height : 1.6}"><div id="camera-${i}" class="camera">${parts
          .filter((p) => p.a < dur && p.b > p.a)
          .map(
            (p, j) =>
              `<video id="video-${i}-${j}" class="clip footage" src="assets/${s.sourceSha}" ${dimensions.get(s.sourceSha!)?.hasAudio ? 'data-has-audio="true"' : "muted"} data-start="${start + p.a}" data-duration="${Math.min(dur, p.b) - p.a}" data-media-start="${p.media}" data-playback-rate="${p.rate}" data-track-index="0"></video>`,
          )
          .join(
            "",
          )}${log ? `<svg id="cursor-${i}" class="cursor" viewBox="0 0 30 38"><path d="M2 2L2 30L10 23L17 36L23 33L16 20L28 20Z" fill="white" stroke="#15171c" stroke-width="2"/></svg><div id="ripple-${i}" class="ripple"></div>` : ""}</div></div></section>`,
      );
      // Timed wrapper avoids leaking cursor overlays across title/outro scenes; video is the sole timed media element.
      if (log) {
        const w = log.viewport.width,
          h = log.viewport.height,
          clicks = log.events
            .filter((e) => e.type === "click")
            .map((e) => ({ ...e, t: outputTime(e.t, ramp) }));
        const points = log.events
          .filter((e) => e.type === "pointermove" || e.type === "click")
          .map((e) => ({ ...e, t: outputTime(e.t, ramp) }));
        const frames = Array.from(
          { length: Math.max(2, Math.ceil(dur * 30) + 1) },
          (_, f) => {
            const t = Math.min(dur, f / 30),
              z = zoomState(t, clicks, w, h);
            return {
              offset: t / dur,
              transform: `translate(${(z.tx / w) * 100}%,${(z.ty / h) * 100}%) scale(${z.z})`,
            };
          },
        );
        animations.push({
          id: `camera-${i}`,
          frames,
          duration: dur * 1000,
          delay: s.startMs,
        });
        const cursorFrames = points.length
          ? points
              .map((p) => ({
                offset: Math.min(1, p.t / dur),
                left: `${(p.x / w) * 100}%`,
                top: `${(p.y / h) * 100}%`,
              }))
              .filter((p, j, a) => !j || p.offset >= a[j - 1].offset)
          : [{ left: "50%", top: "50%" }];
        animations.push({
          id: `cursor-${i}`,
          frames: cursorFrames,
          duration: dur * 1000,
          delay: s.startMs,
        });
        for (const click of clicks)
          animations.push({
            id: `ripple-${i}`,
            frames: [
              {
                opacity: 1,
                transform: "translate(-50%,-50%) scale(.1)",
                left: `${(click.x / w) * 100}%`,
                top: `${(click.y / h) * 100}%`,
              },
              {
                opacity: 0,
                transform: "translate(-50%,-50%) scale(2)",
                left: `${(click.x / w) * 100}%`,
                top: `${(click.y / h) * 100}%`,
              },
            ],
            duration: 450,
            delay: s.startMs + click.t * 1000,
            fill: "none",
          });
      }
      // CSS visibility is absolute root time and deterministic through the CSS adapter.
      animations.push({
        id: `scene-${i}`,
        frames: [{ visibility: "visible" }, { visibility: "visible" }],
        duration: dur * 1000,
        delay: s.startMs,
        fill: "none",
      });
    }
  }
  for (const [i, cap] of c.captions.entries())
    html.push(
      `<div id="caption-${i}" class="clip caption" style="top:auto" data-start="${cap.startMs / 1000}" data-duration="${(cap.endMs - cap.startMs) / 1000}" data-track-index="10">${escape(cap.text)}</div>`,
    );
  const script = `const animations=${JSON.stringify(animations).replace(/</g, "\\u003c")};for(const a of animations){const el=document.getElementById(a.id);const anim=el.animate(a.frames,{duration:a.duration,delay:a.delay,fill:a.fill||'both',easing:'linear'});anim.pause();anim.currentTime=0;}`;
  const output = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'"><link rel="stylesheet" href="styles.css"><style>.scene{visibility:hidden}.ripple{opacity:0}</style></head><body><main id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${c.durationMs / 1000}" data-fps="30" data-width="${width}" data-height="${height}">${html.join("\n")}</main><script>${script}</script></body></html>`;
  await fs.writeFile(
    path.join(dir, "index.html"),
    `${output}\n<!-- BIP-generated:${digest(output)} -->`,
  );
}
