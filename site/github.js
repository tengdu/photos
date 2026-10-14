// Changes to the photo repository through the GitHub API, each as one commit (so a change rebuilds
// the site once). Works in the browser and in Node.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(token, path, init = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new GitHubError(0, "Couldn't reach GitHub");
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new GitHubError(res.status, body?.message || res.statusText);
  return body;
}

/** Throws unless `token` may change `repo`. */
export async function checkToken(token, repo) {
  const r = await call(token, `/repos/${repo}`);
  if (r.permissions && !r.permissions.push) throw new GitHubError(403, `This token can't change ${repo}`);
}

const repoPath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** A file's current bytes on `branch` (from the API, not the CDN, which may be minutes behind). */
export async function readFile({ token, repo, branch, path }) {
  let res;
  try {
    res = await fetch(`${API}/repos/${repo}/contents/${repoPath(path)}?ref=${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store',
    });
  } catch {
    throw new GitHubError(0, "Couldn't reach GitHub");
  }
  if (!res.ok) throw new GitHubError(res.status, (await res.json().catch(() => null))?.message || res.statusText);
  return new Uint8Array(await res.arrayBuffer());
}

function base64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Uploads bytes as a Git blob (for `put` in commitChanges); returns its sha. */
export async function uploadBlob({ token, repo, bytes }) {
  return (await call(token, `/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: base64(bytes), encoding: 'base64' }) })).sha;
}

/**
 * One commit on `branch` that adds files ({ path, content }), replaces files with uploaded blobs
 * (put: { path, sha }) and removes paths. Files that are already there (or already gone) are not
 * added (removed) again. Returns the commit's sha, or null if there was nothing to change.
 */
export async function commitChanges({ token, repo, branch, add = [], put = [], remove = [], message }) {
  const ref = `heads/${repoPath(branch)}`;
  for (let attempt = 1; ; attempt++) {
    const head = (await call(token, `/repos/${repo}/git/ref/${ref}`)).object.sha;
    const commit = await call(token, `/repos/${repo}/git/commits/${head}`);
    const tree = await call(token, `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
    const existing = new Set(tree.tree.filter((e) => e.type === 'blob').map((e) => e.path));
    const changes = [
      ...add.filter((f) => !existing.has(f.path)).map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content ?? '' })),
      ...put.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha })),
      ...remove.filter((p) => existing.has(p)).map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
    ];
    if (!changes.length) return null;
    const newTree = await call(token, `/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree: changes }) });
    const next = await call(token, `/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }) });
    try {
      await call(token, `/repos/${repo}/git/refs/${ref}`, { method: 'PATCH', body: JSON.stringify({ sha: next.sha, force: false }) });
      return next.sha;
    } catch (e) {
      // 422: the branch moved meanwhile (e.g. a photo was uploaded); redo the commit on top of it.
      if (e.status !== 422 || attempt >= 3) throw e;
    }
  }
}
