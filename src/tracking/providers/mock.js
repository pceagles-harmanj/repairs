'use strict';
/**
 * A carrier that does whatever the tests tell it to. Set TRACKING_PROVIDER=mock
 * and push results with `mock.queue(trackingNumber, result)`.
 */
const queued = new Map();

function queue(trackingNumber, result) {
  queued.set(String(trackingNumber), result);
}

function clear() {
  queued.clear();
}

async function fetchTracking({ trackingNumber }) {
  const key = String(trackingNumber);
  if (!queued.has(key)) return { status: 'unknown', events: [] };
  const result = queued.get(key);
  if (result instanceof Error) throw result;
  return result;
}

module.exports = { name: 'mock', fetchTracking, queue, clear };
