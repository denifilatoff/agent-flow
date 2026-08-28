export function providerTokenEnvironment(provider: "github" | "gitlab", apiUrl: string): string {
  if (provider === "gitlab") return "GITLAB_TOKEN";
  const hostname = new URL(apiUrl).hostname.toLowerCase();
  return hostname === "github.com" || hostname === "api.github.com" || hostname.endsWith(".ghe.com")
    ? "GH_TOKEN"
    : "GH_ENTERPRISE_TOKEN";
}

export function isProviderTokenEnvironment(provider: "github" | "gitlab", name: string): boolean {
  return provider === "gitlab" ? name === "GITLAB_TOKEN" : name === "GH_TOKEN" || name === "GH_ENTERPRISE_TOKEN";
}
