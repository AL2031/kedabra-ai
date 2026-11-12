import { createHmac } from 'node:crypto';

// One root secret, from which each feature derives its own key. AUTH_SECRET is
// preferred; otherwise the database token (already a secret) is used, so accounts
// work with no extra setup. Changing the root secret signs everyone out.
export const rootSecret = () => process.env.AUTH_SECRET || process.env.TURSO_AUTH_TOKEN || '';
export function appSecret(label) {
  const root = rootSecret();
  return root ? createHmac('sha256', root).update(`kedabra:${label}`).digest('hex') : '';
}
