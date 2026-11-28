import assert from 'node:assert/strict';
import test from 'node:test';
import {catalogPrice,guidePath} from '../lib/catalog-display.ts';

test('catalog group unit prices retain sub-micro precision and large integer rates',()=>{
  assert.equal(catalogPrice('300000',9000),'USD 0.27');
  assert.equal(catalogPrice('1',1),'USD 0.0000000001');
  assert.equal(catalogPrice('9007199254740993',10000),'USD 9007199254.740993');
  assert.equal(catalogPrice('0',10000),'USD 0.00');
});

test('a catalog link carries only its selected model and group to the local guide',()=>{
  const selected = {model:'demo-model',groupId:'group-a'};
  const url = new URL(guidePath(selected),'https://local.example');
  assert.equal(url.pathname,'/keys');
  assert.equal(url.hash,'#connection-guide');
  assert.deepEqual(Object.fromEntries(url.searchParams),selected);
});
