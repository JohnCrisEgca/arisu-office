// Facebook Pages publishing via the Graph API. Called only after a human has approved the exact text.
export class FbError extends Error {}

const scrubToken = (msg, token) => String(msg).split(token).join('[token hidden]').slice(0, 300);

// Read-only Graph call (used by Kiko's insights and the system check).
export async function graphGet(cfg, path, params, token) {
  const version = cfg.graphVersion ? `/${cfg.graphVersion}` : '';
  const qs = new URLSearchParams({ ...params, access_token: token });
  let res;
  try {
    res = await fetch(`${cfg.graphBase}${version}/${path}?${qs}`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new FbError('Could not reach Facebook.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new FbError(scrubToken(body?.error?.message || `Facebook returned an error (${res.status}).`, token));
  return body;
}

// Recent posts with simple counts. Needs the pages_read_engagement permission on the token.
export async function recentPostStats(cfg, { pageId, token }) {
  const body = await graphGet(cfg, `${encodeURIComponent(pageId)}/posts`, {
    fields: 'message,created_time,shares,likes.limit(0).summary(true),comments.limit(0).summary(true)', limit: '12'
  }, token);
  return (body.data ?? []).map((p) => ({
    posted: p.created_time, text: String(p.message ?? '').slice(0, 280),
    likes: p.likes?.summary?.total_count ?? 0, comments: p.comments?.summary?.total_count ?? 0, shares: p.shares?.count ?? 0
  }));
}

export async function publishToPage(cfg, { pageId, token, message, scheduledAt }) {
  const version = cfg.graphVersion ? `/${cfg.graphVersion}` : '';
  const body = new URLSearchParams({ message, access_token: token });
  if (scheduledAt) {
    body.set('published', 'false');
    body.set('scheduled_publish_time', String(Math.floor(scheduledAt / 1000)));
  }
  let res;
  try {
    res = await fetch(`${cfg.graphBase}${version}/${encodeURIComponent(pageId)}/feed`, {
      method: 'POST', body, signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new FbError('Could not reach Facebook.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const msg = String(data?.error?.message || `Facebook returned an error (${res.status}).`);
    throw new FbError(msg.split(token).join('[token hidden]').slice(0, 300));
  }
  return String(data.id);
}
