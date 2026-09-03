'use strict';
/**
 * Carrier detection from the tracking number alone.
 *
 * This lives here rather than in shipments.js so the tracking providers can use
 * it without pulling in the whole shipment module (which requires tracking,
 * which would require shipments...). shipments.js re-exports it.
 */
function detectCarrier(tracking) {
  const t = String(tracking || '').replace(/[\s-]/g, '').toUpperCase();
  if (!t) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'ups';
  if (/^T\d{10}$/.test(t)) return 'ups';
  if (/^TBA\d{9,}$/.test(t)) return 'amazon';
  if (/^(94|93|92|95|82)\d{18,20}$/.test(t)) return 'usps';
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(t)) return 'usps';
  if (/^(96\d{20}|\d{15}|\d{12})$/.test(t)) return 'fedex';
  return null;
}

module.exports = { detectCarrier };
