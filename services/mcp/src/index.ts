import { CivicTechClient } from "./client.ts";
import { startStdioServer } from "./server.ts";

async function main(): Promise<void> {
  const client = new CivicTechClient();
  await startStdioServer({ deps: { client } });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "Fatal MCP server error";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
