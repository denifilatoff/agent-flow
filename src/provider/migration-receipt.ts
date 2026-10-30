import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parsePublication, renderPublication } from "./publication.ts";
import type { Actor } from "../config/types.ts";
import type { TicketRef } from "./types.ts";
export interface MigrationReceipt {
  apiVersion: "agent-flow/migration-v1";
  kind: "MigrationReceipt";
  ticket: TicketRef;
  workspace: string;
  activation: {
    eventId: string;
    label: string;
    actor: Actor;
    occurredAt: string;
  };
  owner: { key: string; config: string; createdAt: string };
  request: {
    id: string;
    actor: Actor;
    bodyHash: string;
    createdAt: string;
    updatedAt: string;
  };
  source: { config: string; stage: string; resume: string | null };
  target: { config: string; flow: string; label: string; basis: string };
  change: {
    provider: "github" | "gitlab";
    repository: string;
    number: number;
    url: string;
    headRepository: string;
    headBranch: string;
    headSha: string;
    marker: string;
  };
  start: string;
  retained: Array<{ key: string; stage: string; digest: string }>;
  baseline: { comments: string[]; reviews: string[] };
  predecessor: string | null;
}
const validate = new Ajv2020({ strict: true }).compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../../schemas/v1/migration-receipt.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
export function renderMigrationReceipt(
  receipt: MigrationReceipt,
  controller: string,
): string {
  if (!validate(receipt))
    throw new Error(
      "Invalid migration receipt: " + JSON.stringify(validate.errors),
    );
  return (
    renderPublication({ config: receipt.target.config, controller }) +
    "\n<!-- agent-flow-migration:v1 " +
    JSON.stringify(receipt).replaceAll("<", "\\u003c") +
    " -->"
  );
}
export function parseMigrationReceipt(
  body: string,
): { receipt: MigrationReceipt; controller: string } | null {
  if (!body.includes("<!-- agent-flow-migration:")) return null;
  if (Buffer.byteLength(body) > 256 * 1024)
    throw new Error("Migration receipt exceeds size limit");
  const lines = body.split(/\r?\n/),
    blocks = lines.filter((l) => l.startsWith("<!-- agent-flow-migration:"));
  if (blocks.length !== 1) throw new Error("Conflicting migration metadata");
  const match = /^<!-- agent-flow-migration:v1 (.+) -->$/.exec(blocks[0]!);
  if (!match)
    throw new Error("Unsupported or invalid migration receipt version");
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    throw new Error("Invalid migration receipt JSON");
  }
  if (!validate(value))
    throw new Error(
      "Invalid migration receipt: " + JSON.stringify(validate.errors),
    );
  const receipt = value as MigrationReceipt,
    marker = parsePublication(body);
  if (
    marker.kind !== "current" ||
    marker.metadata.config !== receipt.target.config
  )
    throw new Error("Migration receipt marker mismatch");
  return { receipt, controller: marker.metadata.controller };
}
