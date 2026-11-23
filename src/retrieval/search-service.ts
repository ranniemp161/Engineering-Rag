import { access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import { migrate, withIndex } from "../storage/turso.ts";

const inputSchema = z.strictObject({
  query: z.string().min(1).max(512),
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export interface SearchResult {
  documentId: string;
  scope: string;
  title: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

// Keep FTS scoring inside this materialized query. Joining documents before
// ranking can turn valid matches into zero-score rows on Turso 0.8.4.
const rankedQuery = [
  "WITH ranked AS MATERIALIZED (",
  " SELECT id, fts_score(content,?1) AS score FROM chunks",
  " WHERE fts_match(content,?1) ORDER BY score DESC",
  ") SELECT d.id AS documentId,d.scope_id AS scope,substr(d.title,1,256) AS title,",
  " d.relative_path AS relativePath,c.start_line AS startLine,c.content,r.score",
  " FROM ranked r CROSS JOIN chunks c ON c.id=r.id",
  " CROSS JOIN documents d ON d.id=c.document_id",
  " WHERE d.scope_id IN ('shared',?2)",
  " ORDER BY r.score DESC,d.id,c.ordinal LIMIT ?3 OFFSET ?4",
].join("\n");

function excerpt(content: string, firstLine: number, terms: string[]) {
  const match = new RegExp(terms.join("|"), "iu").exec(content);
  // Terms contain only Unicode letters/numbers, so they are safe regex literals.
  const start = Math.max(0, (match?.index ?? 0) - 100);
  const raw = content.slice(start,start+400);
  const snippet = raw.trim();
  const offset = start + raw.length - raw.trimStart().length;
  const startLine = firstLine + content.slice(0,offset).split("\n").length - 1;
  return {snippet,startLine,endLine:startLine + snippet.split("\n").length-1};
}

export async function searchKnowledge(config: Config, input: unknown): Promise<{results: SearchResult[]}> {
  const {query,projectId,limit=config.search.defaultLimit} = inputSchema.parse(input);
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!terms.length) throw new Error("Search requires at least one word or number");
  if (limit>config.search.maxLimit) throw new Error("Search limit exceeds the configured maximum");
  if (projectId !== undefined && !config.scopes.some(s=>s.type==="project" && s.id===projectId)) throw new Error("Unknown project ID");
  // Treat user input as literal keywords. Tantivy operators, fields, and
  // punctuation in the original query cannot change the expression structure.
  const expression = terms.map(term=>'"'+term+'"').join(" OR ");
  await access(config.databasePath).catch((error: NodeJS.ErrnoException)=>{
    if(error.code==="ENOENT") throw new Error("Index missing. Run the index command first.");
    throw error;
  });
  return withIndex(config.databasePath,true,async db=>{
    await migrate(db,true);
    const scopeId=projectId ?? "shared";
    for(const row of await db.all("SELECT id,root_path FROM scopes WHERE id IN ('shared',?)",scopeId)){
      const scope=config.scopes.find(s=>s.id===row.id);
      if(!scope || path.relative(scope.rootPath,row.root_path)!=="") throw new Error("Indexed scope root has changed. Rebuild the index.");
    }
    const results:SearchResult[]=[];
    const pageSize=limit+1;
    let bytes=16;
    for(let offset=0;results.length<limit;offset+=pageSize){
      const rows=await db.all(rankedQuery,expression,scopeId,pageSize,offset);
      for(const row of rows){
        const {content,...metadata}=row;
        const result:SearchResult={...metadata,...excerpt(content,row.startLine,terms)} as SearchResult;
        if(results.some(prior=>prior.documentId===result.documentId && prior.startLine<=result.endLine && prior.endLine>=result.startLine && prior.snippet===result.snippet)) continue;
        bytes+=Buffer.byteLength(JSON.stringify(result))+1;
        if(bytes>65536) return {results};
        results.push(result);
        if(results.length===limit) break;
      }
      if(rows.length<pageSize) break;
    }
    return {results};
  });
}
