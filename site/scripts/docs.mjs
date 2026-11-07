// The docs pages (/docs and /docs/<slug>), made at build time from docs/guide.md, the user guide
// every thread's agent reads. The guide stays one plain Markdown file; this splits it on its
// `## ` headings into a page each and turns the Markdown into HTML. There's no Markdown
// dependency (the site has none), so it handles only what the guide uses: headings, paragraphs,
// lists, **bold**, `code`, code blocks and [links](...). Anything else shows as written, so a
// new kind of Markdown in the guide needs a line here.
//
// Each section's address comes from the comment on the line under its heading, like
// `<!-- slug: threads -->`, so renaming a heading doesn't move its page. A section without one
// gets a slug from its heading. The Mac app links to some of these pages (its tour's ⓘ), and
// app-doc-slugs.json lists those: the build stops if one of them has gone from the guide.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** "Patches: your own buttons and panels" to "patches-your-own-buttons-and-panels". */
export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The guide as { title, intro, sections }, each section { slug, title, body } with its Markdown
 * body. `required` is the slugs something outside the site links to.
 */
export function readGuide(repoRoot, required = []) {
  const text = withExperiments(repoRoot, readFileSync(join(repoRoot, "docs", "guide.md"), "utf8").replace(/\r\n/g, "\n"));
  const [head, ...rest] = text.split(/^(?=## )/m);
  const title = head.match(/^# (.+)$/m)?.[1].trim() ?? "Docs";
  const intro = head.replace(/^# .+$/m, "");
  const seen = new Set();
  const sections = rest.map((chunk) => {
    const [heading, ...lines] = chunk.split("\n");
    const sectionTitle = heading.slice(3).trim();
    const marker = lines.findIndex((l) => l.trim() !== "");
    const named = lines[marker]?.match(/^<!--\s*slug:\s*([a-z0-9-]+)\s*-->$/);
    const slug = named ? named[1] : slugify(sectionTitle);
    if (named) lines.splice(marker, 1);
    if (seen.has(slug)) throw new Error(`docs/guide.md has two sections with the slug ${slug}`);
    seen.add(slug);
    return { slug, title: sectionTitle, body: lines.join("\n") };
  });
  for (const slug of required) {
    if (!seen.has(slug)) throw new Error(`docs/guide.md has no section with the slug ${slug}, and the app links to /docs/${slug} (site/app-doc-slugs.json)`);
  }
  return { title, intro, sections };
}

/**
 * The guide points at docs/experiments.md for the experiments there are now (it's made from
 * runner/src/experiments/*.md, so it can't fall out of date). The site shows the list itself
 * in its place, as the guide's relative link means nothing here.
 */
function withExperiments(repoRoot, guide) {
  const region = /<!-- experiments:start -->[\s\S]*?<!-- experiments:end -->/;
  if (!region.test(guide)) return guide;
  const doc = readFileSync(join(repoRoot, "docs", "experiments.md"), "utf8").replace(/\r\n/g, "\n");
  const list = doc.match(/<!-- list:start -->\n([\s\S]*?)<!-- list:end -->/)?.[1].trim();
  if (!list) throw new Error("docs/experiments.md has no list between its list:start and list:end markers");
  return guide.replace(region, () => list);
}

/**
 * Inline Markdown: `code`, **bold** and [links](...). A link to #slug is a link to that
 * section's page; any other link has to be a full https:// one, since the guide's own relative
 * paths (docs/protocol.md) mean nothing on the site.
 */
function inline(text, slugs) {
  return text.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `<code>${escape(part.slice(1, -1))}</code>`;
    return escape(part)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
        if (href.startsWith("#")) {
          const slug = href.slice(1);
          if (!slugs.has(slug)) throw new Error(`docs/guide.md links to #${slug}, which isn't a section's slug`);
          return `<a href="/docs/${slug}">${label}</a>`;
        }
        if (!/^https?:\/\//.test(href)) throw new Error(`docs/guide.md links to ${href}: the docs pages only take #slug or https:// links`);
        return `<a href="${href}">${label}</a>`;
      })
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }).join("");
}

/** Block Markdown to HTML, for the subset the guide uses. `### ` headings become <h2>s with ids. */
export function markdown(md, slugs) {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const out = [];
  let i = 0;
  const blank = (l) => l === undefined || l.trim() === "";
  const item = (l) => l.match(/^(-|\d+\.) (.*)$/);
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    // A heading inside a section (### or deeper; ## starts a new page).
    const heading = line.match(/^(#{3,6}) (.+)$/);
    if (heading) {
      // A step up, as the page's own title is its <h1>: ### is an <h2> on the page.
      const level = heading[1].length - 1;
      out.push(`<h${level} id="${slugify(heading[2])}">${inline(heading[2].trim(), slugs)}</h${level}>`);
      i++;
      continue;
    }
    // A fenced code block.
    if (line.startsWith("```")) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    // An indented code block (four spaces, like the pairing command).
    if (line.startsWith("    ")) {
      const code = [];
      while (i < lines.length && (lines[i].startsWith("    ") || (blank(lines[i]) && lines[i + 1]?.startsWith("    ")))) {
        code.push(lines[i++].slice(4));
      }
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    // A list: items start with "- " or "1. ", and carry on over indented lines.
    const first = item(line);
    if (first) {
      const ordered = first[1] !== "-";
      const items = [];
      while (i < lines.length && !blank(lines[i])) {
        const next = item(lines[i]);
        if (next && (next[1] !== "-") === ordered) items.push(next[2]);
        else if (/^\s+/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>\n${items.map((t) => `  <li>${inline(t, slugs)}</li>`).join("\n")}\n</${tag}>`);
      continue;
    }
    // A paragraph: everything up to a blank line or the next block.
    const para = [];
    while (i < lines.length && !blank(lines[i]) && !(para.length && (item(lines[i]) || /^#{3,6} /.test(lines[i]) || lines[i].startsWith("```")))) {
      para.push(lines[i++].trim());
    }
    out.push(`<p>${inline(para.join(" "), slugs)}</p>`);
  }
  return out.join("\n");
}

/** The first sentence of a section, as plain text, for its page's description. Empty when it starts with a list. */
export function summary(md) {
  const para = md.replace(/<!--[\s\S]*?-->/g, "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|-|\d+\.|```| {4})/.test(p)) ?? "";
  const text = para.replace(/\s+/g, " ").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // A sentence ends at a full stop before a capital or the end, so "the ... menu" doesn't.
  const sentence = text.match(/^.+?[.?!](?=\s+[A-Z"]|$)/)?.[0] ?? text;
  return sentence.length > 160 ? `${sentence.slice(0, 159).trimEnd()}…` : sentence;
}
