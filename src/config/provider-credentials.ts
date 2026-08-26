const PROVIDER_TOKEN_ENVIRONMENTS = {
  github: new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]),
  gitlab: new Set(["GITLAB_TOKEN", "OAUTH_TOKEN"]),
} as const;

const GITHUB_PUBLIC_TOKEN_ENVIRONMENTS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);
const GITHUB_ENTERPRISE_TOKEN_ENVIRONMENTS = new Set(["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

export function isProviderTokenEnvironment(provider: "github" | "gitlab", name: string): boolean {
  return PROVIDER_TOKEN_ENVIRONMENTS[provider].has(name);
}

export function isProviderTokenEnvironmentForApiUrl(
  provider: "github" | "gitlab",
  name: string,
  apiUrl: string,
): boolean {
  if (provider === "gitlab") return PROVIDER_TOKEN_ENVIRONMENTS.gitlab.has(name);
  const hostname = new URL(apiUrl).hostname.toLowerCase();
  const publicHost = hostname === "github.com" || hostname === "api.github.com" || hostname.endsWith(".ghe.com");
  return (publicHost ? GITHUB_PUBLIC_TOKEN_ENVIRONMENTS : GITHUB_ENTERPRISE_TOKEN_ENVIRONMENTS).has(name);
}
