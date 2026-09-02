'use strict';

// The ticket lifecycle. `key` is stored in the DB; everything else is display.
const STATUSES = [
  { key: 'received',          label: 'Received',         color: '#2563eb', open: true  },
  { key: 'diagnosing',        label: 'Diagnosing',       color: '#7c3aed', open: true  },
  { key: 'in_progress',       label: 'In Progress',      color: '#0891b2', open: true  },
  { key: 'waiting_on_parts',  label: 'Waiting on Parts', color: '#d97706', open: true  },
  { key: 'waiting_on_user',   label: 'Waiting on User',  color: '#db2777', open: true  },
  // A fee or a decision, not a question about the device - kept separate so the
  // queue can tell "waiting on a person" from "waiting on money".
  { key: 'waiting_on_approval', label: 'Waiting on Approval', color: '#9333ea', open: true },
  { key: 'ready_for_pickup',  label: 'Ready for Pickup', color: '#16a34a', open: true  },
  { key: 'closed',            label: 'Closed',           color: '#475569', open: false },
  // Distinct from Closed so reporting can separate "fixed it" from "wrote it off".
  { key: 'beyond_repair',     label: 'Beyond Repair',    color: '#b91c1c', open: false },
  { key: 'cancelled',         label: 'Cancelled',        color: '#78716c', open: false },
];

const PRIORITIES = [
  { key: 'low',    label: 'Low' },
  { key: 'normal', label: 'Normal' },
  { key: 'high',   label: 'High' },
  { key: 'urgent', label: 'Urgent' },
];

const STATUS_KEYS = STATUSES.map((s) => s.key);
const OPEN_STATUS_KEYS = STATUSES.filter((s) => s.open).map((s) => s.key);
const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);

const statusLabel = (key) => (STATUSES.find((s) => s.key === key) || { label: key }).label;

/**
 * `new` was renamed to `received` (it reads better to a student, and "new" said
 * nothing about what had happened). Old links, bookmarks and saved filters are
 * translated rather than broken.
 */
const STATUS_ALIASES = { new: 'received' };
const canonicalStatus = (key) => STATUS_ALIASES[String(key || '').trim()] || String(key || '').trim();

module.exports = {
  STATUSES, PRIORITIES, STATUS_KEYS, OPEN_STATUS_KEYS, PRIORITY_KEYS,
  statusLabel, STATUS_ALIASES, canonicalStatus,
};
