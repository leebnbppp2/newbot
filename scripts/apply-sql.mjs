import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , databaseName, sqlFile] = process.argv;

if (!databaseName || !sqlFile) {
  console.error("Usage: node scripts/apply-sql.mjs <database-name> <sql-file>");
  process.exit(1);
}

const resolved = path.resolve(process.cwd(), sqlFile);
const raw = fs
  .readFileSync(resolved, "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const statements = raw
  .split(/;\s*\n/g)
  .map((statement) => statement.trim())
  .filter(Boolean);

for (const statement of statements) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", databaseName, "--remote", "--command", `${statement};`],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
}

console.log(`Applied ${statements.length} statements from ${sqlFile}`);
