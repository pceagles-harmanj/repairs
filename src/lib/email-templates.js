'use strict';
/**
 * The default status emails, in the school's colours.
 *
 * Written for email clients, not browsers: tables for layout, inline styles
 * only, no flexbox/grid, no external CSS, no web fonts. Colours come through as
 * {{brand_*}} placeholders so changing BRAND_PRIMARY / BRAND_ACCENT in .env
 * re-themes emails that are already saved in the database.
 *
 * Every template may use any placeholder listed in the README. The sentence-shaped
 * ones ({{loaner_line}}, {{repair_line}}, {{latest_note}}) render as an empty
 * string when they do not apply, so a template never shows a dangling label.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** One card: maroon header, gold rule, white body, quiet footer. */
const shell = ({ preheader, heading, body, cta = true }) => `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{{brand_wash}};margin:0;padding:24px 0">
<tr><td align="center" style="padding:0 12px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid {{brand_border}}">

    <tr><td style="background:{{brand_primary}};padding:18px 24px">
      <div style="font:600 17px/1.3 ${FONT};color:#ffffff">{{org_name}}</div>
      <div style="font:400 13px/1.4 ${FONT};color:#ffffff;opacity:.85">{{helpdesk_name}}</div>
    </td></tr>
    <tr><td style="height:4px;background:{{brand_accent}};font-size:0;line-height:0">&nbsp;</td></tr>

    <tr><td style="padding:26px 24px 8px">
      <h1 style="margin:0 0 14px;font:600 20px/1.3 ${FONT};color:{{brand_ink}}">${heading}</h1>
      <div style="font:400 15px/1.6 ${FONT};color:{{brand_ink}}">
${body}
      </div>
    </td></tr>

    ${cta ? `<tr><td style="padding:6px 24px 26px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:{{brand_primary}};border-radius:6px">
          <a href="{{status_url}}" style="display:inline-block;padding:11px 20px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none">Check your repair status</a>
        </td>
      </tr></table>
      <div style="font:400 13px/1.5 ${FONT};color:{{brand_muted}};padding-top:10px">Ticket #{{ticket_number}} &middot; you can also just reply to this email.</div>
    </td></tr>` : ''}

    <tr><td style="background:{{brand_wash}};padding:16px 24px;border-top:1px solid {{brand_border}}">
      <div style="font:400 12px/1.6 ${FONT};color:{{brand_muted}}">
        {{helpdesk_signature}} &middot; {{org_name}}<br>
        <a href="{{unsubscribe_url}}" style="color:{{brand_muted}}">Choose which repair emails you get</a>
      </div>
    </td></tr>

  </table>
</td></tr></table>`;

/** Device facts, as a small two-column table. */
const deviceRows = (rows) => `        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;font:400 14px/1.5 ${FONT}">
${rows
  .map(
    ([label, value]) => `          <tr>
            <td style="padding:4px 16px 4px 0;color:{{brand_muted}};white-space:nowrap">${label}</td>
            <td style="padding:4px 0;color:{{brand_ink}}">${value}</td>
          </tr>`
  )
  .join('\n')}
        </table>`;

const note = (label = 'From the technician') => `<!--if:latest_note-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px">
          <tr><td style="border-left:3px solid {{brand_accent}};padding:8px 14px;background:{{brand_wash}};border-radius:0 6px 6px 0">
            <div style="font:600 12px/1.4 ${FONT};color:{{brand_muted}};text-transform:uppercase;letter-spacing:.04em">${label}</div>
            <div style="font:400 15px/1.55 ${FONT};color:{{brand_ink}};padding-top:3px">{{latest_note}}</div>
          </td></tr>
        </table>
<!--/if-->`;

const highlight = (text) => `        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px">
          <tr><td style="background:{{brand_accent}};border-radius:8px;padding:14px 18px">
            <div style="font:600 16px/1.45 ${FONT};color:{{brand_ink}}">${text}</div>
          </td></tr>
        </table>`;

