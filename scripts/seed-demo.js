'use strict';
/**
 * Fills the database with fake devices and tickets so you can click around
 * before connecting Google.  Run:  npm run seed:demo
 * Safe to run more than once (it just adds more rows). Delete data/repairs.db
 * to start clean.
 */
process.env.DRY_RUN_EMAIL = process.env.DRY_RUN_EMAIL || 'true';

const { getDb } = require('../src/db');
const google = require('../src/google');
const tickets = require('../src/tickets');

const DEVICES = [
  { deviceId: 'demo-1', serialNumber: '5CD1234ABC', annotatedAssetId: 'PC-1042', model: 'Lenovo 300e Chromebook Gen 3',
    orgUnitPath: '/Students/High School', status: 'ACTIVE', notes: 'Keyboard replaced 2025-09-02', osVersion: '128.0.6613.137',
    lastSync: new Date(Date.now() - 36e5).toISOString(), autoUpdateExpiration: String(Date.UTC(2029, 5, 1)),
    recentUsers: [{ email: 'sam.smith@example.org' }, { email: 'prev.student@example.org' }] },
  { deviceId: 'demo-2', serialNumber: 'NXA9876543', annotatedAssetId: 'PC-2210', model: 'Acer Chromebook 511',
    orgUnitPath: '/Students/Junior High', status: 'ACTIVE', notes: '', osVersion: '128.0.6613.137',
    lastSync: new Date(Date.now() - 864e5).toISOString(), autoUpdateExpiration: String(Date.UTC(2030, 5, 1)),
    recentUsers: [{ email: 'alex.jones@example.org' }] },
  { deviceId: 'demo-3', serialNumber: 'HP55512345', annotatedAssetId: 'PC-3315', model: 'HP Chromebook 11 G9 EE',
    orgUnitPath: '/Staff', status: 'ACTIVE', notes: 'Loaner pool', osVersion: '127.0.6533.120',
    lastSync: new Date(Date.now() - 5 * 864e5).toISOString(), autoUpdateExpiration: String(Date.UTC(2028, 5, 1)),
    recentUsers: [{ email: 'taylor.reed@example.org' }] },
];

const TICKETS = [
  { device: 0, user_email: 'sam.smith@example.org', user_name: 'Sam Smith', issue_category: 'Cracked screen',
    issue_description: 'Dropped in the hallway. Cracked lower right, touch dead in that corner.',
    priority: 'high', assigned_to: 'jacob', status: 'waiting_on_parts', note: 'Ordered replacement panel, ETA Friday.' },
  { device: 1, user_email: 'alex.jones@example.org', user_name: 'Alex Jones', issue_category: 'Battery / charging',
    issue_description: 'Will not charge unless the cable is wiggled. Charge port feels loose.',
    priority: 'normal', assigned_to: 'jacob', status: 'in_progress', note: 'Port re-seated, testing overnight.' },
  { device: 2, user_email: 'taylor.reed@example.org', user_name: 'Taylor Reed', issue_category: 'Keyboard',
    issue_description: 'Spacebar and B key stopped responding after a spill.',
    priority: 'urgent', assigned_to: 'student-tech', status: 'ready_for_pickup', loaner_serial: 'HP55599999',
    note: 'Keyboard swapped and tested. Ready at the front desk.' },
  { device: 0, user_email: 'prev.student@example.org', user_name: 'Jamie Prior', issue_category: 'Software / OS',
    issue_description: 'Stuck at the sign-in screen after an update. Powerwashed.',
    priority: 'low', assigned_to: 'jacob', status: 'closed', note: 'Powerwash fixed it. Returned to student.' },
  { device: 1, user_email: 'alex.jones@example.org', user_name: 'Alex Jones', issue_category: 'Trackpad',
    issue_description: 'Trackpad click sticks. Reported by teacher during 3rd period.',
    priority: 'normal', assigned_to: null, status: 'new', note: '' },
];

(async () => {
  getDb();
  for (const d of DEVICES) google.cacheDevice(google.normalizeDevice(d));

  for (const spec of TICKETS) {
    const dev = google.normalizeDevice(DEVICES[spec.device]);
    const { ticket } = await tickets.create(
      {
        device_id: dev.device_id,
        serial: dev.serial,
        asset_tag: dev.asset_tag,
        model: dev.model,
        user_email: spec.user_email,
        user_name: spec.user_name,
        issue_category: spec.issue_category,
        issue_description: spec.issue_description,
        priority: spec.priority,
        assigned_to: spec.assigned_to,
        loaner_serial: spec.loaner_serial,
        location: dev.org_unit,
      },
      { author: 'seed', notify: false }
    );
    if (spec.status !== 'new') {
      await tickets.update(ticket.id, { status: spec.status }, { author: 'seed', note: spec.note, notify: false });
    }
    console.log(`seeded ticket #${ticket.id} (${spec.status})`);
  }
  console.log('\nDone. Start the app with: npm start');
})();
