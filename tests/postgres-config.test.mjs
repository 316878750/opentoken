import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresConnectionOptions } from '../lib/postgres-config.mjs';

const remote = 'postgresql://opentoken_app.fixture:example-password@pooler.example.test:5432/postgres';
const ca = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n';

test('hosted database options retain certificate and hostname verification', () => {
  const config = postgresConnectionOptions(remote+'?sslmode=verify-full',{application:true,caBase64:Buffer.from(ca).toString('base64')});
  assert.equal(config.connectionString,remote);
  assert.deepEqual(config.ssl,{ca,rejectUnauthorized:true,servername:'pooler.example.test'});
});

test('connection configuration rejects weak TLS and invalid production roles', () => {
  assert.throws(()=>postgresConnectionOptions(remote),/verify-full/);
  assert.throws(()=>postgresConnectionOptions(remote+'?sslmode=require'),/verify-full/);
  assert.throws(()=>postgresConnectionOptions(remote.replace('opentoken_app','postgres')+'?sslmode=verify-full',{application:true}),/opentoken_app/);
  assert.throws(()=>postgresConnectionOptions(remote+'?sslmode=verify-full',{caBase64:'bad'}),/DATABASE_CA_BASE64/);
  const source = 'postgresql://pilot@127.0.0.1:5432/postgres';
  assert.deepEqual(postgresConnectionOptions(source,{application:true}),{connectionString:source});
});
