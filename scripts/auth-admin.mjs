// Admin recovery for accounts (there is no email-based password reset).
//
//   npx vercel env pull .env.local
//   NEW_PASSWORD='a-new-password' node --env-file=.env.local scripts/auth-admin.mjs reset <username>
//
// The script needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (pulled by the command above).
import { setPassword, normalizeUsername } from '../api/_auth.js';
import { storeConfigured } from '../api/_store.js';

const [command, rawUsername] = process.argv.slice(2);
if (command !== 'reset' || !rawUsername) {
  console.error('Usage: NEW_PASSWORD=... node --env-file=.env.local scripts/auth-admin.mjs reset <username>');
  process.exit(2);
}
if (!storeConfigured()) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, e.g. with `npx vercel env pull .env.local`.');
  process.exit(2);
}
const password = process.env.NEW_PASSWORD;
if (!password) { console.error('Provide the new password in the NEW_PASSWORD environment variable.'); process.exit(2); }

try {
  const ok = await setPassword(normalizeUsername(rawUsername), password);
  console.log(ok ? `Password reset for "${normalizeUsername(rawUsername)}". Any lockout was cleared.` : `No account named "${normalizeUsername(rawUsername)}".`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error('Failed:', error.message);
  process.exit(1);
}
