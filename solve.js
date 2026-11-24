// site-generator-speed v5: a drop-in for makefun-site 1.0.0 that returns its
// answer as a JSON string instead of an object tree.
//
// The whole output is built in the JSON-escaped domain: every HTML fragment
// is generated already JSON-escaped (quotes as \", line breaks as \n), so
// run() never builds the giant answer object and main.ts never runs a
// whole-document JSON.stringify over it — it just concatenates the three
// per-case JSON strings. The final answers.json bytes are identical to
// JSON.stringify of the object-tree answer: the escaping below follows
// JSON.stringify exactly (\" \\ \b \f \n \r \t, other C0 as \u00xx,
// lone surrogates as \uXXXX, lowercase hex).
//
// Correctness contract, same as v1-v4: byte-identical answers to
// makefun-site 1.0.0 on every input. Every cache lives on the per-case
// state made fresh inside run(); nothing survives to the next case. No
// imports, no clock, no randomness: the output is a function of the
// input alone. solve.js stays a dependency-free ES module.

const REPORT = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const MAX_SLUG = 64;
const MAX_DEPTH = 8;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------- escaped-form strings ----------

// A string already in JSON-escaped form (its raw quotes, backslashes and
// control characters are escape sequences). The payload lives under a
// symbol so no dotted template path can ever reach it. Markdown HTML,
// excerpts and TOC html are E values; plain data (titles, urls, dates)
// stays raw and is escaped at its insertion point.
const ES = Symbol('esc');
class E {
  constructor(s) {
    this[ES] = s;
  }
}

const HEX = '0123456789abcdef';
function hex4(code) {
  return '\\u' + HEX[(code >> 12) & 15] + HEX[(code >> 8) & 15] + HEX[(code >> 4) & 15] + HEX[code & 15];
}

// JSON.stringify's escape for one matched character `c` at `off` in `str`.
// A paired surrogate half is returned verbatim, exactly as JSON.stringify
// leaves a valid pair alone; a lone half becomes \uXXXX.
function jsonChar(c, off, str) {
  const code = c.charCodeAt(0);
  if (c === '"') return '\\"';
  if (c === '\\') return '\\\\';
  if (code === 10) return '\\n';
  if (code === 13) return '\\r';
  if (code === 9) return '\\t';
  if (code === 8) return '\\b';
  if (code === 12) return '\\f';
  if (code >= 0xD800 && code <= 0xDBFF) {
    const d = str.charCodeAt(off + 1);
    if (d >= 0xDC00 && d <= 0xDFFF) return c;
    return hex4(code);
  }
  if (code >= 0xDC00 && code <= 0xDFFF) {
    const p = str.charCodeAt(off - 1);
    if (p >= 0xD800 && p <= 0xDBFF) return c;
    return hex4(code);
  }
  return '\\u00' + HEX[(code >> 4) & 15] + HEX[code & 15];
}

// Raw text -> JSON-escaped form (no HTML escaping).
const JESC_RE = /["\\\x00-\x1f\uD800-\uDFFF]/g;
function jsonEsc(t) {
  return t.replace(JESC_RE, jsonChar);
}

// Undo the JSON escapes this module produces (rare path: a template that
// var-inserts a markdown HTML value, which the oracle HTML-escapes).
const UNESC_RE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
function unesc(s) {
  return s.replace(UNESC_RE, (m, e) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === 'n') return '\n';
    if (e === 'r') return '\r';
    if (e === 't') return '\t';
    if (e === 'b') return '\b';
    if (e === 'f') return '\f';
    return e;
  });
}

// ---------- text ----------

// HTML escape + JSON escape in one pass: what the oracle's esc() followed
// by JSON.stringify produces, with no second pass over the string.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"'\\\x00-\x1f\uD800-\uDFFF]/g;
const esc = (t) => t.replace(ESC_RE, (c, off, str) => ESC[c] ?? jsonChar(c, off, str));

