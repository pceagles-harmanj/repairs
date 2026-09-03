'use strict';
/**
 * One small vocabulary for "where is the package", independent of any provider.
 *
 *   pre_transit       label made, carrier has not scanned it yet
 *   in_transit        moving
 *   out_for_delivery  on the truck today
 *   delivered         the carrier says it was handed over
 *   exception         failed attempt, damage, held, returned
 *   unknown           no usable information
 *
 * Note what is NOT here: "received". Delivered means the carrier dropped it at
 * the school; received means a human checked it into stock. Those are different
 * days more often than you would like, which is exactly why students are told
 * "delivered, not yet checked in".
 */
const TRACKING_STATUSES = ['pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'unknown'];

const AFTERSHIP_TAGS = {
  Pending: 'pre_transit',
  InfoReceived: 'pre_transit',
  InTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  AttemptFail: 'exception',
  Delivered: 'delivered',
  AvailableForPickup: 'out_for_delivery',
  Exception: 'exception',
  Expired: 'unknown',
};

function fromAfterShipTag(tag) {
  if (!tag) return 'unknown';
  return AFTERSHIP_TAGS[tag] || 'unknown';
}

/**
 * UPS status objects, which carry a one-or-two letter `type` and a description.
 * The type is the reliable part; the description is free text that UPS changes.
 */
const UPS_TYPES = {
  M: 'pre_transit',        // manifest / billing information received
  MP: 'pre_transit',       // pickup scheduled
  I: 'in_transit',
  P: 'in_transit',         // picked up
  O: 'out_for_delivery',
  D: 'delivered',
  X: 'exception',
  RS: 'exception',         // returned to shipper
  DO: 'exception',         // delivered to a different address / redirected
  NA: 'unknown',
};

function fromUpsStatus(status) {
  if (!status) return 'unknown';
  const type = String(status.type || status.code || '').toUpperCase();
  if (UPS_TYPES[type]) return UPS_TYPES[type];
  // Fall back to the words when UPS invents a type we do not know.
  const text = String(status.description || '').toLowerCase();
  if (/delivered/.test(text)) return 'delivered';
  if (/out for delivery|on vehicle/.test(text)) return 'out_for_delivery';
  if (/label|order processed|ready for ups/.test(text)) return 'pre_transit';
  if (/exception|attempt|refused|damage|held|return/.test(text)) return 'exception';
  if (/transit|departed|arrived|origin scan|picked up|processing/.test(text)) return 'in_transit';
  return 'unknown';
}

/**
 * FedEx derived status codes. The two-letter codes are stable; the descriptions
 * are marketing copy that changes, so they are only a fallback.
 */
const FEDEX_CODES = {
  OC: 'pre_transit',       // order created / label
  PU: 'in_transit',        // picked up
  AR: 'in_transit',        // arrived at facility
  DP: 'in_transit',        // departed
  IT: 'in_transit',
  AF: 'in_transit',        // at FedEx facility
  OD: 'out_for_delivery',
  DL: 'delivered',
  DE: 'exception',         // delivery exception
  SE: 'exception',         // shipment exception
  CA: 'exception',         // cancelled
  RS: 'exception',         // return to shipper
  HL: 'out_for_delivery',  // hold at location, ready for pickup
};

function fromFedexCode(code, description) {
  const key = String(code || '').toUpperCase();
  if (FEDEX_CODES[key]) return FEDEX_CODES[key];
  return fromWords(description);
}

/**
 * USPS statusCategory is a short phrase rather than a code ("Out for Delivery",
 * "Delivered", "In Transit"), so the words are the primary signal here.
 */
const USPS_CATEGORIES = {
  'pre-shipment': 'pre_transit',
  preshipment: 'pre_transit',
  accepted: 'in_transit',
  'in transit': 'in_transit',
  'out for delivery': 'out_for_delivery',
  'available for pickup': 'out_for_delivery',
  delivered: 'delivered',
  alert: 'exception',
  'delivery attempt': 'exception',
  'redelivery scheduled': 'exception',
  returned: 'exception',
};

function fromUspsStatus(category, summary) {
  const key = String(category || '').trim().toLowerCase();
  if (USPS_CATEGORIES[key]) return USPS_CATEGORIES[key];
  return fromWords(summary || category);
}

/** Last resort for every carrier: read the sentence. */
function fromWords(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'unknown';
  if (/delivered|left at|handed to/.test(t)) return 'delivered';
  if (/out for delivery|on vehicle|with courier|available for pickup/.test(t)) return 'out_for_delivery';
  if (/label|pre-?shipment|order (created|processed)|awaiting/.test(t)) return 'pre_transit';
  if (/exception|attempt|refused|damage|held|return|undeliverable|alert|cancel/.test(t)) return 'exception';
  if (/transit|departed|arrived|accepted|picked up|processing|in ?transit|origin|facility/.test(t)) return 'in_transit';
  return 'unknown';
}

/** What a tracking status means for our own shipment lifecycle. */
const SHIPMENT_STATUS_FOR = {
  pre_transit: 'ordered',
  in_transit: 'shipped',
  out_for_delivery: 'shipped',
  delivered: 'delivered',
  exception: 'delayed',
  unknown: null,          // leave the human's status alone
};

const LABEL = {
  pre_transit: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Delivery problem',
  unknown: 'No tracking information',
};

module.exports = {
  fromUpsStatus, UPS_TYPES, fromFedexCode, FEDEX_CODES, fromUspsStatus, USPS_CATEGORIES, fromWords, TRACKING_STATUSES, AFTERSHIP_TAGS, fromAfterShipTag, SHIPMENT_STATUS_FOR, LABEL };
