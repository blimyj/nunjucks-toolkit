// helpers.js: date, list and JSON helpers for Nunjucks
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Turn a Date, a timestamp or a string into a Date.
// "2026-12-25" means local midnight here (plain JavaScript would read it as UTC midnight).
function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value == null || value === '') throw new Error('Expected a date, got ' + JSON.stringify(value));
  if (typeof value === 'string') {
    const day = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (day) return new Date(+day[1], +day[2] - 1, +day[3]);
    value = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'); // accept "2026-12-25 18:30"
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error('Not a valid date: ' + JSON.stringify(value));
  return d;
}

// Tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A
// Put literal words in [brackets]: "D MMM [at] HH:mm"
// A blank value ("" or null), common in a freshly initialised data file, prints the fallback,
// or nothing: {{ lastRun | date("D MMM", "never") }}. An undefined variable is still an error.
function formatDate(value, format = 'YYYY-MM-DD', fallback = '') {
  if (value === null || value === '') return fallback;
  const d = toDate(value);
  const pad = (n) => String(n).padStart(2, '0');
  const hours12 = d.getHours() % 12 || 12;
  const parts = {
    YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100),
    MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
    DD: pad(d.getDate()), D: d.getDate(),
    dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()), H: d.getHours(), hh: pad(hours12), h: hours12,
    mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), A: d.getHours() < 12 ? 'AM' : 'PM'
  };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A/g,
    (token, literal) => (literal !== undefined ? literal : parts[token]));
}

// Add minutes, hours, days, weeks, months or years. A negative amount subtracts.
function dateAdd(value, amount, unit = 'days') {
  const d = toDate(value);
  const n = Number(amount);
  const u = String(unit).replace(/s$/, '');
  switch (u) {
    case 'minute': d.setMinutes(d.getMinutes() + n); break;
    case 'hour': d.setHours(d.getHours() + n); break;
    case 'day': d.setDate(d.getDate() + n); break;
    case 'week': d.setDate(d.getDate() + 7 * n); break;
    case 'month':
    case 'year': {
      const day = d.getDate();
      d.setDate(1);
      if (u === 'month') d.setMonth(d.getMonth() + n);
      else d.setFullYear(d.getFullYear() + n);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay)); // Jan 31 + 1 month = Feb 28, not Mar 3
      break;
    }
    default: throw new Error('Unknown unit "' + unit + '". Use minutes, hours, days, weeks, months or years.');
  }
  return d;
}

// Whole calendar days from a to b. Negative when b is earlier.
function daysBetween(a, b) {
  const start = toDate(a);
  const end = toDate(b);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
}

function addDateHelpers(env) {
  env.addGlobal('now', () => new Date());
  env.addGlobal('datetime', toDate);
  env.addGlobal('daysBetween', daysBetween);
  env.addFilter('date', formatDate);
  env.addFilter('dateAdd', dateAdd);
}

// Nunjucks loops over Sets and Maps on its own, but sort, join, list and "in" do not
// understand them. These fill the gaps.
function addSetHelpers(env) {
  env.addFilter('array', (value) => Array.from(value)); // Set to array; Map to [key, value] pairs
  env.addFilter('unique', (value) => Array.from(new Set(value)));
  env.addGlobal('toSet', (value) => new Set(value || []));
}

// Inline conditions and JSON output.
// A false when() with no `otherwise` gives SKIP: it prints as nothing, and json() leaves it out.
const SKIP = Object.freeze({ toString: () => '' });

// when(condition, value)              value, or nothing
// when(condition, value, otherwise)   value or otherwise
function when(condition, value, otherwise = SKIP) {
  return condition ? value : otherwise;
}

// Remove SKIP keys and list items; turn Sets, Maps and macro output into plain JSON values.
function withoutSkipped(value) {
  if (value === SKIP) return undefined;
  if (value instanceof String) return String(value); // macro output
  if (value instanceof Set) return withoutSkipped(Array.from(value));
  if (value instanceof Map) return withoutSkipped(Object.fromEntries(value));
  if (Array.isArray(value)) return value.filter((v) => v !== SKIP).map(withoutSkipped);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, v] of Object.entries(value)) if (v !== SKIP) out[key] = withoutSkipped(v);
    return out;
  }
  return value;
}

// json(value, indent) and value | json print valid JSON. Keys and list items from a false when()
// are left out, so there are no commas to manage.
function addJsonHelpers(env) {
  const safe = env.getFilter('safe'); // keeps HTML escaping away from the quotes
  const json = (value, indent = 2) => safe(JSON.stringify(withoutSkipped(value), null, indent));
  env.addGlobal('when', when);
  env.addGlobal('json', json);
  env.addFilter('json', json);
}

module.exports = { addDateHelpers, addSetHelpers, addJsonHelpers, toDate, formatDate, dateAdd, daysBetween, when };