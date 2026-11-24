// Role -> permission matrix. Every route declares the permission it needs.
// Client-scoping (a client user only sees their own business) is enforced separately in app.js.
const MATRIX = {
  owner: ['users:manage', 'clients:read', 'clients:write', 'pages:connect',
    'drafts:generate', 'drafts:edit', 'drafts:approve', 'drafts:publish',
    'audit:read', 'admin:models'],
  manager: ['clients:read', 'clients:write', 'pages:connect',
    'drafts:generate', 'drafts:edit', 'drafts:approve', 'drafts:publish',
    'audit:read'],
  client: ['clients:read', 'drafts:generate', 'drafts:edit', 'drafts:approve', 'drafts:publish']
};

const SETS = Object.fromEntries(Object.entries(MATRIX).map(([r, p]) => [r, new Set(p)]));

export const can = (role, perm) => Boolean(SETS[role]?.has(perm));
export const ROLES = Object.keys(MATRIX);
