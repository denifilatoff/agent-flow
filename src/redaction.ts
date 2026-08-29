export type SecretRedactor = (value: string) => string;

export interface StartupRedactor {
  register(value: string | Buffer): void;
  redact: SecretRedactor;
}

export function createStartupRedactor(): StartupRedactor {
  const literals = new Set<string>();

  const add = (value: string): void => {
    if (!value) return;
    for (const literal of [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("hex"),
    ]) if (literal) literals.add(literal);
  };

  const redact: SecretRedactor = (value) => {
    let result = value;
    for (const literal of [...literals].sort((left, right) => right.length - left.length)) {
      result = result.split(literal).join("[REDACTED]");
    }
    return result;
  };

  return {
    register(value) {
      const text = typeof value === "string" ? value : value.toString("utf8");
      add(text);
      if (typeof value !== "string") {
        const trimmed = text.trim();
        if (trimmed !== text) add(trimmed);
        try {
          visitStrings(JSON.parse(text), (candidate) => {
            if (candidate.trim().length >= 4) add(candidate);
          });
        } catch {
          // Opaque credential files are still covered by their exact bytes and literal encodings.
        }
      }
    },
    redact,
  };
}

function visitStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) visitStrings(item, visit);
  }
}
