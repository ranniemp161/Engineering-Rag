import { parseDocument } from "yaml";

export type Passage = {
  content: string;
  startLine: number;
  endLine: number;
  headingPath: string;
};

export function parseMarkdown(
  source: string,
  fallbackTitle: string,
  target = 1600,
) {
  const lines = source.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  let start = 0;
  let title = "";
  let tags: string[] = [];
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex(
      (line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line),
    );
    if (end > 0) {
      const front = parseDocument(lines.slice(1, end).join("\n"), {
        schema: "failsafe",
      });
      if (!front.errors.length) {
        try {
          const data = front.toJS({ maxAliasCount: 0 });
          if (typeof data?.title === "string") title = data.title;
          const values: unknown[] = Array.isArray(data?.tags)
            ? data.tags
            : [data?.tags];
          tags = values.filter((v): v is string => typeof v === "string");
          start = end + 1;
        } catch {
          /* Keep unsupported frontmatter retrievable as source text. */
        }
      }
    }
  }
  const headings: string[] = [];
  const chunks: Passage[] = [];
  let fence = "";
  let section = start;
  function flush(end: number) {
    const content = lines.slice(section, end).join("\n");
    const headingPath = headings.filter(Boolean).join(" / ");
    let offset = 0;
    let line = section + 1;
    while (offset < content.length) {
      let stop = Math.min(offset + target, content.length);
      if (stop < content.length) {
        const newline = content.lastIndexOf("\n", stop - 1);
        if (newline > offset + target / 2) stop = newline + 1;
      }
      const part = content.slice(offset, stop);
      const newlines = part.split("\n").length - 1;
      if (part.trim())
        chunks.push({
          content: part,
          headingPath,
          startLine: line,
          endLine: line + newlines - (part.endsWith("\n") ? 1 : 0),
        });
      if (stop === content.length) break;
      const lastLine = part.trimEnd().lastIndexOf("\n") + 1;
      const overlap =
        lastLine > 0 && part.length - lastLine <= 160
          ? part.length - lastLine
          : 0;
      line += part.slice(0, part.length - overlap).split("\n").length - 1;
      offset = stop - overlap;
    }
    section = end;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1]?.startsWith(fence) && !marker[2]?.trim()) {
        flush(i + 1);
        fence = "";
      }
    } else if (marker?.[1]) {
      flush(i);
      fence = marker[1];
    } else {
      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading?.[1] && heading[2]) {
        flush(i);
        const level = heading[1].length;
        const name = heading[2].replace(/\s+#+$/, "");
        headings.length = level - 1;
        headings.push(name);
        if (!title && level === 1) title = name;
      }
    }
  }
  flush(lines.length);
  return { title: title || fallbackTitle, tags, chunks };
}
