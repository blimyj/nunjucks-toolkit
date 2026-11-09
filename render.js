// render.js
const fs = require('fs');
const path = require('path');
const nunjucks = require('nunjucks');
const { addDateHelpers, addSetHelpers, addJsonHelpers } = require('./helpers');

// Templates live in ./templates. Each template has two companion files beside it:
//   invoice.njk          the template
//   invoice.data.json    your values; you edit this file
//   invoice.state.json   counters and other run-to-run values; render.js writes this file
// A data file can send a key to a shared state file, so templates share it:
//   "$state": { "invoice": "billing" }    saved in billing.state.json
// `node render.js init invoice.njk` creates both companions.
// `node render.js invoice.njk --hold topic` renders without moving "topic" on, and
// `--reverse topic` steps it back one run (see the CLI at the end).
const TEMPLATES = path.join(__dirname, 'templates');

function companions(templateName) {
  const base = templateName.replace(/\.[^./]+$/, '');
  return {
    template: path.join(TEMPLATES, templateName),
    data: path.join(TEMPLATES, base + '.data.json'),
    state: path.join(TEMPLATES, base + '.state.json')
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')); // broken JSON stops the run instead of losing data
}

// Keys starting with $ in a data file are settings for render.js, not values for the template.
const SETTINGS = ['$state', '$let', '$fn'];
function splitData(data, dataFile) {
  const settings = {};
  const vars = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('$')) vars[key] = value;
    else if (SETTINGS.includes(key)) settings[key] = value;
    else throw new Error(`${path.basename(dataFile)}: unknown setting "${key}". Settings are: ${SETTINGS.join(', ')}`);
  }
  return { settings, vars };
}

// Which state file each key is saved in. A key is saved in the template's own state file
// unless the data file sends it to a shared one by name:
//   "$state": { "invoice": "billing" }    counter("invoice") is kept in billing.state.json
// Every template that sends "invoice" to "billing" uses the same number.
function stateRouting(templateName, settings, dataFile) {
  const own = companions(templateName).state;
  const shared = settings.$state ?? {};
  const where = path.basename(dataFile) + ': "$state"';
  if (typeof shared !== 'object' || shared === null || Array.isArray(shared)) {
    throw new Error(`${where} should map keys to state names, such as { "invoice": "billing" }`);
  }
  const byKey = {};
  for (const [key, name] of Object.entries(shared)) {
    if (key === 'lastRun') throw new Error(`${where}: lastRun always stays in the template's own state file`);
    if (typeof name !== 'string' || !/^[\w-][\w.-]*$/.test(name) || /\.json$/i.test(name)) {
      throw new Error(`${where}: "${key}" should name a state, such as "billing" for billing.state.json`);
    }
    byKey[key] = path.join(TEMPLATES, name + '.state.json');
  }
  return { own, fileOf: (key) => byKey[key] ?? own, files: [...new Set([own, ...Object.values(byKey)])] };
}

// Every state file a run of this template can change. send.js copies them before sending.
function stateFilesFor(templateName) {
  const files = companions(templateName);
  if (!fs.existsSync(files.data)) return [files.state];
  return stateRouting(templateName, splitData(readJson(files.data), files.data).settings, files.data).files;
}

// One object that reads and writes each key in the state file it belongs to.
function routedState(stores, fileOf) {
  return new Proxy({}, {
    get: (_, key) => stores[fileOf(key)][key],
    set: (_, key, value) => { stores[fileOf(key)][key] = value; return true; },
    has: (_, key) => key in stores[fileOf(key)]
  });
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);               // atomic swap, never a half-written file
}

const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(TEMPLATES),
  { autoescape: false, throwOnUndefined: true }
);
addDateHelpers(env); // now(), datetime(), | date, | dateAdd, daysBetween()
addSetHelpers(env);  // | array, | unique, toSet()
addJsonHelpers(env); // when(), json(), | json

let state = {};    // the state files, by key; changed during the render, saved after it
let before = {};   // the state files as they were when this run started
let thisRun = {};  // values already handed out during this run
let afterRun = {}; // reset() and remember() changes, applied once the render succeeds
let options = {};  // this run's --hold, --only and --reverse lists
let keysUsed = new Set(); // state keys the template's helpers asked about

