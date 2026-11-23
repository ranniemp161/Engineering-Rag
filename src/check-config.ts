import { loadConfig } from "./config/load-config.ts";

try {
  const config = await loadConfig();
  console.log(
    `Configuration valid for scopes ${config.scopes.map((scope) => scope.id).join(", ")}`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
