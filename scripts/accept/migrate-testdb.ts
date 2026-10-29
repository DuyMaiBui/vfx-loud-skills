// Migrates the scratch DB named by DATABASE_URL before a suite runs (plan.md D15, phase-1 step 2).
// Refuses (exit 2) unless the database is a scratch DB and DATA_DIR is not the repo data/ directory.
// Exit 0 migrated; 1 migration failed; 2 refused. Run through scripts/accept/with-testdb.sh, never bare.
import { assertScratchDb } from '../../server/src/test-fixtures/scratch-db.ts';

try {
  assertScratchDb();
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const { pool, migrate } = await import('../../server/src/db.ts');
try {
  await migrate();
  console.log('[migrate-testdb] scratch DB migrated');
} catch (err) {
  console.error('[migrate-testdb] migration failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