// What `key` does on this run: 'move' on, 'hold' still, or 'reverse' one step back.
// --reverse and --hold name keys; --only names the keys that move, so the rest hold.
function mode(key) {
  keysUsed.add(key);
  if ((options.reverse || []).includes(key)) return 'reverse';
  if ((options.hold || []).includes(key)) return 'hold';
  if (options.only && !options.only.includes(key)) return 'hold';
  return 'move';
}

// Every helper gives one value per run, however many times the template uses it.
function once(id, compute) {
  if (!(id in thisRun)) thisRun[id] = compute();
  return thisRun[id];
}

// This run's number. Adds `step` (default 1) once per run.
// When held, it gives last run's number again (the first number, unsaved, if it never ran).
// When reversed, it takes `step` off instead: 42 becomes 41.
//   Invoice {{ counter("invoice") | pad(4) }}
function counter(key, step = 1) {
  return once('counter:' + key, () => {
    const m = mode(key);
    if (m === 'hold') return state[key] ?? step;
    state[key] = (state[key] ?? 0) + (m === 'reverse' ? -step : step);
    return state[key];
  });
}

// This run's item from an array or Set: run 1 gets the first item, run 2 the second.
// After the last item it starts over. Pass false as the third argument to stop with an error instead.
// When held, it gives last run's item again (the first item, unsaved, if it never ran).
// When reversed, it goes back to the item before last run's; before the first comes the last.
//   Today's topic: {{ rotate("topic", topics) }}
function rotate(key, items, wrap = true) {
  return once('rotate:' + key, () => {
    const list = Array.from(items ?? []);
    if (list.length === 0) throw new Error(`rotate("${key}"): the list is empty`);
    const used = state[key] ?? 0; // how far the previous runs got
    const m = mode(key);
    if (m === 'hold') return list[(Math.max(used, 1) - 1) % list.length];
    if (m === 'reverse') {
      if (!wrap && used <= 1) throw new Error(`rotate("${key}"): already at the first item, so it cannot go back`);
      const back = used === 0 ? list.length - 1 : (((used - 2) % list.length) + list.length) % list.length;
      state[key] = back + 1;
      return list[back];
    }
    if (!wrap && used >= list.length) {
      throw new Error(`rotate("${key}"): all ${list.length} items are used up`);
    }
    state[key] = (used % list.length) + 1;
    return list[used % list.length];
  });
}

// The item the next run will get from rotate().
//   Coming up: {{ upcoming("topic", topics) }}
function upcoming(key, items) {
  rotate(key, items); // make sure this run has taken its item
  const list = Array.from(items);
  return list[(state[key] ?? 0) % list.length];
}

// True only on the first run that sees `value` under `key`. Seen values are saved as a list.
// When held, it answers the same way but does not record the value, so the next run asks again.
// When reversed, it forgets the value, so the next run sees it as new again.
//   {% if firstTime("clients", client.id) %}Welcome aboard!{% endif %}
function firstTime(key, value) {
  return once('firstTime:' + key + ':' + JSON.stringify(value), () => {
    const m = mode(key);
    const seen = new Set(state[key] ?? []);
    if (m === 'reverse') {
      const had = seen.delete(value);
      state[key] = Array.from(seen);
      return !had;
    }
    if (seen.has(value)) return false;
    if (m === 'hold') return true;
    seen.add(value);
    state[key] = Array.from(seen);
    return true;
  });
}

// What a key held when this run started, or `fallback` if it was never saved.
//   Last invoice: {{ previous("invoice", "none") }}
function previous(key, fallback = null) {
  return before[key] ?? fallback;
}

// Set a key for the next run; prints nothing. {{ reset("topic") }} starts the rotation over.
// Held or reversed, it does nothing.
function reset(key, value = 0) {
  if (mode(key) === 'move') afterRun[key] = value;
  return '';
}

// Save any value for the next run; read it back with previous(). Sets are saved as arrays.
// Held or reversed, it does nothing.
function remember(key, value) {
  if (mode(key) === 'move') afterRun[key] = value instanceof Set ? Array.from(value) : value;
  return '';
}

