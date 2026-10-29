export type SecretRedactor = (value: string) => string;

export interface StartupRedactor {
  register(value: string | Buffer): void;
  redact: SecretRedactor;
}

const MAX_SOURCE_STRINGS = 256;
const MAX_LITERALS = 2_048;
const MAX_LITERAL_BYTES = 4_194_304;

export function createStartupRedactor(): StartupRedactor {
  const literals = new Set<string>();
  let ordered: string[] = [];
  const percentPatterns = new Map<string, RegExp>();
  let orderedPercentPatterns: RegExp[] = [];
  let sourceStrings = 0;
  let literalBytes = 0;

  const variants = (value: string): string[] => {
    if (!value) return [];
    const percent = encodeURIComponent(value);
    const form = new URLSearchParams({ value }).toString().slice("value=".length);
    const base64 = Buffer.from(value).toString("base64");
    const base64url = base64.replaceAll("+", "-").replaceAll("/", "_");
    const hex = Buffer.from(value).toString("hex");
    return [
      value,
      JSON.stringify(value).slice(1, -1),
      percent,
      lowerPercentHex(percent),
      form,
      lowerPercentHex(form),
      base64,
      base64.replace(/=+$/, ""),
      base64url,
      base64url.replace(/=+$/, ""),
      hex,
      hex.toUpperCase(),
    ];
  };

  const redact: SecretRedactor = (value) => {
    let result = value;
    for (const pattern of orderedPercentPatterns) result = result.replace(pattern, "[REDACTED]");
    for (const literal of ordered) {
      result = result.split(literal).join("[REDACTED]");
    }
    return result;
  };

  return {
    register(value) {
      const text = typeof value === "string" ? value : value.toString("utf8");
      const sources: Array<{ value: string; redact: boolean }> = [{ value: text, redact: true }];
      if (typeof value !== "string") {
        const trimmed = text.trim();
        if (trimmed !== text) sources.push({ value: trimmed, redact: true });
        let parsed: unknown;
        let validJson = false;
        try {
          parsed = JSON.parse(text);
          validJson = true;
        } catch {
          // Opaque credential files are still covered by their exact bytes and literal encodings.
        }
        if (validJson) visitStrings(parsed, (candidate) => {
          sources.push({ value: candidate, redact: candidate.length > 0 });
          if (sourceStrings + sources.length > MAX_SOURCE_STRINGS) throw redactionLimitError();
        });
      }
      if (sourceStrings + sources.length > MAX_SOURCE_STRINGS) throw redactionLimitError();

      const additions = new Set<string>();
      const patternAdditions = new Map<string, RegExp>();
      for (const source of sources) {
        if (!source.redact) continue;
        for (const literal of variants(source.value)) if (literal && !literals.has(literal)) additions.add(literal);
        for (const encoded of [encodeURIComponent(source.value), new URLSearchParams({ value: source.value }).toString().slice(6)]) {
          const pattern = mixedPercentPattern(encoded);
          if (pattern && !percentPatterns.has(pattern.source)) patternAdditions.set(pattern.source, pattern);
        }
      }
      const addedBytes = [...additions].reduce((total, literal) => total + Buffer.byteLength(literal), 0)
        + [...patternAdditions.keys()].reduce((total, pattern) => total + Buffer.byteLength(pattern), 0);
      if (literals.size + percentPatterns.size + additions.size + patternAdditions.size > MAX_LITERALS
        || literalBytes + addedBytes > MAX_LITERAL_BYTES) {
        throw redactionLimitError();
      }
      sourceStrings += sources.length;
      literalBytes += addedBytes;
      for (const literal of additions) literals.add(literal);
      for (const [source, pattern] of patternAdditions) percentPatterns.set(source, pattern);
      ordered = [...literals].sort((left, right) => right.length - left.length);
      orderedPercentPatterns = [...percentPatterns.values()].sort((left, right) => right.source.length - left.source.length);
    },
    redact,
  };
}

function mixedPercentPattern(value: string): RegExp | undefined {
  if (!/%[0-9A-F]{2}/.test(value)) return undefined;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
    /%([0-9A-F])([0-9A-F])/g,
    (_escape, first: string, second: string) => `%${hexPattern(first)}${hexPattern(second)}`,
  );
  return new RegExp(escaped, "g");
}

function hexPattern(value: string): string {
  return /[A-F]/.test(value) ? `[${value}${value.toLowerCase()}]` : value;
}

function lowerPercentHex(value: string): string {
  return value.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

function redactionLimitError(): Error {
  return new Error("credential redaction limits exceeded");
}

function visitStrings(value: unknown, visit: (value: string) => void): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      visit(current);
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current !== null && typeof current === "object") {
      for (const item of Object.values(current)) pending.push(item);
    }
  }
}
