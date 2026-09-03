'use strict';
/**
 * One parcel, one carrier, one API.
 *
 * Parts arrive on whatever the vendor felt like using, so this picks the right
 * carrier's own (free) API per shipment instead of paying an aggregator to do
 * the same routing.
 *
 * Two deliberate behaviours:
 *
 * 1. The tracking NUMBER decides, not the label on the shipment. A vendor may
 *    say "Amazon" and hand over a 1Z number, because Amazon put it on UPS. The
 *    number's format is the harder fact, so it wins where the two disagree.
 *
 * 2. Amazon Logistics (TBA...) has no public tracking API - the Amazon Shipping
 *    API is for merchants who ship *with* Amazon, not for customers tracking
 *    what they bought. Rather than pretending, those shipments are left for a
 *    human to move along, and the reason is reported so the UI can say so.
 */
const config = require('./../../config');
const { detectCarrier } = require('./../carriers');

const PROVIDERS = {
  ups: () => require('./ups'),
  fedex: () => require('./fedex'),
  usps: () => require('./usps'),
};

const CONFIGURED = {
  ups: () => Boolean(config.tracking.ups.clientId && config.tracking.ups.clientSecret),
  fedex: () => Boolean(config.tracking.fedex.clientId && config.tracking.fedex.clientSecret),
  usps: () => Boolean(config.tracking.usps.clientId && config.tracking.usps.clientSecret),
};

/** Carriers we could poll right now, given what is in .env. */
function ready() {
  return Object.keys(CONFIGURED).filter((k) => CONFIGURED[k]());
}

/**
 * Which carrier is this really? The stored carrier is a hint; a recognisable
 * number beats it.
 */
function carrierFor({ carrier, trackingNumber }) {
  const detected = detectCarrier(trackingNumber);
  if (detected && PROVIDERS[detected]) return detected;
  const stated = String(carrier || '').toLowerCase();
  if (PROVIDERS[stated]) return stated;
  return detected || stated || null;
}

class NoProviderError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'NoProviderError';
    this.reason = reason;
    this.noProvider = true;
  }
}

function providerFor(shipment) {
  const key = carrierFor(shipment);
  if (!key) {
    throw new NoProviderError('Cannot tell which carrier this tracking number belongs to', 'unknown_carrier');
  }
  if (key === 'amazon') {
    throw new NoProviderError(
      'Amazon Logistics has no public tracking API - update this one by hand, or use the carrier number if Amazon shipped it via UPS, FedEx or USPS',
      'amazon_no_api'
    );
  }
  if (!PROVIDERS[key]) {
    throw new NoProviderError(`No tracking API is wired up for ${key}`, 'unsupported_carrier');
  }
  if (!CONFIGURED[key]()) {
    throw new NoProviderError(`${key.toUpperCase()} credentials are not set`, 'not_configured');
  }
  return PROVIDERS[key]();
}

async function register(shipment) {
  try {
    return await providerFor(shipment).register(shipment);
  } catch (err) {
    if (err.noProvider) return { registered: false, reason: err.reason };
    throw err;
  }
}

async function fetchTracking(shipment) {
  // Let a missing provider surface as a skip rather than an error: an Amazon
  // parcel is not a failure, it is a parcel nobody can poll.
  const provider = providerFor(shipment);
  const out = await provider.fetchTracking(shipment);
  return { ...out, provider: provider.name };
}

module.exports = { name: 'multi', register, fetchTracking, providerFor, carrierFor, ready, NoProviderError };