function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// only spaces/tabs (blank lines and standalone-tag padding share this test)
function spTab(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function rstrip(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

// ASCII slug: A-Z lowered, each run of other chars one "-", none at the ends, max 64.
function slugAscii(s) {
  let out = '', gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let k = 0;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    if (!k) {
      if (out.length) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(k);
  }
  out = out.slice(0, MAX_SLUG).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Per-run slugger: NFKD is the identity on ASCII, combining marks never ASCII.
function makeSlugger() {
  const cache = new Map();
  const NON_ASCII = /[^\x00-\x7F]/;
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const out = NON_ASCII.test(text)
      ? slugAscii(text.normalize('NFKD').replace(/\p{M}/gu, ''))
      : slugAscii(text);
    cache.set(text, out);
    return out;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const longDate = (d) => Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);

// Word count: runs of non-whitespace, no allocation, whitespace test inlined.
function wordsOf(t) {
  let n = 0, w = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 160 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) {
      w = false;
      continue;
    }
    if (!w) {
      w = true;
      n++;
    }
  }
  return n;
}

// ---------- front matter ----------

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isName(s) {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlug(s) {
  if (!s) return false;
  let dash = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      dash = false;
      continue;
    }
    if (c === 45 && i > 0 && !dash) {
      dash = true;
      continue;
    }
    return false;
  }
  return !dash;
}

function digitsOf(s, at, len) {
  let v = 0;
  for (let k = 0; k < len; k++) {
    const c = s.charCodeAt(at + k);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
  }
  return v;
}

