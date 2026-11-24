import type { Embedder } from "../src/semantic/embedder.ts";

// Words in one group share a dimension, standing in for learned synonyms.
const CONCEPTS = [
  ["undo", "reverse", "reversal", "reversing", "cancel"],
  ["owe", "debt", "unpaid", "owed"],
  ["hosted", "region", "server", "singapore"],
  ["copied", "backup", "backups", "cloud"],
];

export function fakeEmbedder(model = "fake-model") {
  const calls: string[][] = [];
  const embedder: Embedder = {
    model,
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => {
        const vector = new Float32Array(CONCEPTS.length + 1);
        for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
          const concept = CONCEPTS.findIndex((group) => group.includes(word));
          const slot = concept < 0 ? CONCEPTS.length : concept;
          vector[slot] = (vector[slot] ?? 0) + (concept < 0 ? 0.05 : 1);
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((x) => x / norm);
      });
    },
  };
  return { embedder, calls, texts: () => calls.flat() };
}