// Render another template that outputs JSON, and use the result as data.
//   {{ jsonFromFile("address.njk").city }}
//   {{ jsonFromFile("address.njk", "streetAddress.streetName.streetNumber") }}
//   {{ json({ "ship_to": jsonFromFile("address.njk"), "total": total }) }}
// The other template sees the same data as this one. Loop variables are not passed on by
// Nunjucks, so hand them over in an object, after the path or instead of it:
//   jsonFromFile("line.njk", { "item": item })   jsonFromFile("line.njk", "sku", { "item": item })
const inProgress = []; // templates being turned into JSON right now, to catch circles
function jsonFromFile(templateName, path, extra) {
  if (path !== undefined && path !== null && typeof path !== 'string') { extra = path; path = undefined; }
  extra = extra || {};
  const vars = { ...(this && this.ctx), ...extra };
  const value = once('jsonFromFile:' + templateName + ':' + JSON.stringify(extra), () => {
    if (inProgress.includes(templateName)) {
      throw new Error(`jsonFromFile: ${[...inProgress, templateName].join(' -> ')} goes round in a circle`);
    }
    inProgress.push(templateName);
    try {
      const text = env.render(templateName, vars);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(`jsonFromFile("${templateName}"): its output is not valid JSON (${err.message})`);
      }
    } finally {
      inProgress.pop();
    }
  });
  return path ? valueAt(value, path, templateName) : value;
}

// Follow a path such as "streetAddress.streetName.streetNumber" or "lines[0].sku" into a value.
function valueAt(value, path, from) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = value;
  const walked = [];
  for (const part of parts) {
    const where = walked.length ? '"' + walked.join('.') + '"' : 'the top level';
    if (current === null || typeof current !== 'object') {
      throw new Error(`jsonFromFile("${from}", "${path}"): ${where} is ${JSON.stringify(current)}, so it has no "${part}"`);
    }
    if (!(part in current)) {
      const has = Object.keys(current).join(', ') || 'nothing';
      throw new Error(`jsonFromFile("${from}", "${path}"): no "${part}" in ${where}. It has: ${has}`);
    }
    current = current[part];
    walked.push(part);
  }
  return current;
}

for (const [name, fn] of Object.entries({ counter, rotate, upcoming, firstTime, previous, reset, remember, jsonFromFile })) {
  env.addGlobal(name, fn);
}

// 42 | pad(4)  ->  "0042"
env.addFilter('pad', (n, width = 4) => String(n).padStart(width, '0'));

// Values and functions a data file builds once, for the template to use in as many places as it likes.
//   "$let": { "total": "items | sum('price')" }                     {{ total }}
//   "$fn":  { "money(n, cur='USD')": "(n | round(2)) ~ ' ' ~ cur" }  {{ money(total) }}  {{ money(4, "EUR") }}
// Each one is a Nunjucks expression: what you would write inside {{ }}. $let values are worked out
// once per run, in the order written, so a later one can use an earlier one; they keep their type,
// so a number stays a number and a list stays a list. $fn bodies run each time they are called and
// can use the data, every $let value and the other functions.
let captured; // the value of the expression evaluate() is working on
env.addGlobal('__value', (value) => { captured = value; return ''; });
const compiled = new Map();
function evaluate(expr, vars, where) {
  let template = compiled.get(expr);
  if (!template) {
    try {
      template = new nunjucks.Template('{{ __value(' + expr + ') }}', env, null, true);
    } catch (err) {
      throw new Error(`${where}: ${JSON.stringify(expr)} is not a valid expression (${err.message.split('\n').pop().trim()})`);
    }
    compiled.set(expr, template);
  }
  captured = undefined;
  try {
    template.render(vars);
  } catch (err) {
    throw new Error(`${where}: ${err.message.replace(/^\(unknown path\)\s*(\[Line \d+, Column \d+\])?\s*(Error:\s*)?/, '').trim()}`);
  }
  // Inner evaluations finish before this expression's own __value() runs, so `captured` is ours.
  if (captured === undefined) throw new Error(`${where}: ${JSON.stringify(expr)} gives nothing (undefined). Check the names in it`);
  return captured;
}

// Split "n, cur='USD', opts={a: 1, b: 2}" at the commas that are not inside quotes or brackets.
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// "money(n, cur='USD')"  ->  { name: "money", params: [{ name: "n" }, { name: "cur", fallback: "'USD'" }] }
function parseSignature(signature, where) {
  const m = signature.match(/^\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/);
  if (!m) throw new Error(`${where}: "${signature}" should look like name(arg, other='default')`);
  const params = splitArgs(m[2]).map((part) => {
    const p = part.match(/^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/);
    if (!p) throw new Error(`${where}: "${part}" in "${signature}" should be a name, or name=default`);
    return { name: p[1], fallback: p[2] };
  });
  return { name: m[1], params };
}

