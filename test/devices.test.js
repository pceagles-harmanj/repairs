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

// ---- the request Google actually accepts -----------------------------------

test('device list requests never carry an orderBy Google would reject', () => {
  // The Admin SDK 400s on anything outside this set: "Invalid value at 'order_by'".
  assert.deepEqual(google.VALID_ORDER_BY.slice().sort(), [
    'annotatedLocation', 'annotatedUser', 'lastSync', 'notes', 'serialNumber', 'status', 'supportEndDate',
  ]);

  // annotatedAssetId is the tempting one, and it is not allowed.
  const dropped = google.deviceListParams({ orderBy: 'annotatedAssetId' });
  assert.equal('orderBy' in dropped, false);
  assert.equal('sortOrder' in dropped, false);

  const kept = google.deviceListParams({ orderBy: 'lastSync', sortOrder: 'DESCENDING' });
  assert.equal(kept.orderBy, 'lastSync');
  assert.equal(kept.sortOrder, 'DESCENDING');
});

test('the loaner query is scoped to the org unit and sorted newest first', () => {
  const params = google.deviceListParams({
    query: 'asset_id:Loaner-012',
    orgUnitPath: '/Devices/Loaners',
    maxResults: 25,
    orderBy: 'lastSync',
    sortOrder: 'DESCENDING',
  });
  assert.equal(params.customerId, 'my_customer');
  assert.equal(params.projection, 'FULL');
  assert.equal(params.orgUnitPath, '/Devices/Loaners');
  assert.equal(params.query, 'asset_id:Loaner-012');
  // lastSync IS sortable (annotatedAssetId is not), so let Google do this part.
  assert.equal(params.orderBy, 'lastSync');
  assert.equal(params.sortOrder, 'DESCENDING');
});

test('asset tag is still refused as an orderBy, since Google rejects it', () => {
  const params = google.deviceListParams({ orderBy: 'annotatedAssetId', sortOrder: 'ASCENDING' });
  assert.equal('orderBy' in params, false);
  assert.equal('sortOrder' in params, false, 'sortOrder goes with it');
});

test('sortOrder alone is dropped - it is only valid with an orderBy', () => {
  const params = google.deviceListParams({ sortOrder: 'DESCENDING' });
  assert.equal('sortOrder' in params, false);
});

// ---- newest first ----------------------------------------------------------

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const synced = (asset, serial, lastSync) => ({ ...dev(asset, serial), last_sync: lastSync });

test('devices of equal match quality come back most recently synced first', () => {
  const ranked = google.rankDevices('24-', [
    synced('24-100', 'A', ago(30)),
    synced('24-200', 'B', ago(1)),
    synced('24-300', 'C', ago(9)),
  ]);
  assert.deepEqual(ranked.map((d) => d.asset_tag), ['24-200', '24-300', '24-100']);
});

test('a fresher near-match never outranks the exact tag', () => {
  // The whole point of the earlier ranking fix: typing 24-1 must land on 24-1
  // even when 24-111 synced this morning and 24-1 has been in a drawer.
  const ranked = google.rankDevices('24-1', [
    synced('24-111', 'FRESH', ago(0)),
    synced('24-1', 'OLD', ago(60)),
  ]);
  assert.equal(ranked[0].asset_tag, '24-1');
  assert.equal(ranked[0].match, 'exact_asset_tag');
});

test('a device that has never synced sorts last rather than first', () => {
  const ranked = google.rankDevices('24-', [
    { ...dev('24-900', 'NOSYNC'), last_sync: null },
    synced('24-901', 'B', ago(21)),
  ]);
  assert.equal(ranked[0].asset_tag, '24-901');
  assert.equal(google.syncedAt({ last_sync: null }), 0);
  assert.equal(google.syncedAt({ last_sync: 'not a date' }), 0, 'garbage from Google is not a future date');
});

test('policy sync and OS version survive normalisation', () => {
  const d = google.normalizeDevice({
    deviceId: 'abc', serialNumber: 'S1', annotatedAssetId: '24-1',
    lastSync: '2026-08-30T14:02:00.000Z', osVersion: '128.0.6613.137',
    recentUsers: [{ email: 'sam@example.org' }],
  });
  assert.equal(d.last_sync, '2026-08-30T14:02:00.000Z');
  assert.equal(d.os_version, '128.0.6613.137');
});
