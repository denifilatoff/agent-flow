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
          sources.push({ value: candidate, redact: candidate.trim().length >= 4 });
          if (sourceStrings + sources.length > MAX_SOURCE_STRINGS) throw redactionLimitError();
        });
      }
      if (sourceStrings + sources.length > MAX_SOURCE_STRINGS) throw redactionLimitError();

      const additions = new Set<string>();
      for (const source of sources) {
        if (!source.redact) continue;
        for (const literal of variants(source.value)) if (literal && !literals.has(literal)) additions.add(literal);
      }
      const addedBytes = [...additions].reduce((total, literal) => total + Buffer.byteLength(literal), 0);
      if (literals.size + additions.size > MAX_LITERALS || literalBytes + addedBytes > MAX_LITERAL_BYTES) {
        throw redactionLimitError();
      }
      sourceStrings += sources.length;
      literalBytes += addedBytes;
      for (const literal of additions) literals.add(literal);
      ordered = [...literals].sort((left, right) => right.length - left.length);
    },
    redact,
  };
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
