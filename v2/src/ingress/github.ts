import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import type { Config } from '../config.ts';
import type { Store } from '../queue/store.ts';
import type { ReviewRequest } from '../types.ts';
import type { Logger } from '../log.ts';

/** Where GitHub credentials come from. The engine never posts as a person in production. */
export interface GitHubAuth {
  mode: 'app' | 'token';
  octokitFor(repo: string): Promise<Octokit>;
  /** Short-lived token for git over HTTPS to this repository. */
  gitTokenFor(repo: string): Promise<string>;
  botLogin(): Promise<string | null>;
  installationIdFor(repo: string): Promise<number | null>;
}

export function githubAuthFromEnv(config: Config, env = process.env): GitHubAuth {
  const pem = env[config.github.privateKeyEnv];
  if (config.github.appId && pem) {
    const app = new App({ appId: config.github.appId, privateKey: pem, Octokit });
    const installations = new Map<string, number>();
    const resolveInstallation = async (repo: string): Promise<number> => {
      const hit = installations.get(repo);
      if (hit) return hit;
      const [owner, name] = repo.split('/') as [string, string];
      const { data } = await app.octokit.rest.apps.getRepoInstallation({ owner, repo: name });
      installations.set(repo, data.id);
      return data.id;
    };
    let slug: string | null = null;
    return {
      mode: 'app',
      octokitFor: async (repo) => (await app.getInstallationOctokit(await resolveInstallation(repo))) as unknown as Octokit,
      gitTokenFor: async (repo) => {
        const id = await resolveInstallation(repo);
        const { data } = await app.octokit.rest.apps.createInstallationAccessToken({ installation_id: id, repositories: [repo.split('/')[1]!], permissions: { contents: 'read' } });
        return data.token;
      },
      botLogin: async () => {
        if (slug) return slug;
        const { data } = await app.octokit.rest.apps.getAuthenticated();
        slug = data ? `${data.slug}[bot]` : null;
        return slug;
      },
      installationIdFor: resolveInstallation,
    };
  }
  const token = env[config.github.tokenEnv];
  if (!token) throw new Error(`No GitHub credentials: set ${config.github.privateKeyEnv} with github.appId, or ${config.github.tokenEnv} for token mode.`);
  const octokit = new Octokit({ auth: token });
  let login: string | null = null;
  return {
    mode: 'token',
    octokitFor: async () => octokit,
    gitTokenFor: async () => token,
    botLogin: async () => { if (login) return login; const { data } = await octokit.users.getAuthenticated(); login = data.login; return login; },
    installationIdFor: async () => null,
  };
}

export function parsePullUrl(url: string): { repo: string; number: number } {
  const m = url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!m) throw new Error('Expected a GitHub pull request URL.');
  return { repo: m[1]!, number: Number(m[2]) };
}

/**
 * Polling ingress: works behind NAT with no inbound URL, which is the fleet-Mac default. Webhooks are an
 * optional accelerator; both feed the same queue, so running both is harmless.
 */
export async function pollRepository(auth: GitHubAuth, store: Store, repo: string, log: Logger): Promise<number> {
  const octokit = await auth.octokitFor(repo);
  const [owner, name] = repo.split('/') as [string, string];
  const cursorKey = `poll:${repo}`;
  const since = store.cursor(cursorKey) ?? new Date(Date.now() - 60 * 60_000).toISOString();
  const pulls = await octokit.paginate(octokit.pulls.list, { owner, repo: name, state: 'open', sort: 'updated', direction: 'desc', per_page: 100 }, (response, done) => {
    if (response.data.some((p) => p.updated_at <= since)) done();
    return response.data;
  });
  let newest = since;
  let queued = 0;
  for (const p of pulls) {
    if (p.updated_at <= since) continue;
    if (p.updated_at > newest) newest = p.updated_at;
    if (p.draft || p.user?.type === 'Bot') continue;
    const request: ReviewRequest = {
      repo, number: p.number, headSha: p.head.sha, baseSha: p.base.sha, baseRef: p.base.ref, trigger: 'poll',
      installationId: (await auth.installationIdFor(repo)) ?? undefined, receivedAt: new Date().toISOString(),
    };
    const { created } = store.enqueue(request);
    if (created) { queued++; log.info({ repo, number: p.number, head: p.head.sha }, 'queued from poll'); }
  }
  store.setCursor(cursorKey, newest);
  return queued;
}