const DEFAULT_TEMPLATES = {
  received: {
    subject: 'We have your device - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'Your device is checked in for repair.',
      heading: 'Thanks, {{first_name}} - we have it',
      body: `        <p style="margin:0 0 12px">Your device is checked in and in line for a technician. Here is what we wrote down:</p>
${deviceRows([
  ['Device', '{{model}}'],
  ['Asset tag', '{{asset_tag}}'],
  ['What is wrong', '{{issue_description}}'],
  ['Checked in', '{{created_at}}'],
])}
${note('Note from us')}
<!--if:loaner_line--><p style="margin:0 0 12px">{{loaner_line}}</p><!--/if-->
        <p style="margin:0">We will email you when something changes. If we got any of that wrong, just reply and tell us.</p>`,
    }),
  },

  diagnosing: {
    subject: 'Taking a look at your device - ticket #{{ticket_number}}',
    auto_send: 0,
    body: shell({
      preheader: 'A technician is figuring out what your device needs.',
      heading: 'We are taking a look',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - a technician has your {{model}} open on the bench and is working out what it needs.</p>
${note()}
        <p style="margin:0">As soon as we know, we will tell you what happens next.</p>`,
    }),
  },

  in_progress: {
    subject: 'Working on your device - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'Your repair is underway.',
      heading: 'Your repair is underway',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - we are fixing your {{model}} now. Nothing needed from you.</p>
${note()}
<!--if:loaner_line--><p style="margin:0">{{loaner_line}}</p><!--/if-->`,
    }),
  },

  waiting_on_parts: {
    subject: 'Waiting on a part for your device - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'We are waiting on a part before we can finish.',
      heading: 'We are waiting on a part',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - your {{model}} needs a part we do not have on the shelf, so the repair is paused until it arrives.</p>
<!--if:parts_expected_line-->${highlight('{{parts_expected_line}}')}<!--/if-->
${note('What we are waiting for')}
        <p style="margin:0 0 12px">You do not need to do anything. We will email you the moment work starts again.</p>
<!--if:loaner_line--><p style="margin:0">{{loaner_line}}</p><!--/if-->`,
    }),
  },

  waiting_on_user: {
    subject: 'Quick question about your repair - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'We need a quick answer before we can keep going.',
      heading: 'We need a quick answer',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - we have paused ticket #{{ticket_number}} until we hear back from you:</p>
${note('What we need')}
        <p style="margin:0">Reply to this email, or stop by the {{helpdesk_name}}, and we will pick it back up right away.</p>`,
    }),
  },

  ready_for_pickup: {
    subject: 'Good news - your device is ready! (ticket #{{ticket_number}})',
    auto_send: 1,
    body: shell({
      preheader: 'Your device is repaired and ready to pick up.',
      heading: 'Your device is ready, {{first_name}}',
      body: `${highlight('Your {{model}} is fixed and waiting for you at the {{helpdesk_name}}.')}
${note('What we did')}
${deviceRows([
  ['Device', '{{model}}'],
  ['Asset tag', '{{asset_tag}}'],
])}
<!--if:loaner_line--><p style="margin:0 0 12px">{{loaner_line}}</p><!--/if-->
        <p style="margin:0">See you soon.</p>`,
    }),
  },

  waiting_on_approval: {
    subject: 'We need an OK before we can fix your device - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'We need approval before going ahead with this repair.',
      heading: 'We need an OK before we go ahead',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - your {{model}} needs a repair that has to be
          approved before we order the part or start work.</p>
${note('What we need approved')}
${deviceRows([
  ['Device', '{{model}}'],
  ['Asset tag', '{{asset_tag}}'],
  ['Estimated cost', '{{estimated_cost}}'],
])}
        <p style="margin:0 0 12px">Reply to this email, or come and see the {{helpdesk_name}}, and we will get
          straight on with it.</p>
<!--if:loaner_line--><p style="margin:0">{{loaner_line}}</p><!--/if-->`,
    }),
  },

  beyond_repair: {
    subject: 'About your device - ticket #{{ticket_number}}',
    auto_send: 0,
    body: shell({
      preheader: 'This device cannot be repaired.',
      heading: 'We could not save this one',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - we have looked at your {{model}} carefully, and it
          cannot be repaired sensibly.</p>
${note('What we found')}
        <p style="margin:0 0 12px">Come and see the {{helpdesk_name}} and we will sort out what happens next.
          Nothing is expected from you before then.</p>
<!--if:loaner_line--><p style="margin:0">{{loaner_line}}</p><!--/if-->`,
    }),
  },

  closed: {
    subject: 'All finished - ticket #{{ticket_number}}',
    auto_send: 0,
    body: shell({
      preheader: 'Your repair is complete.',
      heading: 'All finished',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - your {{model}} is back in service and we have closed ticket #{{ticket_number}}.</p>
<!--if:repair_line--><p style="margin:0 0 12px">{{repair_line}}</p><!--/if-->
${note('Notes from the repair')}
        <p style="margin:0">If the same trouble comes back, reply here and we will reopen this ticket rather than starting over.</p>`,
    }),
  },

  cancelled: {
    subject: 'We closed your repair request - ticket #{{ticket_number}}',
    auto_send: 0,
    body: shell({
      preheader: 'This repair request was cancelled.',
      heading: 'We closed this request',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - we have cancelled ticket #{{ticket_number}} and no work is planned.</p>
${note('Why')}
        <p style="margin:0">If that is not what you expected, reply and we will sort it out.</p>`,
      cta: false,
    }),
  },
};

// ---------------------------------------------------------------------------
// Loaner return reminders. These are transactional (they are about school
// property that is out), so they are not tied to a ticket's status list - the
// only thing that stops them is an account-wide unsubscribe or the loaner
// coming back. Their auto_send switch turns the whole reminder off.
// ---------------------------------------------------------------------------

