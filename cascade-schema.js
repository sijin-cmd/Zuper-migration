const { respond, parseSession } = require('./_helpers');

const CASCADE_SCHEMA = {
  jobs:       [
    { id: 'categories', label: 'Job categories', hint: 'Select categories first',  fetchMsg: 'Fetching job categories from source account...' },
    { id: 'statuses',   label: 'Job statuses',   hint: 'Select categories first',  fetchMsg: 'Fetching statuses for selected categories...' },
    { id: 'checklists', label: 'Checklists',      hint: 'Select statuses first',   fetchMsg: 'Fetching checklists for selected statuses...' },
  ],
  customers:  [
    { id: 'types', label: 'Customer types', hint: 'Select types first', fetchMsg: 'Fetching customer types from source account...' },
    { id: 'tags',  label: 'Customer tags',  hint: 'Select types first', fetchMsg: 'Fetching tags for selected types...' },
  ],
  assets:     [
    { id: 'categories', label: 'Asset categories', hint: 'Select categories first', fetchMsg: 'Fetching asset categories from source account...' },
    { id: 'statuses',   label: 'Asset statuses',   hint: 'Select categories first', fetchMsg: 'Fetching statuses for selected categories...' },
  ],
  users:      [
    { id: 'roles', label: 'Roles', hint: 'Select roles first', fetchMsg: 'Fetching roles from source account...' },
    { id: 'teams', label: 'Teams', hint: 'Select roles first', fetchMsg: 'Fetching teams for selected roles...' },
  ],
  products:   [
    { id: 'categories', label: 'Product categories', hint: 'Select categories first', fetchMsg: 'Fetching product categories from source account...' },
    { id: 'items',      label: 'Products',            hint: 'Select categories first', fetchMsg: 'Fetching products for selected categories...' },
  ],
  timesheets: [
    { id: 'types', label: 'Timesheet types', hint: '', fetchMsg: 'Fetching timesheet types...' },
  ],
  invoices:   [
    { id: 'statuses', label: 'Invoice statuses', hint: '', fetchMsg: 'Fetching invoice statuses...' },
  ],
  contracts:  [
    { id: 'types', label: 'Contract types', hint: '', fetchMsg: 'Fetching contract types from source account...' },
  ],
  vendors:    [
    { id: 'categories', label: 'Vendor categories', hint: '', fetchMsg: 'Fetching vendor categories from source account...' },
  ],
  forms:      [
    { id: 'forms', label: 'Custom forms', hint: '', fetchMsg: 'Fetching forms from source account...' },
  ],
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return respond(204, {});

  const { sessionToken, module } = event.queryStringParameters || {};
  const session = parseSession(sessionToken);
  if (!session) return respond(401, { error: 'Invalid or expired session.' });

  const levels = CASCADE_SCHEMA[module];
  if (!levels) return respond(400, { error: 'Unknown module: ' + module });

  return respond(200, { levels });
};
