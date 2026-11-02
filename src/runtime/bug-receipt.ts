// Publication identity and author trust are validated by the caller.
export function isVerifiedBugReceipt(body: string): boolean {
  const heading = body.split(/\r?\n/).slice(1).find((line) => line.trim().length > 0);
  return heading === "BUG RECEIPT · VERIFIED";
}
