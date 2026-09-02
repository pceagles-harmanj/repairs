'use strict';
/**
 * Donor devices as a list of salvageable parts, and the three ways a part can
 * reach a repair: off the shelf, off a donor, or bought for the job.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer } = require('./helpers');

isolate();

const inventory = require('../src/inventory');
const models = require('../src/models');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

const newTicket = async () => {
  const res = await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: 'SER-DP', asset_tag: 'PC-DP', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith',
      issue_category: 'Cracked screen', issue_description: 'Cracked screen', notify: false,
    },
  });
  return res.body.ticket;
};

test('a part remembers every model it fits, by name', () => {
  const screen = inventory.create({ name: 'LCD 11.6 30-pin', part_number: 'X1', kind: 'part' });
  models.setForItem(screen.id, ['Lenovo 300e Gen 3', 'Lenovo 500e Gen 3']);

  const fitted = models.forItem(screen.id).map((m) => m.name);
  assert.deepEqual(fitted.sort(), ['Lenovo 300e Gen 3', 'Lenovo 500e Gen 3']);
  // The old free-text column stays in step so existing searches keep working.
  assert.match(inventory.get(screen.id).fits_models, /Lenovo 300e Gen 3/);

  // Naming a model that does not exist yet creates it rather than failing.
  const invented = models.byName('Lenovo 500e Gen 3');
  assert.ok(invented && invented.id);
});

test("a donor's salvage list is seeded from the model's parts and takes extras", async () => {
  const model = models.ensure('HP Chromebook 11 G8');
  const keyboard = inventory.create({ name: 'Keyboard G8', kind: 'part' });
  models.setForItem(keyboard.id, [model.id]);

  const donor = inventory.create({
    kind: 'donor_device', name: 'HP G8 donor', asset_tag: 'DON-1', model_name: 'HP Chromebook 11 G8',
  });
  assert.equal(inventory.get(donor.id).model_name, 'HP Chromebook 11 G8');

  const suggestions = models.partsFor(model.id);
  assert.equal(suggestions.length, 1);

  // Tick one off the model list, then add something no part row covers.
  inventory.addDonorParts(donor.id, [
    { item_id: keyboard.id, label: 'Keyboard G8' },
    { label: 'wifi card' },
  ]);
  const parts = inventory.donorParts(donor.id);
  assert.deepEqual(parts.map((p) => p.label).sort(), ['Keyboard G8', 'wifi card']);
  assert.ok(parts.every((p) => p.state === 'available'));

  // A part that turns out to be junk drops off the available list.
  inventory.setDonorPartState(parts[0].id, 'broken');
  assert.equal(inventory.donorParts(donor.id).filter((p) => p.state === 'available').length, 1);
});

test('taking a donor part marks it taken, names the ticket, and never touches stock counts', async () => {
  const ticket = await newTicket();
  const donor = inventory.create({ kind: 'donor_device', name: 'Lenovo donor', asset_tag: 'DON-2' });
  const shelfCopy = inventory.create({ name: 'Hinge set', kind: 'part', qty_on_hand: 4 });
  inventory.addDonorParts(donor.id, [{ item_id: shelfCopy.id, label: 'Hinge set' }]);
  const [part] = inventory.donorParts(donor.id);

  const res = await srv.call(`/api/tickets/${ticket.id}/fitted`, {
    method: 'POST',
    body: { source: 'donor', donor_part_id: part.id, author: 'Tech' },
  });
  assert.equal(res.body.parts.length, 1);
  assert.equal(res.body.parts[0].source, 'donor');
  assert.equal(res.body.parts[0].donor_asset_tag, 'DON-2');

  const after = inventory.donorParts(donor.id)[0];
  assert.equal(after.state, 'taken');
  assert.equal(after.taken_ticket_id, ticket.id);
  // Salvaging is not stock: the shelf count is untouched.
  assert.equal(inventory.get(shelfCopy.id).qty_on_hand, 4);
  // And the donor is now visibly picked over.
  assert.equal(inventory.get(donor.id).donor_status, 'exhausted');
});

test('a part off the shelf drops the count; putting it back restores it', async () => {
  const ticket = await newTicket();
  const item = inventory.create({ name: 'Palmrest', kind: 'part', qty_on_hand: 3 });

  const fit = await srv.call(`/api/tickets/${ticket.id}/fitted`, {
    method: 'POST', body: { source: 'stock', item_id: item.id, qty: 2 },
  });
  assert.equal(inventory.get(item.id).qty_on_hand, 1);

  await srv.call(`/api/tickets/${ticket.id}/fitted/${fit.body.id}`, { method: 'DELETE' });
  assert.equal(inventory.get(item.id).qty_on_hand, 3);
  assert.equal(inventory.ticketParts(ticket.id).length, 0);
});

test('an undone donor part goes back on the donor, ready for the next repair', async () => {
  const ticket = await newTicket();
  const donor = inventory.create({ kind: 'donor_device', name: 'Donor 3', asset_tag: 'DON-3' });
  inventory.addDonorParts(donor.id, [{ label: 'LCD' }]);
  const [part] = inventory.donorParts(donor.id);

  const fit = await srv.call(`/api/tickets/${ticket.id}/fitted`, {
    method: 'POST', body: { source: 'donor', donor_part_id: part.id },
  });
  await srv.call(`/api/tickets/${ticket.id}/fitted/${fit.body.id}`, { method: 'DELETE' });

  const back = inventory.donorParts(donor.id)[0];
  assert.equal(back.state, 'available');
  assert.equal(back.taken_ticket_id, null);
});

test('the same donor part cannot be fitted to two repairs', async () => {
  const one = await newTicket();
  const two = await newTicket();
  const donor = inventory.create({ kind: 'donor_device', name: 'Donor 4', asset_tag: 'DON-4' });
  inventory.addDonorParts(donor.id, [{ label: 'Battery' }]);
  const [part] = inventory.donorParts(donor.id);

  await srv.call(`/api/tickets/${one.id}/fitted`, {
    method: 'POST', body: { source: 'donor', donor_part_id: part.id },
  });
  const res = await srv.call(`/api/tickets/${two.id}/fitted`, {
    method: 'POST', body: { source: 'donor', donor_part_id: part.id },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already marked "taken"/);
});

test('a purchased part costs money without ever entering stock', async () => {
  const ticket = await newTicket();
  const before = inventory.list({ kind: 'part' }).length;

  await srv.call(`/api/tickets/${ticket.id}/fitted`, {
    method: 'POST',
    body: { source: 'purchased', description: 'LCD 11.6', vendor: 'Parts People', qty: 2, unit_cost: 38.5 },
  });

  assert.equal(inventory.list({ kind: 'part' }).length, before, 'no phantom part appears on the shelf');
  assert.equal(inventory.ticketPartsCost(ticket.id), 77);
  const detail = (await srv.call(`/api/tickets/${ticket.id}`)).body;
  assert.equal(detail.ticket.parts_cost, 77);
  assert.equal(detail.ticket.parts_fitted[0].vendor, 'Parts People');
  // The ticket history says where it came from, in words a tech would use.
  assert.ok(detail.ticket.events.some((e) => /bought for this repair from Parts People/.test(e.body || '')));
});

test("the ticket's donor picker finds parts by the donor's model, not just its name", async () => {
  const model = models.ensure('Acer Chromebook Spin 511');
  const donor = inventory.create({ kind: 'donor_device', name: 'Bin 4 carcass', model_name: model.name });
  inventory.addDonorParts(donor.id, [{ label: 'Touchscreen' }]);

  // A tech searches the model, which is what the ticket knows - not the name
  // someone typed on the donor row.
  const hit = await srv.call('/api/donor-parts?q=' + encodeURIComponent('Acer Chromebook Spin 511'));
  assert.equal(hit.body.parts.length, 1);
  assert.equal(hit.body.parts[0].donor_models, 'Acer Chromebook Spin 511');

  // Once taken, it drops out of the picker.
  const ticket = await newTicket();
  await srv.call(`/api/tickets/${ticket.id}/fitted`, {
    method: 'POST', body: { source: 'donor', donor_part_id: hit.body.parts[0].id },
  });
  const after = await srv.call('/api/donor-parts?q=Acer');
  assert.equal(after.body.parts.length, 0);
});

test('deprovisioning refuses to go ahead without an explicit confirmation', async () => {
  const res = await srv.call('/api/devices/abc123/deprovision', { method: 'POST', body: { reason: 'retiring_device' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be undone/i);
});
