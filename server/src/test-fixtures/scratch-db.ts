/**
 * Guard for every DB-backed test added by the self-contained fetch (plan.md D15). Throws unless the
 * database name marks a scratch DB AND DATA_DIR is not the repo `data/` directory (some existing tests
 * `fs.rm` under config.dataDir). A bare run against `vfxcloud` therefore fails loudly instead of
 * writing live rows. Call it first in every new DB-backed test.
 */
import path from 'node:path';
import { config } from '../config.ts';

const SCRATCH_DB_NAME = /_test(_|$)/;

export function assertScratchDb(): void {
  const name = decodeURIComponent(new URL(config.databaseUrl).pathname.replace(/^\//, ''));
  if (!SCRATCH_DB_NAME.test(name)) {
    throw new Error(
      `refusing to run: database "${name}" is not a scratch DB (name must contain "_test"). Run through scripts/accept/with-testdb.sh.`,
    );
  }
  const repoData = path.join(config.repoRoot, 'data');
  if (path.resolve(config.dataDir) === repoData) {
    throw new Error(`refusing to run: DATA_DIR is the repo data/ directory (${repoData}). Set DATA_DIR to a temp dir.`);
  }
}
