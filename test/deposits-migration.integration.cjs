// Runs only in a new disposable Docker container; never uses DATABASE_URL.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', 'prisma', 'migrations');
const migrationName = '20261104_deposits_module';
const migration = readFileSync(join(root, migrationName, 'migration.sql'), 'utf8');
const container = `foodie-deposits-migration-${process.pid}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function sql(database, input, succeeds = true) {
  const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { input, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (succeeds) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, 'Expected migration failure');
  return result;
}
const fixture = `
CREATE TABLE "Restaurant" ("id" TEXT PRIMARY KEY);
CREATE TABLE "ReservationDeposit" ("id" TEXT PRIMARY KEY);
CREATE TABLE "DepositEntry" ("id" TEXT PRIMARY KEY, "depositId" TEXT);
CREATE TABLE "DepositProof" ("id" TEXT PRIMARY KEY, "entryId" TEXT);
INSERT INTO "Restaurant" VALUES ('restaurant-existing');
INSERT INTO "ReservationDeposit" VALUES ('deposit-existing');
INSERT INTO "DepositEntry" VALUES ('entry-existing', 'deposit-existing');
INSERT INTO "DepositProof" VALUES ('proof-existing', 'entry-existing');
`;

async function main() {
  let started = false;
  try {
    docker('run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine');
    started = true;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) break;
      if (attempt === 59) throw new Error('Disposable PostgreSQL did not start');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    for (const scenario of ['clean', 'legacy', 'partial']) {
      sql('postgres', `CREATE DATABASE ${scenario};`);
      sql(scenario, fixture);
      if (scenario !== 'clean') {
        sql(scenario, `ALTER TABLE "DepositProof" ADD COLUMN "rejectionReason" TEXT;
          UPDATE "DepositProof" SET "rejectionReason" = 'existing review';`);
      }
      if (scenario === 'partial') {
        // Reproduce the original failure, including committed preceding ALTERs.
        const original = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '').replaceAll(' IF NOT EXISTS', '');
        const result = sql(scenario, original, false);
        assert.match(result.stderr, /column "rejectionReason".*already exists/);
      }
      sql(scenario, migration);
      sql(scenario, `DO $$ BEGIN
        IF (SELECT count(*) FROM "DepositProof" WHERE "id" = 'proof-existing' AND "reviewStatus" = 'approved') <> 1
          THEN RAISE EXCEPTION 'Existing proof lost or not migrated'; END IF;
        IF NOT EXISTS (SELECT 1 FROM "DepositEntry" WHERE "id" = 'entry-existing')
          THEN RAISE EXCEPTION 'Existing entry lost'; END IF;
        ${scenario === 'clean' ? '' : `IF (SELECT "rejectionReason" FROM "DepositProof" WHERE "id" = 'proof-existing') IS DISTINCT FROM 'existing review'
          THEN RAISE EXCEPTION 'Legacy rejection reason overwritten'; END IF;`}
        IF to_regclass('"DepositDelivery"') IS NULL OR to_regclass('"DepositUpload"') IS NULL
          THEN RAISE EXCEPTION 'Migration incomplete'; END IF;
      END $$;`);
      console.log(`PASS ${scenario}: migration completed and existing records preserved`);
    }
    sql('postgres', 'CREATE DATABASE atomic_failure;');
    sql('atomic_failure', fixture + 'CREATE TABLE "RestaurantDepositSettings" ("restaurantId" TEXT);');
    sql('atomic_failure', migration, false);
    sql('atomic_failure', `DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ReservationDeposit' AND column_name = 'confirmationAt')
        THEN RAISE EXCEPTION 'Failed migration left partial changes'; END IF;
      IF (SELECT count(*) FROM "DepositProof") <> 1
        THEN RAISE EXCEPTION 'Existing proof lost during rollback'; END IF;
    END $$;`);
    console.log('PASS a later failure rolls back all new migration changes');
  } finally {
    if (started) docker('stop', container);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
