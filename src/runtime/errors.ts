import { ApmPreflightError } from "../harness/apm.ts";
import { HarnessPreflightError, HarnessProcessError } from "../harness/process.ts";
import { ProviderHttpError } from "../provider/http.ts";
import type { ReceiptError } from "../config/types.js";
import { InvalidReceiptError } from "./receipts.ts";

export class AttemptError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "AttemptError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function classifyAttemptError(error: unknown): AttemptError {
  if (error instanceof AttemptError) return error;
  if (error instanceof ProviderHttpError) {
    return new AttemptError(
      error.transient ? "PROVIDER_TRANSIENT" : "PROVIDER_FAILED",
      "provider operation failed",
      error.transient,
    );
  }
  if (error instanceof HarnessProcessError) {
    return new AttemptError(error.code, "harness process failed", error.retryable);
  }
  if (error instanceof HarnessPreflightError) {
    return new AttemptError(error.code, "harness preflight failed", false);
  }
  if (error instanceof ApmPreflightError) {
    return new AttemptError(error.code, "APM preflight failed", false);
  }
  if (error instanceof InvalidReceiptError) {
    return new AttemptError(error.code, "agent receipt could not be verified", false);
  }
  return new AttemptError("ATTEMPT_CONFIGURATION_FAILED", "attempt configuration failed", false);
}

export function controlError(error: AttemptError): ReceiptError {
  return {
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "ATTEMPT_FAILED",
    message: clean(error.message),
  };
}

function clean(message: string): string {
  const value = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 240);
  return value || "attempt failed";
}
