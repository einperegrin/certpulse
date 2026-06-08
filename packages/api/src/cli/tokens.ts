/**
 * Token management CLI: `tsx src/cli/tokens.ts {create|list|revoke} [...]`.
 *
 * Usage examples:
 *   tsx src/cli/tokens.ts create --label "ci-deploy"
 *   tsx src/cli/tokens.ts create --label "ops" --expires "2027-01-01T00:00:00Z"
 *   tsx src/cli/tokens.ts list
 *   tsx src/cli/tokens.ts revoke --id 3
 *
 * The raw token is printed exactly once on `create` — store it now, the
 * database only keeps its SHA-256 hash.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { apiTokens } from "../db/schema.js";
import { generateToken, hashToken } from "../services/auth.js";

function getArg(name: string, required: boolean): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return required ? null : null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  const cmd = process.argv[2];
  const db = getDb();

  if (cmd === "create") {
    const label = getArg("label", true);
    if (!label) {
      console.error("Error: --label is required for create");
      process.exit(2);
    }
    const expires = getArg("expires", false);
    const token = generateToken();
    const hash = hashToken(token);
    db.insert(apiTokens)
      .values({ tokenHash: hash, label, expiresAt: expires ?? null })
      .run();
    console.log(`Token created. SAVE THIS — it will not be shown again:\n  ${token}`);
    return;
  }

  if (cmd === "list") {
    const rows = db
      .select({
        id: apiTokens.id,
        label: apiTokens.label,
        createdAt: apiTokens.createdAt,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .all();
    console.table(rows);
    return;
  }

  if (cmd === "revoke") {
    const idStr = getArg("id", true);
    if (!idStr) {
      console.error("Error: --id is required for revoke");
      process.exit(2);
    }
    const id = parseInt(idStr, 10);
    if (Number.isNaN(id)) {
      console.error("--id must be an integer");
      process.exit(1);
    }
    db.delete(apiTokens).where(eq(apiTokens.id, id)).run();
    console.log(`Token ${id} revoked.`);
    return;
  }

  console.error(
    "Usage: tsx src/cli/tokens.ts {create|list|revoke} [--label LABEL] [--expires ISO] [--id N]"
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
