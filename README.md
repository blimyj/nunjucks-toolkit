# Nunjucks toolkit

Renders the Nunjucks templates in `templates/` to JSON. Helpers such as `counter()` and `rotate()`
remember their values between runs in a state file. The workbook page
(`nunjucks-workbook.html`) explains every helper.

## Setup

You need Node 18 or later. Then, inside this folder:

```sh
npm install
```

Run every command below from inside this folder.

## Getting started

**1. Write a template.** Save it in `templates/`, e.g. `templates/order.njk`:

```
{
  "order": "ORD-{{ counter("order") | pad(4) }}",
  "customer": {{ customer.name | dump }},
  "items": {{ items | dump }},
  "total": {{ items | sum("price") }}
}
```

**2. Create its data file.**

```sh
node render.js init order.njk
```

This writes `templates/order.data.json` with every value the template uses, left blank.
Fill it in:

```json
{
  "customer": { "name": "Ada Lovelace" },
  "items": [{ "name": "Pen", "price": 1.25 }]
}
```

**3. Check the output.** This prints the result and saves nothing:

```sh
node render.js order.njk --dry-run
```

**4. Point `send.js` at your API.** Edit the settings at the top of `send.js`:

```js
const BASE_URL = process.env.BASE_URL || 'https://api.yourcompany.com';
const METHOD = process.env.METHOD || 'POST';
const HEADERS = { 'Content-Type': 'application/json' };

const PATHS = {
  'invoice.njk': '/invoices',
  'order.njk': '/orders'        // add a line for each template you send
};
```

If your API needs a token, add it to `HEADERS` but read it from the environment,
so the token is not saved in the file:

```js
const HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.API_TOKEN}` };
```

Then run with `API_TOKEN=xxxx node send.js order.njk`.

**5. Send it.**

```sh
node send.js order.njk --dry-run    # send for real, but don't move the counter on
node send.js order.njk              # send, and the counter moves on
```

Try `--dry-run` first: the request really goes out, but no state is saved. Each send prints
the server's reply and keeps a copy of the payload in `sent/`. If a send fails, the counter
goes back, so you can just run it again.

After that, edit the data file and run `node send.js order.njk` whenever you need to send.
To try templates out first, open `nunjucks-workbook.html` in a browser and use its Workspace section.

## Files

Each template has two companion files next to it:

| File                 | What it holds                                    | Who edits it |
| -------------------- | ------------------------------------------------ | ------------ |
| `invoice.njk`        | the template                                     | you          |
| `invoice.data.json`  | your values: names, prices, lists                | you          |
| `invoice.state.json` | counters, rotation positions, the last run time  | `render.js`  |

`node render.js init letter.njk` creates the data and state files for a new template,
with every value the template uses left blank. It never overwrites anything.

## Running

```sh
node render.js invoice.njk               # print the result, save the state file
node render.js invoice.njk out.json      # write the result to a file instead
```

## Choosing what moves on

By default every helper moves on each run. These flags choose which keys do.
A key is the name passed to `counter()`, `rotate()`, `firstTime()`, `reset()` or `remember()`.

```sh
node render.js daily.njk --hold topic         # topic repeats last run's item; day still counts up
node render.js daily.njk --only day           # only day moves on; everything else repeats
node render.js daily.njk --hold topic,day     # several keys, comma-separated
node render.js daily.njk --reverse topic      # step topic back one run: the previous item again
node render.js daily.njk --dry-run            # show the next run's output; save nothing
```

A held key gives last run's value again and is not saved, so the next normal run carries on
from where it was. `--hold lastRun` also keeps the last run time.

A reversed key steps back one run. A counter counts down by its step, `rotate()` gives the
item before last run's (wrapping round from the first to the last), and `firstTime()` forgets
the value so the next run sees it as new. A key can't be both held and reversed.

`reset()` and `remember()` do nothing when their key is held or reversed.

With any of these flags, what happened to each key is printed to stderr:

```
day: 3 -> 4
topic: held at 3
```

A key no helper uses is reported as a possible typo.

## Sending the output

`send.js` renders a template and sends the result to a URL, using the `fetch` built into
Node 18 and later. If the request fails (no 2xx reply, no connection, or no reply within
30 seconds), the state file is put back as it was, so a failed send does not use up a counter
or rotation step. It takes the same flags as `render.js`.

Where requests go is set at the top of `send.js` (see step 4 above). `BASE_URL` and `METHOD`
can also be set for a single run:

```sh
node send.js invoice.njk                              # POST to http://localhost:3000/invoices
METHOD=PUT BASE_URL=https://api.example.com node send.js invoice.njk   # for one run
node send.js invoice.njk --dry-run                    # send the next payload, save nothing
```

The server's reply is printed, then a line such as `Sent at 2026-10-27T22:10:27: 201 Created`.

`METHOD=GET` and `METHOD=HEAD` just make the request: the template is not rendered, so no state
changes and no copy is kept.

From your own code:

```js
const { send } = require('./send');
const { reply } = await send('invoice.njk', { hold: ['invoice'] });
await send('invoice.njk', {}, { method: 'PUT', baseUrl: 'https://api.example.com' });
```

`send()` returns `{ sentAt, copy, reply }`, where `reply` is `{ status, statusText, text }`.
It throws if the request fails.

A copy of every payload is kept in `sent/`, named by the local time it was sent:

```
sent/invoice.2026-10-27T21-30-15.json          sent
sent/invoice.2026-10-27T21-31-02.failed.json   request failed
```
