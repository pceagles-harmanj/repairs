'use strict';
/** Asset-tag ranking: Google matches by prefix, we must surface the exact device. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate } = require('./helpers');

isolate();
const google = require('../src/google');

const dev = (asset, serial, users = []) => ({ asset_tag: asset, serial, recent_users: users, annotated_user: users[0] || null });

test('an exact asset tag beats the prefix matches Google returns', () => {
  const hits = [dev('24-111', 'SER111'), dev('24-214', 'SER214'), dev('24-1', 'SER1'), dev('24-1000', 'SERX')];
  const ranked = google.rankDevices('24-1', hits);
  assert.equal(ranked[0].asset_tag, '24-1');
  assert.equal(ranked[0].match, 'exact_asset_tag');
  assert.equal(ranked[0].exact, true);
  assert.ok(ranked.slice(1).every((d) => d.exact === false));
});

test('the second collision case from the field: 24-21 vs 24-214', () => {
  const ranked = google.rankDevices('24-21', [dev('24-214', 'A'), dev('24-21', 'B'), dev('24-210', 'C')]);
  assert.deepEqual(ranked.map((d) => d.asset_tag), ['24-21', '24-210', '24-214']);
  assert.equal(ranked[0].exact, true);
});

test('with no exact match, prefix hits are ordered shortest first', () => {
  const ranked = google.rankDevices('24-1', [dev('24-1999', 'A'), dev('24-11', 'B'), dev('24-134', 'C')]);
  assert.deepEqual(ranked.map((d) => d.asset_tag), ['24-11', '24-134', '24-1999']);
  assert.ok(ranked.every((d) => !d.exact));
});

test('a serial paste is recognised as an exact serial match', () => {
  const ranked = google.rankDevices('5cd1234abc', [dev('PC-9', 'OTHER'), dev('PC-1', '5CD1234ABC')]);
  assert.equal(ranked[0].match, 'exact_serial');
  assert.equal(ranked[0].serial, '5CD1234ABC');
});

test('an email search is labelled as a user match', () => {
  const ranked = google.rankDevices('sam@example.org', [dev('PC-1', 'S1', ['sam@example.org'])]);
  assert.equal(ranked[0].match, 'user');
});

test('case and whitespace do not matter', () => {
  assert.equal(google.classifyMatch(' 24-1 ', dev('24-1', 'S')), 'exact_asset_tag');
  assert.equal(google.classifyMatch('pc-1', dev('PC-1', 'S')), 'exact_asset_tag');
});

test('devices with no asset tag are not crashed on', () => {
  const ranked = google.rankDevices('24-1', [dev(null, null), dev('24-1', 'S')]);
  assert.equal(ranked[0].asset_tag, '24-1');
});
