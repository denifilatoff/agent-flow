import { DatabaseSync } from "node:sqlite";

import { validateDocument } from "../config/schema-validator.ts";
import type { LocalExecution } from "../config/types.js";
import type { TicketRef } from "../provider/types.js";

export interface StoredExecution {
  revision: number;
  value: LocalExecution;
}

export interface LocalStore {
  load(scope: string, ref: TicketRef): StoredExecution | null;
  save(scope: string, ref: TicketRef, expected: number | null, value: LocalExecution): StoredExecution;
  close(): void;
}

interface ExecutionRow {
  revision: number;
  payload: string;
}

const CREATE_TABLE = `
  CREATE TABLE ticket_execution (
    provider_scope TEXT NOT NULL,
    repository TEXT NOT NULL,
    ticket_number INTEGER NOT NULL CHECK (ticket_number > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    PRIMARY KEY (provider_scope, repository, ticket_number)
  ) STRICT;
`;

export function openLocalStore(path: string): LocalStore {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    initialize(database);

    const load = database.prepare(`
      SELECT revision, payload FROM ticket_execution
      WHERE provider_scope = ? AND repository = ? AND ticket_number = ?
    `);
    const insert = database.prepare(`
      INSERT INTO ticket_execution (provider_scope, repository, ticket_number, revision, payload)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT DO NOTHING
    `);
    const update = database.prepare(`
      UPDATE ticket_execution SET revision = ?, payload = ?
      WHERE provider_scope = ? AND repository = ? AND ticket_number = ? AND revision = ?
    `);

    return {
      load(scope, ref) {
        assertKey(scope, ref);
        const row = load.get(scope, ref.repository, ref.number) as ExecutionRow | undefined;
        return row ? stored(row) : null;
      },

      save(scope, ref, expected, value) {
        assertKey(scope, ref);
        if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) {
          throw new Error("expected local revision must be a non-negative integer or null");
        }
        const revision = expected === null ? 0 : expected + 1;
        const valid = validateDocument<LocalExecution>("LocalExecution", value);
        if (valid.control && valid.control.sequence !== revision) {
          throw new Error("control sequence must equal local revision");
        }
        const payload = JSON.stringify(valid);
        if (payload === undefined) throw new Error("local execution payload is not serializable");

        database.exec("BEGIN IMMEDIATE");
        try {
          const result = expected === null
            ? insert.run(scope, ref.repository, ref.number, payload)
            : update.run(revision, payload, scope, ref.repository, ref.number, expected);
          if (result.changes !== 1) throw new Error("stale local execution write");
          database.exec("COMMIT");
        } catch (error) {
          try {
            database.exec("ROLLBACK");
          } catch {
            // The failed statement may already have ended the transaction.
          }
          throw error;
        }
        return { revision, value: valid };
      },

      close() {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function initialize(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version === 1) return;
  if (row.user_version !== 0) throw new Error(`unsupported local store schema version: ${row.user_version}`);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(CREATE_TABLE);
    database.exec("PRAGMA user_version = 1");
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The failed statement may already have ended the transaction.
    }
    throw error;
  }
}

function assertKey(scope: string, ref: TicketRef): void {
  if (scope.length === 0) throw new Error("provider scope must not be empty");
  if (ref.repository.length === 0 || !Number.isSafeInteger(ref.number) || ref.number < 1) {
    throw new Error("invalid local execution ticket identity");
  }
}

function stored(row: ExecutionRow): StoredExecution {
  let value: unknown;
  try {
    value = JSON.parse(row.payload);
    value = validateDocument<LocalExecution>("LocalExecution", value);
  } catch (error) {
    throw new Error("invalid local execution payload", { cause: error });
  }
  const execution = value as LocalExecution;
  if (execution.control && execution.control.sequence !== row.revision) {
    throw new Error("invalid local execution payload: control sequence does not match revision");
  }
  return { revision: row.revision, value: execution };
}
