// send.js: render a template, then send the result to a URL with fetch (built into Node 18+).
// The state file only keeps this run if the request succeeds (a 2xx reply); otherwise it is put
// back as it was, so a failed send does not use up an invoice number or a rotation step.
// A copy of every payload is kept, named by the local time it was sent:
// sent/<name>.<time>.json, or <name>.<time>.failed.json when the request failed.
//
//   node send.js invoice.njk                       sends to BASE_URL + PATHS["invoice.njk"]
//   node send.js invoice.njk --hold invoice        render.js flags work too
//   node send.js invoice.njk --dry-run             send the next payload without saving anything
//   METHOD=PUT BASE_URL=https://api.example.com node send.js invoice.njk
const fs = require('fs');
const path = require('path');
const { render, parseArgs } = require('./render');

// Where requests go. BASE_URL and METHOD in the environment override these for one run.
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const METHOD = process.env.METHOD || 'POST';
const HEADERS = { 'Content-Type': 'application/json' };
const TIMEOUT_MS = 30000; // give up on a server that does not answer

// The path each template is sent to, added to BASE_URL.
const PATHS = {
  'invoice.njk': '/invoices'
};

const TEMPLATES = path.join(__dirname, 'templates');
const SENT = path.join(__dirname, 'sent');

// This computer's local time, such as 2026-10-27T21:53:08
function localTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Render `templateName` and send it as the request body.
// `opts` takes the same choices as render(): { hold, only, reverse, dryRun, report }.
// `to` can change where it goes for this call: { baseUrl, method, headers }.
// GET and HEAD carry no body, so they skip the template: nothing is rendered, saved or kept.
// Returns { sentAt, copy, reply }: the send time, where the payload copy was kept (null for
// GET and HEAD), and the server's reply as { status, statusText, text }. Throws if the request fails.
async function send(templateName, opts = {}, { baseUrl = BASE_URL, method = METHOD, headers = HEADERS } = {}) {
  if (!(templateName in PATHS)) throw new Error(`No path for ${templateName}: add it to PATHS in send.js`);
  method = method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error(`Not a request method: ${method}`);
  const url = baseUrl.replace(/\/+$/, '') + PATHS[templateName];
  const name = templateName.replace(/\.[^./]+$/, '');
  const state = path.join(TEMPLATES, name + '.state.json');

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const saved = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : null; // the state file before this run
  const body = hasBody ? render(templateName, {}, opts) : undefined;
  const sentAt = localTime();

  let reply = null;
  let problem = null;
  try {
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    reply = { status: res.status, statusText: res.statusText, text: await res.text() };
    if (!res.ok) problem = `the server replied ${res.status} ${res.statusText}`;
  } catch (err) {
    if (err.name === 'TimeoutError') problem = `no reply after ${TIMEOUT_MS / 1000} seconds`;
    else if (err.cause) problem = `could not reach the server (${err.cause.code || err.cause.message})`;
    else problem = err.message;
  }

  if (!hasBody) {
    if (problem) {
      const err = new Error(`${method} ${url} at ${sentAt} failed: ${problem}.`);
      err.reply = reply;
      throw err;
    }
    return { sentAt, copy: null, reply };
  }

  // Colons are not allowed in file names on every system, so 21:53:08 becomes 21-53-08
  fs.mkdirSync(SENT, { recursive: true });
  const stem = path.join(SENT, `${name}.${sentAt.replace(/:/g, '-')}`);
  const end = problem ? '.failed.json' : '.json';
  let copy = stem + end;
  for (let n = 2; fs.existsSync(copy); n++) copy = `${stem}-${n}${end}`; // two sends in the same second
  fs.writeFileSync(copy, body);

  if (problem) {
    if (saved === null) fs.rmSync(state, { force: true });
    else fs.writeFileSync(state, saved);
    const err = new Error(`${method} ${url} at ${sentAt} failed: ${problem}.\n` +
      `templates/${name}.state.json is back to how it was before this run. ` +
      `Payload kept in ${path.relative(__dirname, copy)}`);
    err.reply = reply;
    throw err;
  }
  return { sentAt, copy, reply };
}

module.exports = { send };

if (require.main === module) {
  (async () => {
    try {
      const { names, opts } = parseArgs(process.argv.slice(2));
      if (!names[0]) {
        console.log('Usage: node send.js <template.njk> [--hold keys] [--only keys] [--reverse keys] [--dry-run]');
        return;
      }
      if (opts.hold.length || opts.reverse.length || opts.only || opts.dryRun) {
        opts.report = (lines) => console.error(lines.join('\n'));
      }
      const { sentAt, copy, reply } = await send(names[0], opts);
      if (reply.text) console.log(reply.text); // the server's reply body
      console.error(`Sent at ${sentAt}: ${reply.status} ${reply.statusText}.` +
        (copy ? ` Payload kept in ${path.relative(__dirname, copy)}` : ''));
    } catch (err) {
      console.error(err.message);
      if (err.reply && err.reply.text) console.error('The server said: ' + err.reply.text);
      process.exitCode = 1;
    }
  })();
}
