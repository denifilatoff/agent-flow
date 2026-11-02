const PREFIX = "<!-- agent-flow-documentation:";
const LINE = /^\s{0,3}<!-- agent-flow-documentation:v1 (.+) -->\s*$/;
const SHA = /^[0-9a-f]{40}$/;

export interface DocumentationMetadata {
  change: number;
  inputHead: string;
  resultHead: string;
}

function metadata(value: unknown): DocumentationMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3
    || !Number.isSafeInteger(candidate.change) || (candidate.change as number) <= 0
    || typeof candidate.inputHead !== "string" || !SHA.test(candidate.inputHead)
    || typeof candidate.resultHead !== "string" || !SHA.test(candidate.resultHead)) return null;
  return { change: candidate.change as number, inputHead: candidate.inputHead, resultHead: candidate.resultHead };
}

export function parseDocumentation(body: string): DocumentationMetadata | null {
  let fence: { character: string; length: number } | null = null;
  const candidates: Array<DocumentationMetadata | null> = [];
  for (const line of body.split(/\r?\n/)) {
    const opening = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opening && opening[1]![0] === fence.character && opening[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (opening) {
      fence = { character: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    if (!line.includes(PREFIX) || /^\s*>/.test(line) || /^\s*[`"']/.test(line)) continue;
    const match = LINE.exec(line);
    try { candidates.push(match ? metadata(JSON.parse(match[1]!)) : null); }
    catch { candidates.push(null); }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export function renderDocumentation(input: DocumentationMetadata): string {
  const valid = metadata(input);
  if (!valid) throw new Error("invalid documentation metadata");
  return `<!-- agent-flow-documentation:v1 ${JSON.stringify(valid)} -->`;
}
