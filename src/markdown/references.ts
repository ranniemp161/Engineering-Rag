export type ReferenceKind = "link" | "wikilink" | "number";

/** An explicit pointer from a note to another note, before resolution. */
export interface Reference {
  line: number;
  kind: ReferenceKind;
  target: string;
}

// `](target)` alone, so link text that wraps across lines still matches.
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g;
// [[Note]], [[folder/Note]], [[Note#Heading]], [[Note|alias]] and ![[embeds]].
const WIKILINK = /\[\[([^[\]|#\n]+)(?:#[^[\]|\n]*)?(?:\|[^[\]\n]*)?\]\]/g;
// Numbered records such as `0020`, (0004) or "decision 0008." Dates (2026-11-14),
// versions (1.0020), paths and identifiers are excluded by the boundaries.
const NUMBER = /(?<![\w./\\:#-])(\d{3,6})(?![\w-]|\.\d)/g;

/** Offsets of fenced code blocks, whose contents are examples, not references. */
function fencedRanges(source: string) {
  const ranges: [number, number][] = [];
  const fence = /^ {0,3}(`{3,}|~{3,})/gm;
  let open: { at: number; marker: string } | undefined;
  for (const match of source.matchAll(fence)) {
    const marker = match[1] as string;
    if (!open) open = { at: match.index, marker };
    else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      ranges.push([open.at, match.index + match[0].length]);
      open = undefined;
    }
  }
  if (open) ranges.push([open.at, source.length]);
  return ranges;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Extracts Markdown links to `.md` files, wikilinks and numbered references.
 * Resolution against indexed documents happens at query time, so a link to a
 * note indexed later resolves without rescanning the linking note.
 */
export function extractReferences(source: string): Reference[] {
  const fences = fencedRanges(source);
  const lineStarts = [0];
  for (const match of source.matchAll(/\r\n|\n|\r/g))
    lineStarts.push(match.index + match[0].length);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const inFence = (offset: number) =>
    fences.some(([start, end]) => offset >= start && offset < end);
  const found = new Map<string, Reference>();
  const add = (offset: number, kind: ReferenceKind, target: string) => {
    if (inFence(offset) || !target) return;
    const reference = { line: lineOf(offset), kind, target };
    found.set(`${reference.line}\0${kind}\0${target}`, reference);
  };
  for (const match of source.matchAll(MARKDOWN_LINK)) {
    const raw = match[1] as string;
    // Skip external URLs, mail links and same-document anchors.
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    const target = safeDecode(raw.replace(/[#?].*$/, ""));
    if (/\.md$/i.test(target)) add(match.index, "link", target.replace(/\\/g, "/"));
  }
  for (const match of source.matchAll(WIKILINK)) {
    const target = (match[1] as string).trim().replace(/\\/g, "/");
    const extension = /\.([a-z\d]+)$/i.exec(target)?.[1]?.toLowerCase();
    // Wikilinks to attachments such as images are not notes.
    if (!extension || extension === "md") add(match.index, "wikilink", target);
  }
  for (const match of source.matchAll(NUMBER))
    add(match.index, "number", match[1] as string);
  return [...found.values()].sort(
    (a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target),
  );
}