// Add the data file's $fn functions and $let values to `vars`, the template's variables.
function addDerived(settings, vars, dataFile) {
  const file = path.basename(dataFile);
  const lets = settings.$let ?? {};
  const fns = settings.$fn ?? {};
  for (const [kind, group] of [['$let', lets], ['$fn', fns]]) {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      throw new Error(`${file}: "${kind}" should be an object of names and expressions`);
    }
    for (const [key, expr] of Object.entries(group)) {
      if (typeof expr !== 'string') throw new Error(`${file}: ${kind} "${key}" should be an expression in a string`);
    }
  }
  const claim = (name, what) => {
    if (name in vars) throw new Error(`${file}: ${what} "${name}" has the same name as a value in the data`);
    if (name in env.globals) throw new Error(`${file}: ${what} "${name}" has the same name as a helper`);
  };

  for (const [signature, body] of Object.entries(fns)) {
    const where = `${file}: $fn "${signature}"`;
    const { name, params } = parseSignature(signature, where);
    claim(name, '$fn');
    vars[name] = (...args) => {
      // Nunjucks passes name=value arguments as a last object marked __keywords
      const last = args[args.length - 1];
      const named = last && typeof last === 'object' && last.__keywords ? args.pop() : {};
      if (args.length > params.length) throw new Error(`${name}() takes ${params.length} argument(s) but got ${args.length}`);
      for (const key of Object.keys(named)) {
        if (key !== '__keywords' && !params.some((p) => p.name === key)) throw new Error(`${name}() has no argument called "${key}"`);
      }
      const scope = { ...vars };
      params.forEach((p, i) => {
        if (i < args.length) scope[p.name] = args[i];
        else if (p.name in named) scope[p.name] = named[p.name];
        else if (p.fallback !== undefined) scope[p.name] = evaluate(p.fallback, scope, `${where}, default for ${p.name}`);
        else throw new Error(`${name}() is missing its "${p.name}" argument`);
      });
      return evaluate(body, scope, where);
    };
  }
  for (const [name, expr] of Object.entries(lets)) {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`${file}: $let "${name}" is not a usable name: use letters, digits and _`);
    claim(name, '$let');
    vars[name] = evaluate(expr, vars, `${file}: $let "${name}"`);
  }
  return vars;
}

// Render a template with its data file, then save its state file.
// `extra` adds values JSON cannot hold, such as a Set or a Map, for this run only.
// `opts` chooses what moves on:
//   { hold: ['topic'] }    everything moves on except "topic", which repeats last run's value
//   { only: ['invoice'] }  only "invoice" moves on; every other key repeats
//   { reverse: ['topic'] } "topic" steps back one run; counters count down
//   { dryRun: true }       show what the next run would print, and save nothing
// `opts.report(lines)` receives a summary of what moved and what was held.
function render(templateName, extra = {}, opts = {}) {
  const files = companions(templateName);
  if (!fs.existsSync(files.data)) {
    throw new Error(`${path.basename(files.data)} is missing. Create it with: node render.js init ${templateName}`);
  }
  const { settings, vars: data } = splitData(readJson(files.data), files.data);
  const routing = stateRouting(templateName, settings, files.data);
  const stores = {};
  for (const file of routing.files) stores[file] = fs.existsSync(file) ? readJson(file) : {};
  state = routedState(stores, routing.fileOf);
  before = routedState(JSON.parse(JSON.stringify(stores)), routing.fileOf);
  thisRun = {};
  afterRun = {};
  const both = (opts.hold || []).filter((k) => (opts.reverse || []).includes(k));
  if (both.length) throw new Error(`${both.join(', ')}: a key cannot be both held and reversed`);
  options = opts;
  keysUsed = new Set();
  inProgress.length = 0;
  inProgress.push(templateName);
  // Every template also gets `lastRun`: when it was last rendered successfully, or null.
  const vars = addDerived(settings, { lastRun: state.lastRun ?? null, ...data, ...extra }, files.data);
  const output = env.render(templateName, vars);

  Object.assign(state, afterRun);
  if (!(opts.hold || []).includes('lastRun')) state.lastRun = new Date();
  if (opts.report) opts.report(summary(before, state, opts));
  if (!opts.dryRun) for (const file of routing.files) writeJson(file, stores[file]); // only reached when rendering worked
  return output;
}

