import type { Database } from "@tursodatabase/database";
import { type Embedder, toBlob } from "./embedder.ts";

/** Text embedded for a passage: its document title and heading path give context. */
export function passageText(title: string, headingPath: string, content: string) {
  return [title, headingPath, content].filter(Boolean).join("\n");
}

/**
 * Embeds every chunk that lacks a vector for the embedder's model. Changed
 * documents get new chunk rows, and their old vectors are removed by cascade,
 * so unchanged passages are never embedded twice. Each batch commits on its
 * own, so an interrupted run keeps completed batches and resumes later.
 */
export async function embedPending(
  db: Database,
  embedder: Embedder,
  batchSize = 32,
) {
  const stale = await db.run(
    "DELETE FROM chunk_embeddings WHERE model <> ?",
    embedder.model,
  );
  let embedded = 0;
  let dimensions: number | undefined;
  for (;;) {
    const rows = await db.all(
      `SELECT c.id, d.title, c.heading_path, c.content FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id
       WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT ?`,
      batchSize,
    );
    if (!rows.length) break;
    const vectors = await embedder.embed(
      rows.map((r) => passageText(r.title, r.heading_path, r.content)),
      "passage",
    );
    if (vectors.length !== rows.length)
      throw new Error("Embedder returned the wrong number of vectors");
    for (const vector of vectors) {
      dimensions ??= vector.length;
      if (vector.length !== dimensions || !vector.length)
        throw new Error("Embedder returned vectors of inconsistent size");
    }
    await db.transactionAsync(async (tx) => {
      const insert = await tx.prepare(
        "INSERT INTO chunk_embeddings(chunk_id, model, embedding) VALUES(?,?,?)",
      );
      for (const [i, row] of rows.entries())
        await insert.run(row.id, embedder.model, toBlob(vectors[i] as Float32Array));
    })();
    embedded += rows.length;
  }
  const total = await db.get(
    "SELECT COUNT(*) AS chunks, (SELECT COUNT(*) FROM chunk_embeddings) AS vectors FROM chunks",
  );
  return {
    model: embedder.model,
    embedded,
    removedStale: Number(stale.changes ?? 0),
    chunks: Number(total?.chunks ?? 0),
    vectors: Number(total?.vectors ?? 0),
  };
}
