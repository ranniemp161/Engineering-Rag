import { writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a stand-in Graphify script that appends each call (arguments, working
 * directory, LLM keys it could see) to `$GRAPHIFY_OUT/calls.log` and writes a
 * small graph on `update`. FAKE_GRAPHIFY_FAIL makes it exit 3;
 * FAKE_GRAPHIFY_DELAY delays it by that many milliseconds.
 */
export async function fakeGraphify(dir: string) {
  const fake = path.join(dir, "fake-graphify.mjs");
  await writeFile(
    fake,
    `import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const out = process.env.GRAPHIFY_OUT;
const argv = process.argv.slice(2);
appendFileSync(path.join(out, "calls.log"), JSON.stringify({
  argv, cwd: process.cwd(),
  keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"].filter((k) => process.env[k]),
}) + "\\n");
if (process.env.FAKE_GRAPHIFY_FAIL) { console.error("boom"); process.exit(3); }
if (process.env.FAKE_GRAPHIFY_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_GRAPHIFY_DELAY)));
if (argv[0] === "update")
  writeFileSync(path.join(out, "graph.json"), JSON.stringify({
    nodes: [{ id: "a" }, { id: "b" }], links: [{ source: "a", target: "b" }],
  }));`,
  );
  return fake;
}
