'use strict';

const assert = require('node:assert/strict');
const { validateImport, MAX_ISSUES } = require('../import-validate.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`not ok - ${name}`);
    console.log(`    ${err.message}`);
  }
}

function hasIssue(issues, expectedPath, messageIncludes) {
  return issues.some(
    (issue) => issue.path === expectedPath && (!messageIncludes || issue.message.includes(messageIncludes))
  );
}

function buildValidPayload() {
  return {
    trip: {
      trip: { name: 'Test Trip', destination: 'Nowhere', startDate: '2026-01-01', endDate: '2026-01-10' },
      trains: [{ id: 't1' }, { id: 't2' }],
      calendar: [
        { id: 'c1', date: '2026-01-02', type: 'activity' },
        { id: 'c2', date: '2026-01-03', type: 'activity' },
      ],
    },
    accommodations: [
      { id: 'a1', check_in: '2026-01-01', check_out: '2026-01-05' },
      { id: 'a2', check_in: '2026-01-05', check_out: '2026-01-10' },
    ],
    flights: [
      { id: 'f1', flightNumber: 'AA100', departureDate: '2026-01-01' },
    ],
    flighty: 'x'.repeat(2000),
    documents: [
      { id: 'd1', title: 'Passport', filename: 'passport.pdf', valid_from: '2026-01-01', valid_to: '2030-01-01' },
    ],
  };
}

test('fully valid payload is ok with correct summary counts', () => {
  const result = validateImport(buildValidPayload());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.summary.stores, {
    trip: { calendar: 2, trains: 2 },
    accommodations: 2,
    flights: 1,
    documents: 1,
    flighty: 2000,
  });
  assert.deepEqual(result.summary.skipped, []);
  assert.deepEqual(result.summary.unknown, []);
});

test('a payload with only some importable keys is ok', () => {
  const result = validateImport({ accommodations: buildValidPayload().accommodations });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.stores, { accommodations: 2 });
});

test('budget and wishlist are recognised and skipped', () => {
  const payload = { ...buildValidPayload(), budget: { total: 1000 }, wishlist: [{ id: 'w1' }] };
  const result = validateImport(payload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.skipped.slice().sort(), ['budget', 'wishlist']);
  assert.equal('budget' in result.summary.stores, false);
  assert.equal('wishlist' in result.summary.stores, false);
});

test('a typo\'d key is rejected and reported as unknown', () => {
  const result = validateImport({ acommodations: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.unknown, ['acommodations']);
  assert.ok(hasIssue(result.issues, 'acommodations', 'Unknown key'));
});

test('flighty without flights is rejected', () => {
  const result = validateImport({ flighty: 'x'.repeat(10) });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.message.includes('flighty') && i.message.includes('flights')));
});

test('flights without flighty is rejected', () => {
  const result = validateImport({
    flights: [{ id: 'f1', flightNumber: 'AA1', departureDate: '2026-01-01' }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.message.includes('flighty') && i.message.includes('flights')));
});

test('duplicate ids in accommodations are rejected', () => {
  const payload = buildValidPayload();
  payload.accommodations = [
    { id: 'dup', check_in: '2026-01-01', check_out: '2026-01-02' },
    { id: 'dup', check_in: '2026-01-03', check_out: '2026-01-04' },
  ];
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'accommodations[1].id', 'Duplicate'));
});

test('duplicate ids in flights are rejected', () => {
  const payload = buildValidPayload();
  payload.flights = [
    { id: 'dup', flightNumber: 'AA1', departureDate: '2026-01-01' },
    { id: 'dup', flightNumber: 'AA2', departureDate: '2026-01-02' },
  ];
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'flights[1].id', 'Duplicate'));
});

test('duplicate ids in documents are rejected', () => {
  const payload = buildValidPayload();
  payload.documents = [
    { id: 'dup', title: 'A', filename: 'a.pdf', valid_from: '2026-01-01', valid_to: '2026-01-02' },
    { id: 'dup', title: 'B', filename: 'b.pdf', valid_from: '2026-01-01', valid_to: '2026-01-02' },
  ];
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'documents[1].id', 'Duplicate'));
});

test('duplicate ids in trip.calendar are rejected', () => {
  const payload = buildValidPayload();
  payload.trip.calendar = [
    { id: 'dup', date: '2026-01-01', type: 'activity' },
    { id: 'dup', date: '2026-01-02', type: 'activity' },
  ];
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.calendar[1].id', 'Duplicate'));
});

