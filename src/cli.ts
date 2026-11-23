import { loadConfig } from "./config/load-config.ts";
import { indexNotes, indexStatus } from "./indexing/index-service.ts";
import { migrate, withIndex } from "./storage/turso.ts";
import { stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { searchKnowledge } from "./retrieval/search-service.ts";

try {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const [command, ...rest] = args;
  if (
    (command !== "search" && args.length !== 1) ||
    !["index", "rebuild", "status","search"].includes(command ?? "")
  )
    throw new Error('Usage: pnpm dev -- index|status|rebuild or search "keywords" [--project ID] [--limit N] [--json]');
  const config = await loadConfig(undefined, { allowUnavailableRoots: true });
  if(command==="search"){
    const {positionals,values}=parseArgs({args:rest,allowPositionals:true,options:{project:{type:"string"},limit:{type:"string"},json:{type:"boolean"}}});
    if(positionals.length!==1) throw new Error("Supply one search query, quoting multiple words");
    const output=await searchKnowledge(config,{query:positionals[0],projectId:values.project,limit:values.limit===undefined?undefined:Number(values.limit)});
    console.log(JSON.stringify(output,null,2));
  } else if (
    command === "status" &&
    !(await stat(config.databasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }))
  )
    console.log(JSON.stringify({ initialized: false, scopes: [] }));
  else {
    const output = await withIndex(
      config.databasePath,
      command === "status",
      async (db) => {
        await migrate(db, command === "status");
        if (command === "status") return indexStatus(db);
        const result = await indexNotes(db, config, command === "rebuild");
        if (result.some((scope) => scope.errors.length)) process.exitCode = 1;
        return result;
      },
    );
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
