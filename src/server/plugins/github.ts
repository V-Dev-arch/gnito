import { deleteSecret, getSecret, setSecret } from '../security/vault.js';

const GITHUB_SECRET_ID = 'plugin:github:pat';
const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubApiResult {
  status: number;
  headers: Headers;
  data: any;
}

export function getGitHubToken(): string | null {
  return getSecret(GITHUB_SECRET_ID);
}

export function deleteGitHubToken(): void {
  deleteSecret(GITHUB_SECRET_ID);
}

export function setGitHubToken(token: string): void {
  setSecret(GITHUB_SECRET_ID, token);
}

export function validateGitHubToken(token: string): boolean {
  return /^(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]+$/.test(token.trim());
}

export async function githubApiRequest(options: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<GitHubApiResult | { error: string }> {
  const token = getGitHubToken();
  if (!token) return { error: 'GitHub is not connected. Add a GitHub personal access token in Plugins.' };
  if (!/^\/(?!\/)[A-Za-z0-9][A-Za-z0-9/_?.=&%:+,@~-]{0,1900}$/.test(options.path)) {
    return { error: 'GitHub API paths must be relative paths beginning with / and cannot contain a host or protocol.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(`${GITHUB_API_ROOT}${options.path}`, {
      method: options.method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > 2_000_000) return { error: 'GitHub returned a response larger than 2 MB.' };
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { text: text.slice(0, 10_000) }; }
    if (!response.ok) {
      const message = typeof data?.message === 'string' ? data.message.slice(0, 500) : `GitHub returned HTTP ${response.status}.`;
      return { error: `GitHub API request failed (HTTP ${response.status}): ${message}` };
    }
    return { status: response.status, headers: response.headers, data };
  } catch (error: any) {
    if (error?.name === 'AbortError') return { error: 'GitHub API request timed out.' };
    return { error: 'GitHub API request failed. Check the connection and token.' };
  } finally {
    clearTimeout(timer);
  }
}

export function githubScopes(headers: Headers): string[] {
  return (headers.get('x-oauth-scopes') || '').split(',').map(scope => scope.trim()).filter(Boolean);
}
