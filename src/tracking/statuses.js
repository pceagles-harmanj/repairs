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

module.exports = { TRACKING_STATUSES, AFTERSHIP_TAGS, fromAfterShipTag, SHIPMENT_STATUS_FOR, LABEL };