// One line per state key: what it was, what it is now, or that it was held.
function summary(was, now, opts) {
  const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v));
  const lines = [];
  for (const key of keysUsed) {
    const m = mode(key);
    if (m === 'hold') lines.push(`${key}: held at ${show(was[key])}`);
    else if (m === 'reverse') lines.push(`${key}: ${show(was[key])} -> ${show(now[key])} (reversed)`);
    else if (JSON.stringify(was[key]) !== JSON.stringify(now[key])) lines.push(`${key}: ${show(was[key])} -> ${show(now[key])}`);
    else lines.push(`${key}: unchanged`);
  }
  for (const key of [...(opts.hold || []), ...(opts.only || []), ...(opts.reverse || [])]) {
    if (key !== 'lastRun' && !keysUsed.has(key)) lines.push(`${key}: no helper in this template uses this key (typo?)`);
  }
  if (opts.dryRun) lines.push('Dry run: nothing was saved');
  return lines;
}

// Work out which values a template reads from its data, as an empty skeleton.
//   {{ client.name }}                         gives { "client": { "name": "" } }
//   {% for item in items %}{{ item.price }}   gives { "items": [{ "price": "" }] }
// Includes, parent templates and jsonFromFile() templates are read too.
function inferData(templateName) {
  const { nodes, parser } = nunjucks;
  const skip = new Set([...Object.keys(env.globals), 'loop', 'lastRun', 'super', 'caller']);
  const defined = new Set(); // names the template sets itself
  const visited = new Set();
  const shape = {};

  // Record a path like ['items', '[]', 'price']. '[]' means "an item of this list",
  // '{}' means "this is an object". A blank value can grow into a list or object; nothing shrinks.
  const isBlank = (v) => v === undefined || v === '';
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  function touch(segments) {
    let node = shape;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const next = segments[i + 1];
      if (seg === '[]') {                                  // node is a list; step into its first item
        if (next === undefined || next === '{}') return;
        if (next === '[]') { if (isBlank(node[0])) node[0] = []; }
        else if (isBlank(node[0])) node[0] = {};
        node = node[0];
        if (typeof node !== 'object' || node === null) return;
        continue;
      }
      if (seg === '{}') return;
      if (next === undefined) { if (!(seg in node)) node[seg] = ''; return; }
      if (next === '[]') { if (isBlank(node[seg])) node[seg] = []; if (!Array.isArray(node[seg])) return; }
      else { if (isBlank(node[seg])) node[seg] = {}; if (!isObject(node[seg])) return; }
      node = node[seg];
    }
  }

  // Filters and helpers that tell us a value is a list (or, for dictsort, an object)
  const LIST_FILTERS = new Set(['join', 'sort', 'first', 'last', 'unique', 'array', 'batch', 'slice',
    'sum', 'groupby', 'select', 'reject', 'selectattr', 'rejectattr', 'random']);
  const LIST_ARGS = { rotate: 1, upcoming: 1, toSet: 0 }; // which argument is the list

  // client.name -> ['client', 'name']; a loop variable resolves to the list item it stands for
  function pathOf(node, scope) {
    if (node instanceof nodes.Symbol) {
      const name = node.value;
      if (name in scope) return scope[name];
      if (skip.has(name) || defined.has(name)) return null;
      return [name];
    }
    if (node instanceof nodes.LookupVal && node.val instanceof nodes.Literal) {
      const base = pathOf(node.target, scope);
      if (!base) return null;
      return [...base, typeof node.val.value === 'number' ? '[]' : String(node.val.value)];
    }
    return null;
  }

  function readTemplate(name, scope) {
    if (visited.has(name)) return;
    visited.add(name);
    let src;
    try { src = fs.readFileSync(path.join(TEMPLATES, name), 'utf8'); } catch (err) { return; }
    walk(parser.parse(src, [], env.opts), scope);
  }

  function walk(node, scope) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, scope)); return; }
    if (!(node instanceof nodes.Node)) return;

    if (node instanceof nodes.Symbol || node instanceof nodes.LookupVal) {
      const p = pathOf(node, scope);
      if (p) touch(p);
      else if (node instanceof nodes.LookupVal) { walk(node.target, scope); walk(node.val, scope); }
      return;
    }
    if (node instanceof nodes.For) {
      let source = node.arr;
      while (source instanceof nodes.Filter) { walk(source.args.children.slice(1), scope); source = source.args.children[0]; }
      const listPath = pathOf(source, scope);
      if (!listPath) walk(source, scope);
      const inner = Object.assign(Object.create(null), scope);
      if (node.name instanceof nodes.Array) {         // {% for key, value in object %}
        if (listPath) touch([...listPath, '{}']);
        node.name.children.forEach((s) => { inner[s.value] = null; });
      } else {
        if (listPath) touch([...listPath, '[]']);
        inner[node.name.value] = listPath ? [...listPath, '[]'] : null;
      }
      walk(node.body, inner);
      walk(node.else_, scope);
      return;
    }
    if (node instanceof nodes.Set) {
      walk(node.value, scope);
      walk(node.body, scope);
      node.targets.forEach((t) => defined.add(t.value));
      return;
    }
    if (node instanceof nodes.Macro) {                 // also {% call %} blocks
      const inner = Object.assign(Object.create(null), scope);
      node.args.children.forEach((arg) => {
        if (arg instanceof nodes.Symbol) inner[arg.value] = null;
        else if (arg instanceof nodes.KeywordArgs) {
          arg.children.forEach((pair) => { inner[pair.key.value] = null; walk(pair.value, scope); });
        }
      });
      if (node.name instanceof nodes.Symbol) defined.add(node.name.value);
      walk(node.body, inner);
      return;
    }
    if (node instanceof nodes.Filter) {
      const target = node.args.children[0];
      const p = target && pathOf(target, scope);
      if (p && LIST_FILTERS.has(node.name.value)) touch([...p, '[]']);
      else if (p && node.name.value === 'dictsort') touch([...p, '{}']);
      walk(node.args, scope);
      return;
    }
    if (node instanceof nodes.FunCall) {
      if (node.name instanceof nodes.LookupVal) {     // a method call such as name.trim()
        const p = pathOf(node.name.target, scope);
        if (p) touch(p); else walk(node.name.target, scope);
      } else if (node.name instanceof nodes.Symbol && node.name.value in LIST_ARGS) {
        const arg = node.args.children[LIST_ARGS[node.name.value]];
        const p = arg && pathOf(arg, scope);
        if (p) touch([...p, '[]']);
      } else if (node.name instanceof nodes.Symbol && node.name.value === 'jsonFromFile') {
        // jsonFromFile("x.njk") reads this template's data too. Names passed in the extra-values
        // object, such as { "item": item }, come from the caller rather than the data file.
        const target = node.args.children[0];
        const passed = node.args.children.find((a) => a instanceof nodes.Dict && !(a instanceof nodes.KeywordArgs));
        const inner = Object.assign(Object.create(null), scope);
        if (passed) {
          passed.children.forEach((pair) => {
            const key = pair.key instanceof nodes.Literal || pair.key instanceof nodes.Symbol ? String(pair.key.value) : null;
            if (key) inner[key] = pathOf(pair.value, scope);
          });
        }
        if (target instanceof nodes.Literal) readTemplate(target.value, inner);
      }
      walk(node.args, scope);
      return;
    }
    if (node instanceof nodes.Is) {                    // x is divisibleby(3): skip the test name
      walk(node.left, scope);
      if (node.right instanceof nodes.FunCall) walk(node.right.args, scope);
      return;
    }
    if (node instanceof nodes.Pair) { walk(node.value, scope); return; }
    if (node instanceof nodes.Include || node instanceof nodes.Extends) {
      if (node.template instanceof nodes.Literal) readTemplate(node.template.value, scope);
      else walk(node.template, scope);
      return;
    }
    if (node instanceof nodes.Import) { defined.add(node.target.value); return; }
    if (node instanceof nodes.FromImport) {
      node.names.children.forEach((n) => defined.add(n instanceof nodes.Pair ? n.value.value : n.value));
      return;
    }
    if (node instanceof nodes.Block) { walk(node.body, scope); return; }
    node.iterFields((value) => walk(value, scope));
  }

  // The data file's own $let and $fn expressions read data too. Their names are not data.
  const dataFile = companions(templateName).data;
  const derived = [];                                  // [expression, scope] pairs to read
  if (fs.existsSync(dataFile)) {
    const { settings } = splitData(readJson(dataFile), dataFile);
    for (const name of Object.keys(settings.$let ?? {})) { defined.add(name); derived.push([settings.$let[name], Object.create(null)]); }
    for (const [signature, body] of Object.entries(settings.$fn ?? {})) {
      const { name, params } = parseSignature(signature, path.basename(dataFile));
      defined.add(name);
      const scope = Object.create(null);
      for (const p of params) {
        if (p.fallback !== undefined) derived.push([p.fallback, Object.create(null)]);
        scope[p.name] = null;
      }
      derived.push([body, scope]);
    }
  }
  for (const [expr, scope] of derived) {
    try { walk(parser.parse('{{ ' + expr + ' }}', [], env.opts), scope); } catch (err) { /* render reports bad expressions */ }
  }

  readTemplate(templateName, Object.create(null));
  return shape;
}

