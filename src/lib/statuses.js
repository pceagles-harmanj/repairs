'use strict';

// The ticket lifecycle. `key` is stored in the DB; everything else is display.
const STATUSES = [
  { key: 'new',               label: 'New',              color: '#2563eb', open: true  },
  { key: 'diagnosing',        label: 'Diagnosing',       color: '#7c3aed', open: true  },
  { key: 'in_progress',       label: 'In Progress',      color: '#0891b2', open: true  },
  { key: 'waiting_on_parts',  label: 'Waiting on Parts', color: '#d97706', open: true  },
  { key: 'waiting_on_user',   label: 'Waiting on User',  color: '#db2777', open: true  },
  { key: 'ready_for_pickup',  label: 'Ready for Pickup', color: '#16a34a', open: true  },
  { key: 'closed',            label: 'Closed',           color: '#475569', open: false },
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

module.exports = { STATUSES, PRIORITIES, STATUS_KEYS, OPEN_STATUS_KEYS, PRIORITY_KEYS, statusLabel };
