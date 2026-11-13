import { defineConfig } from "drizzle-kit";

// Generates ordered SQL migrations from src/db/schema.ts. No database connection is used.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
