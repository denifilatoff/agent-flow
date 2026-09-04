const MARKER_PREFIX = "<!-- agent-flow:";
const CURRENT_MARKER = /^\s{0,3}<!-- agent-flow:v1 ([\s\S]+) -->\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PublicationMetadata {
  config: string;
  controller: string;
}

export type ParsedPublication =
  | { kind: "current"; metadata: PublicationMetadata }
  | { kind: "unmarked" | "legacy" | "invalid" };

export interface Publication {
  key: string;
  createdAt: string;
  metadata: PublicationMetadata;
}

function metadata(value: unknown): PublicationMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("config") || !keys.includes("controller")) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.config !== "string" || !SHA.test(candidate.config)) return null;
  if (typeof candidate.controller !== "string" || !UUID.test(candidate.controller)) return null;
  return { config: candidate.config, controller: candidate.controller };
}

function isQuotedExample(line: string): boolean {
  const trimmed = line.trim();
  return /^>/.test(trimmed)
    || /^`{1,2}[\s\S]+`{1,2}$/.test(trimmed)
    || /^(?:"[\s\S]*"|'[\s\S]*')$/.test(trimmed);
}

export function parsePublication(body: string): ParsedPublication {
  let fence: { character: string; length: number } | null = null;
  const candidates: Array<"invalid" | "legacy" | { kind: "current"; metadata: PublicationMetadata }> = [];

  for (const line of body.split(/\r?\n/)) {
    const opening = FENCE.exec(line);
    if (fence) {
      if (opening && opening[1]![0] === fence.character && opening[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (opening) {
      fence = { character: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    if (isQuotedExample(line)) continue;

    if (line.includes("<!-- agent-flow:v1 flow=") || line.includes("<!-- agent-flow-control:")) {
      candidates.push(line.includes("<!-- agent-flow:v1 flow=") || line.includes("<!-- agent-flow-control:v1") ? "legacy" : "invalid");
      continue;
    }

    const current = CURRENT_MARKER.exec(line);
    if (current) {
      try {
        const parsed = metadata(JSON.parse(current[1]!));
        candidates.push(parsed ? { kind: "current", metadata: parsed } : "invalid");
      } catch {
        candidates.push("invalid");
      }
      continue;
    }
    if (line.includes(MARKER_PREFIX) || line.includes("<!-- agent-flow-control:")) candidates.push("invalid");
  }

  if (candidates.length === 0) return { kind: "unmarked" };
  if (candidates.length !== 1 || candidates[0] === "invalid" || typeof candidates[0] === "string") {
    return { kind: candidates[0] === "legacy" && candidates.length === 1 ? "legacy" : "invalid" };
  }
  return candidates[0];
}

export function renderPublication(input: PublicationMetadata): string {
  const valid = metadata(input);
  if (!valid) throw new Error("invalid publication metadata");
  return `<!-- agent-flow:v1 ${JSON.stringify({ config: valid.config, controller: valid.controller })} -->`;
}

export function electOwner(publications: readonly Publication[]): Publication | null {
  for (const publication of publications) {
    if (typeof publication.createdAt !== "string" || !Number.isFinite(Date.parse(publication.createdAt))) {
      throw new Error("createdAt must be a valid timestamp");
    }
  }
  const ordered = [...publications].sort((a, b) => {
    const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return delta || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  return ordered[0] ?? null;
}
