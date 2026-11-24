// Deterministic checks that do not depend on the AI. Any "hard" issue blocks approval until a human edits the text.
export function splitList(s) {
  return String(s || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

export function localChecks(text, client) {
  const hard = [];
  const t = String(text || '');
  if (!t.trim()) hard.push('The post is empty.');
  if (t.length > 3000) hard.push('The post is longer than 3000 characters.');
  const lower = t.toLowerCase();
  for (const phrase of splitList(client?.do_not_say)) {
    if (lower.includes(phrase.toLowerCase())) hard.push(`Contains a phrase this brand never uses: "${phrase}".`);
  }
  const placeholder = t.match(/\[[A-Z][A-Z0-9 _-]{2,30}\]/);
  if (placeholder) hard.push(`Unfilled placeholder ${placeholder[0]}. A person must fill it in before approval.`);
  return hard;
}
