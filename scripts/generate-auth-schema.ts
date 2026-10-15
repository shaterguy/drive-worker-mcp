import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { getMigrations } from 'better-auth/db/migration';
import { createSchemaOptions } from './schema-config.ts';

// Run only through the approved MANUAL Termux route. No DATABASE_URL, .env, credentials or auth context.
const root = new URL('../',import.meta.url);
const output = new URL('sql/generated/better-auth-1.7.9.sql',root);
const reportPath = new URL('sql/generated/schema-report.json',root);
const expectedVersions = {
  'better-auth':'1.7.9','@better-auth/core':'1.7.9','@better-auth/mcp':'1.7.9','@better-auth/cimd':'1.7.9',
  '@better-auth/oauth-provider':'1.7.9','kysely':'0.29.6','@electric-sql/pglite':'0.5.10',
  'typescript':'6.0.3',
} as const;
const requiredTables=['user','session','account','verification','jwks','oauthClient','oauthRefreshToken','oauthAccessToken','oauthConsent'];
let stage='package-version-check';
let db: Kysely<unknown> | undefined;

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('NODE_24_REQUIRED');
  for (const [name,expected] of Object.entries(expectedVersions)) {
    const manifest: unknown=JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`,root),'utf8'));
    if (!manifest || typeof manifest!=='object' || !('version' in manifest) || manifest.version!==expected) {
      throw new Error(`PACKAGE_VERSION_MISMATCH:${name}`);
    }
  }
  stage='empty-local-postgres';
  const local=new PGlite();
  db=new Kysely<unknown>({dialect:new PGliteDialect({pglite:local})});
  await local.waitReady;
  if ((await db.introspection.getTables()).filter(table=>table.schema==='public').length) throw new Error('EXPECTED_EMPTY_SCHEMA');
  const options=createSchemaOptions({db,type:'postgres',schemaName:'public'});

  stage='official-schema-compilation';
  const plan=await getMigrations(options);
  const tableNames=plan.toBeCreated.map(table=>table.table).sort();
  if (plan.unsafeChanges.length || plan.schemaProblems.length || !requiredTables.every(table=>tableNames.includes(table))) {
    throw new Error('UNEXPECTED_GENERATED_SCHEMA');
  }
  const generated=await plan.compileMigrations();
  if (generated.trim()===';') throw new Error('EMPTY_GENERATED_SCHEMA');

  // Validate the exact compiled bytes using an isolated WASM PostgreSQL instance, then introspect again.
  stage='local-official-schema-roundtrip';
  await local.exec(generated);
  const after=await getMigrations(options);
  if (after.toBeCreated.length || after.toBeAdded.length || after.toBeAddedIndexes.length ||
      after.unsafeChanges.length || after.schemaProblems.length || (await after.compileMigrations()).trim()!==';') {
    throw new Error('SCHEMA_ROUNDTRIP_MISMATCH');
  }
  const authColumns=(await local.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
  const authConstraints=(await local.query(`SELECT c.relname AS table_name,k.conname,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,k.conname`)).rows;

  stage='local-app-schema';
  const appSql=await readFile(new URL('sql/auth.sql',root),'utf8');
  const coreSql=await readFile(new URL('sql/core.sql',root),'utf8');
  await local.exec(appSql);
  await local.exec(coreSql);
  const triggers=(await local.query(`SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
  const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
  const report={
    status:'LOCAL_SCHEMA_ONLY_PASS',node:process.versions.node,versions:expectedVersions,
    database:'isolated-in-memory-pglite',production_database_contacted:false,auth_context_started:false,
    better_auth_sql_sha256:sha256(generated),app_auth_sql_sha256:sha256(appSql),core_sql_sha256:sha256(coreSql),
    official_roundtrip_empty:true,app_ddl_applied_locally:true,tableNames,authColumns,authConstraints,triggers,
    two_connection_race_tested:false,google_oauth_tested:false,chatgpt_compatibility_tested:false,user_ready:false,
  };
  stage='write-review-artifacts';
  await mkdir(new URL('sql/generated/',root),{recursive:true});
  // Exclusive writes: do not silently replace a previously reviewed migration.
  await writeFile(output,generated,{encoding:'utf8',flag:'wx'});
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify({status:report.status,sql:fileURLToPath(output),report:fileURLToPath(reportPath),sha256:report.better_auth_sql_sha256,user_ready:false}));
} catch (error) {
  // No arbitrary error bodies or environment values in command output.
  const code=error && typeof error==='object' && 'code' in error && typeof error.code==='string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  const reason=error instanceof Error && /^(NODE_24_REQUIRED|EXPECTED_EMPTY_SCHEMA|UNEXPECTED_GENERATED_SCHEMA|EMPTY_GENERATED_SCHEMA|SCHEMA_ROUNDTRIP_MISMATCH|PACKAGE_VERSION_MISMATCH:[@a-z0-9/-]+)$/.test(error.message) ? error.message : undefined;
  console.error(JSON.stringify({status:'AUTH_SCHEMA_GENERATION_FAILED',stage,...(code?{code}:{}),...(reason?{reason}:{}),user_ready:false}));
  process.exitCode=1;
} finally {
  await db?.destroy();
}
