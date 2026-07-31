import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The migration chain, as a fact rather than as a memory.
//
// 001–006 were written to be pasted into the SQL Editor on top of a database
// that already existed: 001 opens with `ALTER TABLE leads ADD COLUMN`, and six
// tables it references are created by nothing in this directory. Everything the
// server actually uses is created from 009 onward, and that part of the chain
// runs on an empty database.
//
// Which of those two facts matters is a decision for the owner — declare the
// reproducible chain to start at 009, or write a legacy baseline that makes
// 001+ runnable. This suite decides neither. It pins what is true today so the
// decision is made against the repository, and so that a new migration cannot
// quietly break the part that does work.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// A testability seam, not a configuration knob: it lets the negative fixture
// build a broken chain in a scratch directory instead of editing an applied
// migration, which this project never does even temporarily.
const migrationsDir = process.env.NEGIS_MIGRATIONS_DIR || path.join(repoRoot, "migrations");

/** The chain that runs on an empty database. */
const CHAIN_STARTS_AT = 9;

/**
 * Tables that pre-009 migrations reference and no migration creates.
 *
 * A legacy baseline would have to create these six. `user_roles` looks like a
 * seventh — 008 alters it — but that ALTER sits inside
 * `IF to_regclass('public.user_roles') IS NOT NULL`, so it is a no-op on an
 * empty database and needs nothing.
 */
const UNCREATED_LEGACY_TABLES = [
  "agents",
  "booking_statuses",
  "bookings",
  "clinics",
  "lead_statuses",
  "services",
];

/**
 * Tables created twice in the chain, with the reason each one is tolerated.
 *
 * A collision is not harmless: both statements are `CREATE TABLE IF NOT
 * EXISTS`, so on an empty database the earlier definition wins silently and the
 * later one never applies. Anything not listed here fails the test.
 */
const KNOWN_COLLISIONS: Record<string, string> = {
  chat_messages:
    "005 (clinic_id → clinics, conversation_id, sender_agent_id, body) and 010 " +
    "(workspace_id → workspaces, channel, sender_name, sender_role, message). " +
    "lib/crm/server.ts uses the 010 shape, and 005 also references `clinics`, " +
    "which nothing creates — so 005 cannot run on an empty database at all. A " +
    "legacy baseline has to resolve this, not just stub the six tables.",
};

type Chain = {
  file: string;
  index: number;
  created: string[];
  referenced: string[];
  altered: string[];
  guardedAlters: string[];
};

const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
const REFERENCES = /references\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
const ALTER_TABLE = /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
const TO_REGCLASS = /to_regclass\(\s*'public\.([a-z_][a-z0-9_]*)'\s*\)/gi;

async function readChain(): Promise<Chain[]> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const chain: Chain[] = [];

  for (const file of files) {
    const source = await readFile(path.join(migrationsDir, file), "utf8");
    const all = (pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1].toLowerCase());
    // An ALTER behind to_regclass is skipped when the table is absent, so it
    // does not make the table a dependency.
    const guarded = new Set(all(TO_REGCLASS));

    chain.push({
      file,
      index: Number(file.slice(0, 3)),
      created: all(CREATE_TABLE),
      referenced: all(REFERENCES),
      altered: all(ALTER_TABLE).filter((table) => !guarded.has(table)),
      guardedAlters: [...guarded],
    });
  }

  return chain;
}

test("M1 the chain from 009 onward runs on an empty database", async () => {
  const chain = (await readChain()).filter((entry) => entry.index >= CHAIN_STARTS_AT);
  assert.ok(chain.length > 0, "the chain must exist");

  const createdBy = new Map<string, string>();
  const missing: string[] = [];
  const outOfOrder: string[] = [];

  for (const entry of chain) {
    for (const table of entry.created) {
      if (!createdBy.has(table)) createdBy.set(table, entry.file);
    }
    for (const table of [...entry.referenced, ...entry.altered]) {
      const source = createdBy.get(table);
      if (!source) missing.push(`${entry.file} → ${table}`);
      else if (source > entry.file) outOfOrder.push(`${entry.file} → ${table} (created in ${source})`);
    }
  }

  assert.deepEqual(missing, [], "a migration references a table no earlier migration in the chain creates");
  assert.deepEqual(outOfOrder, [], "a migration references a table created after it");
});

test("M2 no table is created twice without a recorded reason", async () => {
  const chain = await readChain();
  const createdIn = new Map<string, string[]>();

  for (const entry of chain) {
    for (const table of entry.created) {
      createdIn.set(table, [...(createdIn.get(table) ?? []), entry.file]);
    }
  }

  const collisions = [...createdIn.entries()].filter(([, files]) => files.length > 1);
  for (const [table, files] of collisions) {
    assert.ok(
      KNOWN_COLLISIONS[table],
      `${table} is created in ${files.join(", ")}. The earlier definition wins on an empty ` +
        "database and the later one never applies — record why that is acceptable, or remove one.",
    );
  }

  // And a recorded reason must still describe something real.
  for (const table of Object.keys(KNOWN_COLLISIONS)) {
    assert.ok(
      createdIn.get(table) && (createdIn.get(table) as string[]).length > 1,
      `${table} is recorded as a collision but is no longer created twice — delete the entry`,
    );
  }
});

test("M3 the tables a legacy baseline would have to create are exactly the six named", async () => {
  const chain = await readChain();
  const created = new Set(chain.flatMap((entry) => entry.created));
  const needed = new Set(chain.flatMap((entry) => [...entry.referenced, ...entry.altered]));

  const uncreated = [...needed].filter((table) => !created.has(table)).sort();
  assert.deepEqual(
    uncreated,
    UNCREATED_LEGACY_TABLES,
    "the set of tables no migration creates has changed; a baseline decision was made against the old set",
  );
});

test("M4 the guarded ALTER on user_roles stays guarded", async () => {
  const source = await readFile(path.join(migrationsDir, "008_drop_public_auth_users_fks.sql"), "utf8");
  const alterAt = source.indexOf("ALTER TABLE public.user_roles");
  const guardAt = source.indexOf("to_regclass('public.user_roles')");

  assert.ok(guardAt > 0, "the ALTER must be behind an existence check");
  assert.ok(guardAt < alterAt, "and the check must come first");
});
