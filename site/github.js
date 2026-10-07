// Deleting files from the photo repository through the GitHub API, all in one commit
// (so a batch of photos triggers a single site rebuild). Works in the browser and in Node.

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Remove `paths` from `branch` in one commit. Paths that are already gone are skipped.
 * Returns { commit, deleted }.
 */
export async function deleteFiles({ token, repo, branch, paths, message }) {
  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new GitHubError(res.status, body?.message || res.statusText);
    return body;
  };
  const ref = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  for (let attempt = 1; ; attempt++) {
    const head = (await api(`/git/ref/${ref}`)).object.sha;
    const commit = await api(`/git/commits/${head}`);
    const tree = await api(`/git/trees/${commit.tree.sha}?recursive=1`);
    const existing = new Set(tree.tree.filter((e) => e.type === 'blob').map((e) => e.path));
    const remove = paths.filter((p) => existing.has(p));
    if (!remove.length) return { commit: null, deleted: [] };
    const newTree = await api('/git/trees', {
      method: 'POST',
      body: JSON.stringify({ base_tree: commit.tree.sha, tree: remove.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })) }),
    });
    const next = await api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });
    try {
      await api(`/git/refs/${ref}`, { method: 'PATCH', body: JSON.stringify({ sha: next.sha, force: false }) });
      return { commit: next.sha, deleted: remove };
    } catch (e) {
      // 422: the branch moved meanwhile (e.g. a photo was uploaded); redo the commit on top of it.
      if (e.status !== 422 || attempt >= 3) throw e;
    }
  }
}