// "..." with \" and \\ its only escapes, or a bare rest-of-line (never opening on " or [).
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const E = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: E };
      const y = digitsOf(raw, 0, 4), mo = digitsOf(raw, 5, 2), d = digitsOf(raw, 8, 2);
      if (y < 0 || mo < 0 || d < 0 || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: E };
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// { data, body } or { error }; the body is a slice, never split and re-joined.
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? text.length : nl + 1;
  let closeLine = -1, closeEnd = -1, lineNo = 1;
  while (pos <= text.length) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? text.length : eol;
    if (text.slice(pos, end) === '---') {
      closeLine = lineNo;
      closeEnd = eol === -1 ? text.length : eol + 1;
      break;
    }
    if (eol === -1) break;
    pos = eol + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = nl + 1;
  for (let ln = 1; ln < closeLine; ln++) {
    const eol = text.indexOf('\n', pos);
    const end = eol === -1 ? text.length : eol;
    const line = text.slice(pos, end);
    pos = eol === -1 ? text.length : eol + 1;
    if (spTab(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${ln + 1} is not "key: value"` };
    const key = line.slice(0, colon);
    let keyOk = true;
    for (let k = 0; k < key.length; k++) {
      const c = key.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) {
        keyOk = false;
        break;
      }
    }
    if (!keyOk) return { error: `line ${ln + 1} is not "key: value"` };
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = rstrip(line.slice(colon + 2));
    else return { error: `line ${ln + 1} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------- Markdown ----------
// Everything this section builds is already JSON-escaped: renderer
// literals write \" for quotes and \\n for line breaks, inline() escapes
// control characters through the shared regex, and esc() escapes both
// HTML and JSON in one pass. The joined paragraph text still uses real
// newlines as its input; inline() turns each one into \\n on the way out.

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[\\`*\[&<>"'\x00-\x09\x0b-\x1f\uD800-\uDFFF]/g;

// First index from `from` where `s` holds `what` outside a backslash escape, or -1.
function findUnescaped(s, what, from) {
  let p = s.indexOf(what, from);
  while (p !== -1) {
    let b = 0;
    for (let q = p - 1; q >= from && s[q] === '\\'; q--) b++;
    if (b % 2 === 0) return p;
    p = s.indexOf(what, p + 1);
  }
  return -1;
}

// First single * from `from` (one whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  let p = s.indexOf('*', from);
  while (p !== -1) {
    let b = 0;
    for (let q = p - 1; q >= from && s[q] === '\\'; q--) b++;
    if (b % 2 === 1) {
      p = s.indexOf('*', p + 1);
      continue;
    }
    if (s[p + 1] === '*') {
      p = s.indexOf('*', p + 2);
      continue;
    }
    return p;
  }
  return -1;
}

// `s` rendered inline, in JSON-escaped form; env.link(target) is a link's href.
function inline(s, env) {
  let out = '', i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) {
      // The tail run holds no regex special except a newline, which the
      // bulk replace below turns into its escape (C++ speed, no per-char loop).
      const tail = s.slice(i);
      out += tail.indexOf('\n') === -1 ? tail : tail.replace(/\n/g, '\\n');
      break;
    }
    const j = m.index;
    if (j > i) {
      const run = s.slice(i, j);
      out += run.indexOf('\n') === -1 ? run : run.replace(/\n/g, '\\n');
    }
    const c = s[j];
    if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        out += ESC[d] ?? (d === '\\' ? '\\\\' : d);
        i = j + 2;
      } else {
        out += '\\\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += '<strong>' + inline(s.slice(j + 2, k), env) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += '<em>' + inline(s.slice(j + 1, k), env) + '</em>';
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        out += '<a href=\\"' + esc(env.link(target)) + '\\">' + inline(s.slice(j + 1, k), env) + '</a>';
        i = m2 + 1;
      } else {
        out += '[';
        i = j + 1;
      }
      continue;
    }
    const code = s.charCodeAt(j);
    if (code < 32 || code >= 0xD800) {
      out += jsonChar(c, j, s);
      i = j + 1;
      continue;
    }
    out += ESC[c];
    i = j + 1;
  }
  return out;
}

// A fence's language, or null when `line` does not open one.
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let p = 3, lang = '';
  while (p < line.length) {
    const c = line.charCodeAt(p);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    lang += line[p];
    p++;
  }
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  return p === line.length ? lang : null;
}

function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  let p = 3;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  return p === line.length;
}

// A heading line's level and text, or null (a heading's text is never empty).
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  let p = h;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  if (p === h) return null;
  const text = rstrip(line.slice(p));
  if (text === '') return null;
  return { depth: h, text };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0), b = line.charCodeAt(1), c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let p = 3; p < line.length; p++) {
    const d = line.charCodeAt(p);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

function bulletOf(line) {
  if (line.length < 2) return null;
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let p = 0;
  while (p < line.length && line.charCodeAt(p) >= 48 && line.charCodeAt(p) <= 57) p++;
  if (p === 0 || p > 9 || p + 1 >= line.length) return null;
  if (line.charCodeAt(p) !== 46 || line.charCodeAt(p + 1) !== 32) return null;
  return { start: Number(line.slice(0, p)), text: line.slice(p + 2) };
}

// Two or more spaces, then a non-space: a list item's continuation line.
function isContinued(line) {
  let p = 0;
  while (p < line.length && line.charCodeAt(p) === 32) p++;
  return p >= 2 && p < line.length && !isWS(line.charCodeAt(p));
}

// Whether `line` ends a paragraph: blank, fence, heading or thematic break.
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return spTab(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

// `src` rendered in one pass: HTML (JSON-escaped form), TOC (level 2/3 headings) and excerpt.
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const blocks = [];
  let i = 0;

  const para = (start) => {
    const body = [trimLine(lines[start])];
    let j = start + 1;
    while (j < n && !endsParagraph(lines[j])) body.push(trimLine(lines[j++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
    return j;
  };

  const list = (start, ordered, startNum) => {
    const items = [];
    let j = start;
    while (j < n) {
      const line = lines[j];
      let text = null;
      if (ordered) {
        const o = orderedOf(line);
        if (o !== null) text = o.text;
      } else text = bulletOf(line);
      if (text !== null) {
        items.push([trimLine(text)]);
        j++;
        continue;
      }
      if (isContinued(line)) {
        items[items.length - 1].push(trimLine(line));
        j++;
        continue;
      }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    const open = ordered && startNum !== 1 ? '<ol start=\\"' + startNum + '\\">' : '<' + tag + '>';
    let html = open + '\\n';
    for (const parts of items) html += '<li>' + inline(parts.join('\n'), env) + '</li>\\n';
    html += '</' + tag + '>';
    blocks.push(html);
    return j;
  };

  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (spTab(line)) {
        i++;
        continue;
      }
      i = para(i);
      continue;
    }
    if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ' class=\\"language-' + lang + '\\"';
        blocks.push('<pre><code' + cls + '>' + (body.length === 0 ? '' : esc(body.join('\n')) + '\\n') + '</code></pre>');
        continue;
      }
      i = para(i);
      continue;
    }
    if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(env.slugify(h.text), ids);
        const html = inline(h.text, env);
        blocks.push('<h' + h.depth + ' id=\\"' + id + '\\">' + html + '</h' + h.depth + '>');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
      i = para(i);
      continue;
    }
    if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (bulletOf(line) !== null) {
        i = list(i, false, 1);
        continue;
      }
      i = para(i);
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\\n</blockquote>' : '<blockquote>\\n<p>' + inline(kept.join('\n'), env) + '</p>\\n</blockquote>');
      continue;
    }
    if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        i = list(i, true, o.start);
        continue;
      }
      i = para(i);
      continue;
    }
    i = para(i);
  }
  return { html: blocks.map((b) => b + '\\n').join(''), toc, excerpt: excerpt ?? '' };
}

// ---------- templates ----------

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

// The path `text` names, split at its dots, or a TemplateError.
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it.
// Text tokens are stored JSON-escaped: they are output verbatim.
function tokenize(name, src) {
  const tokens = [];
  let text = '', i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text: jsonEsc(text) });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = spTab(src.slice(lineStart, open)) && spTab(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text: jsonEsc(text) });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text: jsonEsc(text) });
  return tokens;
}

// `src` parsed into its tree of nodes (a TemplateError when it does not parse).
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties.
function lookup(scope, path) {
  let s = scope;
  while (s !== null) {
    if (Object.hasOwn(s.vars, path[0])) {
      let v = s.vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
    s = s.parent;
  }
  return undefined;
}

// A value as text: an already-escaped HTML value as itself, a string itself,
// a number in JavaScript's digits, true/false, an array's items joined by ", ", else "".
function textOf(v) {
  if (v instanceof E) return v[ES];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

// Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array.
function truthy(v) {
  if (v instanceof E) return v[ES] !== '';
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// `nodes` rendered into `parts` in `scope` ({ vars, parent }); B holds the parsed templates and the include depth.
// Every part appended here is already JSON-escaped.
function renderNodes(nodes, scope, B, depth, parts) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        parts.push(v instanceof E ? esc(unesc(v[ES])) : esc(textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        parts.push(v instanceof E ? v[ES] : jsonEsc(textOf(v)));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, B, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, B, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = B.templates.get(n.name);
        if (t !== undefined && depth < MAX_DEPTH) renderNodes(t, scope, B, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------- the build ----------

// 1. Sources, in code-unit order of path, line ends "\n"; a non-.md source is static.
function readSources(B) {
  const files = [...B.input.files].sort((x, y) => cmp(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      B.sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else B.statics.push({ path: f.path, content: f.content });
  }
}

// 2. Front matter: a refused source is reported and dropped, and so is a draft.
function frontMatter(B) {
  const kept = [];
  for (const s of B.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      B.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      B.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      B.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!B.templates.has(layout)) {
      B.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      B.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  B.sources = kept;
}

// 3. Output directory and url: slug made unique in its directory, in source order.
function permalinks(B) {
  const taken = new Map();
  for (const s of B.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? B.slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = B.base + '/' + s.outDir + '/';
    B.bySource.set(s.path, s);
  }
}

// Whether `target` carries a scheme (a letter, then letters/digits/+/-/. then ":").
function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

// A link target resolved to its href, cached per directory and target for
// this build; a target resolving to nothing is still recorded broken once
// per source that links to it.
function linkFor(B, dir, staticPaths, fromPath, target) {
  const key = dir + '\n' + target;
  const hit = B.linkCache.get(key);
  if (hit !== undefined) {
    if (B.brokenPairs.has(key)) B.broken.add(`broken-link ${fromPath} -> ${target}`);
    return hit;
  }
  let out;
  if (isScheme(target) || target.startsWith('/') || target.startsWith('#')) out = target;
  else {
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null && B.bySource.has(path)) out = B.bySource.get(path).url + frag;
    else if (path !== null && staticPaths.has(path)) out = B.base + '/' + path + frag;
    else {
      B.brokenPairs.add(key);
      B.broken.add(`broken-link ${fromPath} -> ${target}`);
      out = target;
    }
  }
  B.linkCache.set(key, out);
  return out;
}

// 4. Each body's Markdown, its links resolved to the pages and static files they name.
function markdown(B) {
  const staticPaths = new Set();
  for (const f of B.statics) staticPaths.add(f.path);
  for (const s of B.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => linkFor(B, dir, staticPaths, s.path, target),
      slugify: B.slugify,
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }
}

// 5. Posts, newest first then by slug; each post's newer and older neighbours.
function collections(B) {
  const posts = [];
  for (const s of B.sources) if (s.post) posts.push(s);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  B.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

// 6. Tags: grouped by slug, each named as first met in the posts' order, ordered by count then slug.
function tags(B) {
  const bySlug = new Map();
  for (const p of B.posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of (p.data.tags ?? [])) {
      const slug = B.slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: B.base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of B.sources) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of (s.data.tags ?? [])) {
      const slug = B.slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  B.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));
}

function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

function cardOf(B, s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: new E(s.excerpt),
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

function tagOf(B, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(B, p)) };
}

function pageOf(B, s) {
  const c = cardOf(B, s);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: new E(s.html),
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: new E(h.html) })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

// 7. Every page through its layout, the index pages and the tag pages through theirs.
// Each rendered page is an E value (already JSON-escaped); statics and the
// report stay raw strings and are JSON.stringified at assembly.
function layouts(B) {
  const site = { title: B.input.site.title, base_url: B.base };
  const allTags = B.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = B.posts.slice(0, B.input.site.recent).map((p) => cardOf(B, p));
  const render = (name, vars) => {
    const nodes = B.templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, B, 0, parts);
    return new E(parts.join(''));
  };
  for (const s of B.sources) B.output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(B, s) });
  const per = B.input.site.per_page;
  const pages = Math.max(1, Math.ceil(B.posts.length / per));
  const indexUrl = (k) => (k === 1 ? B.base + '/' : B.base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: B.posts.slice((k - 1) * per, k * per).map((p) => cardOf(B, p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) B.output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of B.tags) {
    const html = render('tag', { tag: tagOf(B, t) });
    if (html !== null) B.output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) B.output['tags/index.html'] = tagsHtml;
  for (const f of B.statics) {
    if (Object.hasOwn(B.output, f.path)) B.report.push(`shadowed ${f.path}: a built page has its path`);
    else B.output[f.path] = f.content;
  }
}

// 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
function reportOut(B) {
  const lines = [...B.report, ...B.broken].sort(cmp);
  let pages = 0;
  for (const s of B.sources) if (!s.post) pages++;
  lines.push(`built ${pages} pages, ${B.posts.length} posts, ${B.tags.length} tags and ${B.statics.length} static files`);
  B.output[REPORT] = lines.join('\n') + '\n';
}

// One site's answer as a JSON string: the object tree's JSON text, built
// directly so no whole-document JSON.stringify ever runs. An E value is
// already escaped and is wrapped in quotes as-is; a raw string (a static
// file, the report) goes through JSON.stringify. Key order is B.output's
// insertion order, the same order JSON.stringify would emit, so the bytes
// match the object-tree answer exactly. All caches below are created fresh
// inside this call and die with it; nothing survives to the next case.
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmp)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const B = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    brokenPairs: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
    slugify: makeSlugger(),
    linkCache: new Map(),
  };
  readSources(B);
  frontMatter(B);
  permalinks(B);
  markdown(B);
  collections(B);
  tags(B);
  layouts(B);
  reportOut(B);
  const parts = ['{'];
  let first = true;
  for (const k of Object.keys(B.output)) {
    const v = B.output[k];
    parts.push(first ? '' : ',', JSON.stringify(k), ':', v instanceof E ? '"' + v[ES] + '"' : JSON.stringify(v));
    first = false;
  }
  parts.push('}');
  return parts.join('');
}