test('duplicate ids in trip.trains are rejected', () => {
  const payload = buildValidPayload();
  payload.trip.trains = [{ id: 'dup' }, { id: 'dup' }];
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.trains[1].id', 'Duplicate'));
});

test('a missing required field at a known index reports the exact path', () => {
  const payload = buildValidPayload();
  payload.accommodations[1] = { check_in: '2026-01-05', check_out: '2026-01-10' };
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'accommodations[1].id'));
});

test('an invalid date like 2026-02-31 is rejected', () => {
  const payload = buildValidPayload();
  payload.accommodations[0].check_in = '2026-02-31';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'accommodations[0].check_in'));
});

test('check_out before check_in is rejected', () => {
  const payload = buildValidPayload();
  payload.accommodations[0].check_in = '2026-01-10';
  payload.accommodations[0].check_out = '2026-01-01';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'accommodations[0]', 'check_in'));
});

test('an empty object is rejected without throwing', () => {
  const result = validateImport({});
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.stores, {});
});

test('null is rejected without throwing', () => {
  const result = validateImport(null);
  assert.equal(result.ok, false);
});

test('an array is rejected without throwing', () => {
  const result = validateImport([]);
  assert.equal(result.ok, false);
});

test('a string is rejected without throwing', () => {
  const result = validateImport('nope');
  assert.equal(result.ok, false);
});

test('more than MAX_ISSUES failures caps issues and sets truncated', () => {
  const payload = { accommodations: Array.from({ length: 25 }, () => ({})) };
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, MAX_ISSUES);
  assert.equal(result.truncated, true);
});

test('an empty accommodations array is a valid wipe', () => {
  const result = validateImport({ accommodations: [] });
  assert.equal(result.ok, true);
  assert.equal(result.summary.stores.accommodations, 0);
});

test('a document filename with a ../ prefix is rejected', () => {
  const payload = buildValidPayload();
  payload.documents[0].filename = '../../auth.js';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'documents[0].filename', 'plain file name'));
});

test('a document filename with a nested path is rejected', () => {
  const payload = buildValidPayload();
  payload.documents[0].filename = 'a/b.pdf';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'documents[0].filename', 'plain file name'));
});

test('a document filename of .. is rejected', () => {
  const payload = buildValidPayload();
  payload.documents[0].filename = '..';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'documents[0].filename', 'plain file name'));
});

test('a document filename containing a backslash is rejected', () => {
  const payload = buildValidPayload();
  payload.documents[0].filename = '..\\..\\auth.js';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'documents[0].filename', 'plain file name'));
});

test('a document filename starting with a dot is rejected', () => {
  const payload = buildValidPayload();
  payload.documents[0].filename = '.env';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'documents[0].filename', 'plain file name'));
});

test('a trip store without trip.trip is rejected', () => {
  const result = validateImport({ trip: { calendar: [] } });
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.trip', 'must be an object'));
});

test('a trip.trip of the wrong type is rejected', () => {
  const payload = buildValidPayload();
  payload.trip.trip = 'nope';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.trip', 'must be an object'));
});

test('trip.trip without valid start and end dates is rejected', () => {
  const payload = buildValidPayload();
  payload.trip.trip = { name: 'Test Trip', startDate: '2026-02-31', endDate: 'soon' };
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.trip.startDate'));
  assert.ok(hasIssue(result.issues, 'trip.trip.endDate'));
});

test('trip.trip with endDate before startDate is rejected', () => {
  const payload = buildValidPayload();
  payload.trip.trip.startDate = '2026-01-10';
  payload.trip.trip.endDate = '2026-01-01';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.trip', 'startDate must be on or before endDate'));
});

test('a trip.calendar of the wrong type is rejected', () => {
  const payload = buildValidPayload();
  payload.trip.calendar = { nope: true };
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.calendar', 'must be an array'));
});

test('a trip.trains of the wrong type is rejected', () => {
  const payload = buildValidPayload();
  payload.trip.trains = 'nope';
  const result = validateImport(payload);
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip.trains', 'must be an array'));
});

test('an empty trip object is rejected', () => {
  const result = validateImport({ trip: {} });
  assert.equal(result.ok, false);
  assert.ok(hasIssue(result.issues, 'trip', 'must contain calendar, trains, or trip'));
  assert.ok(hasIssue(result.issues, 'trip.trip', 'must be an object'));
});

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