// Create a template's data and state files. Existing files are never replaced:
// a data file that already exists only gets the keys it is missing.
function init(templateName) {
  const files = companions(templateName);
  if (!fs.existsSync(files.template)) throw new Error(`Template not found: ${templateName}`);
  const skeleton = inferData(templateName);
  const report = { data: path.basename(files.data), state: path.basename(files.state), createdData: false, createdState: false, addedKeys: [] };

  if (!fs.existsSync(files.data)) {
    writeJson(files.data, skeleton);
    report.createdData = true;
    report.addedKeys = Object.keys(skeleton);
  } else {
    const data = readJson(files.data);
    for (const key of Object.keys(skeleton)) {
      if (!(key in data)) { data[key] = skeleton[key]; report.addedKeys.push(key); }
    }
    if (report.addedKeys.length) writeJson(files.data, data);
  }
  if (!fs.existsSync(files.state)) {
    writeJson(files.state, {});
    report.createdState = true;
  }
  report.createdShared = [];                  // shared state files named in "$state"
  for (const file of stateFilesFor(templateName)) {
    if (file !== files.state && !fs.existsSync(file)) { writeJson(file, {}); report.createdShared.push(path.basename(file)); }
  }
  return report;
}

function describe(r) {
  const keys = r.addedKeys.length ? r.addedKeys.join(', ') : 'none';
  return [
    r.createdData ? `Created ${r.data} with keys: ${keys}` : (r.addedKeys.length ? `Added to ${r.data}: ${keys}` : `${r.data} already has every key`),
    r.createdState ? `Created ${r.state}` : `${r.state} already exists`,
    ...(r.createdShared || []).map((name) => `Created ${name}`)
  ].join('\n');
}

