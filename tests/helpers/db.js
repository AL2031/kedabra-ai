// Gives each test file its own throwaway SQLite database. Tests run against the real
// storage code (real SQL), not a mock, so locking and uniqueness rules are really tested.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function useTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'kedabra-test-'));
  process.env.TURSO_DATABASE_URL = 'file:' + join(dir, 'test.db');
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.AUTH_SECRET = 'test-auth-secret';
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function clearTables() {
  const store = await import('../../api/_store.js');
  await store.getUser('__init__');                       // creates the tables on first use
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url: process.env.TURSO_DATABASE_URL });
  await client.batch(['DELETE FROM users', 'DELETE FROM jobs', 'DELETE FROM files'], 'write');
  client.close();
}