const LOANER_TEMPLATES = {
  loaner_due_tomorrow: {
    subject: 'Reminder: loaner {{loaner_asset_tag}} is due back tomorrow',
    auto_send: 1,
    body: shell({
      preheader: 'Your loaner is due back tomorrow.',
      heading: 'Loaner due back tomorrow',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - a quick reminder that the loaner we lent you is due
          back <b>tomorrow, {{loaner_due_date}}</b>.</p>
${deviceRows([
  ['Loaner', '{{loaner_asset_tag}}'],
  ['Due back', '{{loaner_due_date}}'],
  ['Your device', '{{model}} ({{asset_tag}})'],
])}
        <p style="margin:0 0 12px">{{loaner_status_line}}</p>
        <p style="margin:0">Bring it to the {{helpdesk_name}} any time during the school day. If you still need it,
          reply and tell us - extending it is easy.</p>`,
    }),
  },

  loaner_due_today: {
    subject: 'Loaner {{loaner_asset_tag}} is due back today',
    auto_send: 1,
    body: shell({
      preheader: 'Your loaner is due back today.',
      heading: 'Loaner due back today',
      body: `${highlight('Please return loaner {{loaner_asset_tag}} to the {{helpdesk_name}} today.')}
        <p style="margin:0 0 12px">Hi {{first_name}} - today is the return date for the loaner we lent you
          while your {{model}} was in for repair.</p>
        <p style="margin:0 0 12px">{{loaner_status_line}}</p>
        <p style="margin:0">If you cannot get it back today, reply and let us know - we would rather hear from you
          than mark it missing.</p>`,
    }),
  },

  loaner_overdue: {
    subject: 'Loaner {{loaner_asset_tag}} is overdue - please return it',
    auto_send: 1,
    body: shell({
      preheader: 'Your loaner is overdue.',
      heading: 'We are still missing a loaner',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - loaner <b>{{loaner_asset_tag}}</b> was due back on
          <b>{{loaner_due_date}}</b> and we have not seen it yet ({{loaner_overdue_phrase}}).</p>
${deviceRows([
  ['Loaner', '{{loaner_asset_tag}}'],
  ['Was due', '{{loaner_due_date}}'],
  ['Ticket', '#{{ticket_number}}'],
])}
        <p style="margin:0 0 12px">{{loaner_status_line}}</p>
        <p style="margin:0">Please bring it to the {{helpdesk_name}}. If it is lost or damaged, tell us anyway -
          we can sort it out, and guessing is worse for everyone.</p>`,
    }),
  },
};

Object.assign(DEFAULT_TEMPLATES, LOANER_TEMPLATES);

// ---------------------------------------------------------------------------
// Parts on the way. Deliberately vague about logistics: students get the day to
// expect, never the carrier or the tracking number.
// ---------------------------------------------------------------------------

const PARTS_TEMPLATES = {
  parts_shipped: {
    subject: 'Parts for your repair have shipped - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'The parts for your repair are on the way.',
      heading: 'Your parts are on the way',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - good news: {{parts_summary}} for your {{model}}
          has been ordered and is on the way.</p>
${highlight('{{parts_expected_line}}')}
        <p style="margin:0 0 12px">We will pick your repair back up as soon as it lands, and email you again
          when your device is ready.</p>
${note('Note from us')}
<!--if:loaner_line--><p style="margin:0">{{loaner_line}}</p><!--/if-->`,
    }),
  },

  parts_arriving_today: {
    subject: 'Your parts should arrive today - ticket #{{ticket_number}}',
    auto_send: 1,
    body: shell({
      preheader: 'The parts for your repair are expected today.',
      heading: 'Parts expected today',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - {{parts_summary}} for your {{model}} is expected
          to arrive today. Once it is here we will get straight on with the repair.</p>
        <p style="margin:0 0 12px">Nothing needed from you. If the delivery slips, we will tell you.</p>
${note()}`,
    }),
  },

  parts_arrived: {
    subject: 'Parts are here - back on your repair (ticket #{{ticket_number}})',
    auto_send: 1,
    body: shell({
      preheader: 'The parts for your repair have arrived.',
      heading: 'The parts are here',
      body: `        <p style="margin:0 0 12px">Hi {{first_name}} - {{parts_summary}} arrived today, so your {{model}}
          is back on the bench.</p>
        <p style="margin:0 0 12px">We will email you the moment it is ready to collect.</p>
${note('What is next')}`,
    }),
  },
};

Object.assign(DEFAULT_TEMPLATES, PARTS_TEMPLATES);

/** Every template key, status emails first, in the order Settings shows them. */
const TEMPLATE_KEYS = [
  'received', 'diagnosing', 'in_progress', 'waiting_on_parts', 'waiting_on_user',
  'waiting_on_approval', 'ready_for_pickup', 'closed', 'beyond_repair', 'cancelled',
  'loaner_due_tomorrow', 'loaner_due_today', 'loaner_overdue',
  'parts_shipped', 'parts_arriving_today', 'parts_arrived',
];

const LOANER_TEMPLATE_KEYS = Object.keys(LOANER_TEMPLATES);
const PARTS_TEMPLATE_KEYS = Object.keys(PARTS_TEMPLATES);

module.exports = {
  DEFAULT_TEMPLATES, LOANER_TEMPLATES, PARTS_TEMPLATES,
  TEMPLATE_KEYS, LOANER_TEMPLATE_KEYS, PARTS_TEMPLATE_KEYS,
  shell, deviceRows, note, highlight,
};