// Split the command line into names and options. Keys can be repeated or comma-separated:
//   --hold topic --hold invoice    --hold topic,invoice    --hold=topic,invoice
function parseArgs(argv) {
  const opts = { hold: [], reverse: [], only: null, dryRun: false };
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    let [flag, value] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s) : [argv[i]];
    if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--hold' || flag === '--only' || flag === '--reverse') {
      if (value === undefined) value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs one or more keys, such as ${flag} invoice,topic`);
      const keys = value.split(',').map((k) => k.trim()).filter(Boolean);
      if (flag === '--hold') opts.hold.push(...keys);
      else if (flag === '--reverse') opts.reverse.push(...keys);
      else opts.only = [...(opts.only || []), ...keys];
    } else if (flag.startsWith('--')) throw new Error(`Unknown option ${flag}`);
    else names.push(flag);
  }
  return { names, opts };
}

const USAGE = `Usage:
  node render.js init <template.njk> [more.njk ...]   create the data and state files
  node render.js <template.njk> [output file]         render, then save the state file

Options for rendering:
  --hold <keys>      these keys repeat last run's value; everything else moves on
  --only <keys>      only these keys move on; everything else repeats
  --reverse <keys>   these keys step back one run: counters count down, rotate() goes back
  --dry-run          print what the next run would give; save nothing
Keys are the names given to counter(), rotate(), firstTime(), reset() and remember().
Separate several with commas: --hold invoice,topic. --hold lastRun keeps lastRun too.`;

module.exports = { render, init, inferData, describe, parseArgs, stateFilesFor };

if (require.main === module) {
  try {
    const { names, opts } = parseArgs(process.argv.slice(2));
    const [command, ...rest] = names;
    const flagged = opts.hold.length || opts.reverse.length || opts.only || opts.dryRun;
    if (!command) {
      console.log(USAGE);
    } else if (command === 'init') {
      for (const name of rest) console.log(describe(init(name)));
    } else {
      if (flagged) opts.report = (lines) => console.error(lines.join('\n'));
      const out = render(command, {}, opts);
      if (rest[0] && !opts.dryRun) fs.writeFileSync(rest[0], out);
      else process.stdout.write(out);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}