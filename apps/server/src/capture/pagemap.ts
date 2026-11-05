import type { Page } from "playwright";
import type { PageElement, StepCheck } from "@bip/shared";

interface RawElement {
  role: string;
  name: string;
  text: string;
  href: string;
  id: string;
  testId: string;
  tag: string;
  nameAttr: string;
}
const quote = (v: string) => JSON.stringify(v);
const MAX_LABEL = 80;

/** Collects visible interactive elements and headings, with an approximate accessible name. */
function collect(): RawElement[] {
  const query =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="radio"],[role="option"],[role="combobox"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"]),h1,h2,h3';
  const clean = (v: string | null | undefined) =>
    (v || "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) > 0 &&
      !el.closest('[aria-hidden="true"],[inert]')
    );
  };
  const implicitRole = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "select")
      return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type))
        return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      if (["email", "tel", "text", "url", ""].includes(type)) return "textbox";
      if (type === "number") return "spinbutton";
      return "";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return "";
  };
  const nameOf = (el: Element, role: string) => {
    const label = clean(el.getAttribute("aria-label"));
    if (label) return label;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = clean(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" "),
      );
      if (text) return text;
    }
    const tag = el.tagName.toLowerCase();
    if (["input", "select", "textarea"].includes(tag)) {
      const input = el as HTMLInputElement;
      if (["button", "submit", "reset"].includes(input.type))
        return clean(input.value) || clean(input.type);
      const fromLabel = clean(
        [...(input.labels || [])].map((l) => l.textContent).join(" "),
      );
      return (
        fromLabel ||
        clean(el.getAttribute("title")) ||
        clean(el.getAttribute("placeholder"))
      );
    }
    if (
      ["link", "button", "heading", "tab", "menuitem", "option"].includes(role)
    ) {
      const text = clean((el as HTMLElement).innerText || el.textContent);
      if (text) return text;
      const img = el.querySelector("img[alt],svg[aria-label]");
      const alt = clean(
        img?.getAttribute("alt") || img?.getAttribute("aria-label"),
      );
      if (alt) return alt;
    }
    return clean(el.getAttribute("title"));
  };
  const seen = new Set<Element>();
  const out: RawElement[] = [];
  for (const el of document.querySelectorAll(query)) {
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const role =
      clean(el.getAttribute("role")).split(" ")[0] || implicitRole(el);
    out.push({
      role,
      name: nameOf(el, role),
      text: clean((el as HTMLElement).innerText || "").slice(0, 200),
      href: el.getAttribute("href") || "",
      id: el.id,
      testId: el.getAttribute("data-testid") || "",
      tag: el.tagName.toLowerCase(),
      nameAttr: el.getAttribute("name") || "",
    });
    if (out.length >= 400) break;
  }
  return out;
}

/** Selector candidates for one element, most robust first. */
export function selectorCandidates(e: RawElement) {
  const out: string[] = [];
  if (e.role && e.name && e.name.length <= 120)
    out.push(`role=${e.role}[name=${quote(e.name)}]`);
  if (
    e.text &&
    e.text.length <= 80 &&
    !["textbox", "combobox"].includes(e.role)
  )
    out.push(`text=${quote(e.text)}`);
  if (e.testId) out.push(`[data-testid=${quote(e.testId)}]`);
  if (/^[A-Za-z][\w-]*$/.test(e.id)) out.push(`#${e.id}`);
  if (e.nameAttr) out.push(`${e.tag}[name=${quote(e.nameAttr)}]`);
  if (e.tag === "a" && e.href && e.href.length <= 300)
    out.push(`a[href=${quote(e.href)}]`);
  return out;
}

async function count(page: Page, selector: string) {
  try {
    return await page.locator(selector).count();
  } catch {
    return -1;
  }
}

/**
 * Extracts a compact, deduplicated element map from the loaded page. Every entry's selector
 * resolves to exactly one element at extraction time.
 */
export async function elementMap(
  page: Page,
  limit = 150,
): Promise<PageElement[]> {
  // tsx/esbuild may wrap nested functions in __name(); give the page a no-op shim.
  await page.evaluate("globalThis.__name ??= (f) => f");
  const raw = await page.evaluate(collect);
  const used = new Set<string>();
  const out: PageElement[] = [];
  for (const e of raw) {
    if (out.length >= limit) break;
    for (const selector of selectorCandidates(e)) {
      if (used.has(selector)) continue;
      if ((await count(page, selector)) !== 1) continue;
      used.add(selector);
      out.push({
        role: e.role || e.tag,
        name: e.name.slice(0, MAX_LABEL),
        ...(e.text && e.text !== e.name
          ? { text: e.text.slice(0, MAX_LABEL) }
          : {}),
        ...(e.href ? { href: e.href.slice(0, 200) } : {}),
        selector,
      });
      break;
    }
  }
  return out;
}

/** Formats the map compactly for an agent prompt (one element per line). */
export function formatElementMap(elements: PageElement[]) {
  return elements
    .map((e) =>
      [
        e.selector,
        e.role,
        e.name && `name: ${e.name}`,
        e.text && `text: ${e.text}`,
        e.href && `href: ${e.href}`,
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

/** Dry-runs each step's selector on the live page: exactly one match is required. */
export async function validateSteps(
  page: Page,
  steps: { action: string; selector?: string }[],
): Promise<StepCheck[]> {
  const checks: StepCheck[] = [];
  for (const step of steps) {
    if (!step.selector) {
      checks.push({ status: "none" });
      continue;
    }
    const n = await count(page, step.selector);
    checks.push(
      n === 1
        ? { status: "ok", count: 1 }
        : n === 0
          ? {
              status: "missing",
              count: 0,
              message:
                "Not found on the loaded page. It may only appear after an earlier step; check it before approving.",
            }
          : n < 0
            ? { status: "invalid", message: "Not a valid selector" }
            : {
                status: "ambiguous",
                count: n,
                message: `Matches ${n} elements. Make it more specific.`,
              },
    );
  }
  return checks;
}
