import "dotenv/config";
import { createApp } from "./app";
import { initializeDatabase, pool } from "./db";

const apiKey = process.env.API_KEY;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be configured");
}
if (!apiKey) {
  throw new Error("API_KEY must be configured");
}

const app = createApp(apiKey);
let httpServer: ReturnType<typeof app.listen> | undefined;

async function start(): Promise<void> {
  await initializeDatabase();
  const port = Number(process.env.PORT ?? 3000);
  httpServer = app.listen(port, "0.0.0.0", () => {
    console.log(`Clinic booking app listening on port ${port}`);
  });
}

void start().catch((error: unknown) => {
  console.error("Failed to start clinic booking app", error);
  process.exitCode = 1;
});

function shutdown(): void {
  if (!httpServer) {
    void pool.end();
    return;
  }
  httpServer.close((error) => {
    if (error) {
      console.error("Failed to close HTTP server", error);
      process.exitCode = 1;
    }
    void pool.end().catch((poolError: unknown) => {
      console.error("Failed to close database pool", poolError);
      process.exitCode = 1;
    });
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
