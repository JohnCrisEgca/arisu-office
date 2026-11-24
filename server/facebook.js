// Facebook Pages publishing via the Graph API. Called only after a human has approved the exact text.
export class FbError extends Error {}

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
