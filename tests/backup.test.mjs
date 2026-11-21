import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { backupTables, decodeBackup, encodeBackup, postgresEndpoint, restoreTarget } from '../scripts/backup.mjs';

test('backup encrypts binary archive and manifest, rejecting modified bytes or the wrong key', () => {
  const key = randomBytes(32);
  const archive = Buffer.concat([Buffer.from('PGDMP owner@example.test'), randomBytes(128)]);
  const manifest = { createdAt:'2026-11-20T00:00:00.000Z', fingerprint:'sensitive-demo' };
  const encrypted = encodeBackup(key, manifest, archive);
  assert.equal(encrypted.includes(archive), false);
  assert.equal(encrypted.includes(manifest.fingerprint), false);
  assert.deepEqual(decodeBackup(key, encrypted), {manifest, archive});
  assert.notDeepEqual(encodeBackup(key, manifest, archive), encrypted);
  const altered = Buffer.from(encrypted);
  altered[altered.length - 10] ^= 1;
  for (const [candidateKey, candidate] of [[key, altered], [randomBytes(32), encrypted], [key, encrypted.subarray(0, -2)]]) {
    assert.throws(() => decodeBackup(candidateKey, candidate), /authenticate/);
  }
});

test('restoring onto a source endpoint or an unmarked target is blocked', () => {
  const source = postgresEndpoint('postgresql://postgres.abcdefghijklmnopqrst:fake@aws-0-region.pooler.supabase.com/postgres?sslmode=verify-full');
  assert.throws(() => restoreTarget('postgresql://admin:fake@localhost/postgres', source), /opentoken_restore_/);
  assert.throws(() => restoreTarget('postgresql://admin:fake@restore.example.test/opentoken_restore_test?sslmode=verify-full', source), /Supabase project/);
  assert.throws(() => restoreTarget('postgresql://postgres:fake@db.abcdefghijklmnopqrst.supabase.co/postgres?sslmode=verify-full', source), /source project/);
  assert.throws(() => restoreTarget('postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:fake@aws-0-region.pooler.supabase.com/postgres?sslmode=verify-full', source), /confirm/);
  assert.equal(restoreTarget('postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:fake@aws-0-region.pooler.supabase.com/postgres?sslmode=verify-full', source, 'aaaaaaaaaaaaaaaaaaaa').project, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(restoreTarget('postgresql://admin:fake@127.0.0.1:55432/opentoken_restore_test', source).local, true);
});

test('remote database connection values require TLS hostname verification', () => {
  assert.throws(() => postgresEndpoint('postgresql://u:p@db.example.test/postgres?sslmode=require'), /verify-full/);
  assert.throws(() => postgresEndpoint('postgresql://u:p@db.example.test/postgres?sslmode=verify-full&options=secret'), /plain PostgreSQL/);
  assert.equal(postgresEndpoint('postgresql://u:p%40ss@db.example.test/postgres?sslmode=verify-full').password, 'p@ss');
});

test('a hosted recovery drill requires a local fixture and explicit confirmation of the target', () => {
  const source = postgresEndpoint('postgresql://admin:fake@localhost/opentoken_restore_fixture_test');
  const target = 'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:fake@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=verify-full';
  const project = 'aaaaaaaaaaaaaaaaaaaa';
  const fixture = {identity:source.identity, drillFixture:true};
  assert.throws(() => restoreTarget(target, fixture, project), /Supabase project/);
  assert.throws(() => restoreTarget(target, fixture, undefined, {drill:true}), /confirm/);
  assert.throws(() => restoreTarget(target, {identity:source.identity}, project, {drill:true}), /fixture/);
  assert.throws(() => restoreTarget(target, {...fixture, project:'bbbbbbbbbbbbbbbbbbbb'}, project, {drill:true}), /fixture/);
  assert.equal(restoreTarget(target, fixture, project, {drill:true}).project, project);
});

test('legacy and Stripe snapshots validate their explicit migration inventories', () => {
  const pilot = ['001','002','003','004'];
  assert.equal(backupTables(pilot).length,14);
  assert.deepEqual(backupTables([...pilot,'005']).filter(table=>table.includes('stripe')),
    ['gateway.stripe_events','gateway.stripe_orders','gateway.stripe_sandbox']);
  assert.equal(backupTables([...pilot,'005','006']).length,20);
  assert.equal(backupTables([...pilot,'005','006','007']).length,22);
  assert.deepEqual(backupTables([...pilot,'005','006','007','008']).filter(table=>/admin_|login_events/.test(table)),
    ['gateway.admin_audit_events','gateway.admin_roles','gateway.login_events']);
  assert.deepEqual(backupTables([...pilot,'005','006','007','008','009']),backupTables([...pilot,'005','006','007','008']));
  assert.deepEqual(backupTables([...pilot,'005','006','007','008','009','010']).filter(table=>table.startsWith('gateway.channel')),
    ['gateway.channel_probes','gateway.channel_routes','gateway.channel_versions','gateway.channels']);
  assert.deepEqual(backupTables([...pilot,'005','006','007','008','009','010','011']),
    backupTables([...pilot,'005','006','007','008','009','010']));
  assert.deepEqual(
    backupTables([...pilot,'005','006','007','008','009','010','011','012']).filter(table=>/account_states|admin_user_invites/.test(table)),
    ['gateway.account_states','gateway.admin_user_invites']);
  assert.deepEqual(backupTables([...pilot,'005','006','007','008','009','010','011','012','013']),
    backupTables([...pilot,'005','006','007','008','009','010','011','012']));
  assert.throws(()=>backupTables([...pilot,'999']),/Unsupported migration/);
});
