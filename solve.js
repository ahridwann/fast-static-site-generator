// site-generator-speed: a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build()
// returns for the same input: a JSON object of every path it writes and that
// file's text, byte for byte. Same semantics, faster primitives:
//
//   - the Markdown inline pass scans for the next special character with one
//     regex instead of walking every character through a regex escape;
//   - the block lexer dispatches on the first character instead of testing
//     seven patterns on every line, and renders blocks in the same pass
//     instead of building a token array first;
//   - slugs are cached per build and take an ASCII fast path (NFKD is the
//     identity on ASCII, and combining marks are never ASCII);
//   - front matter is scanned line by line without splitting the body;
//   - template rendering appends into one parts array instead of returning
//     a fresh string per node, and loops use for instead of forEach;
//   - word counting scans without a regex or an allocation.
//
// Nothing is cached from one case to the next: every cache below lives on
// the per-case build state. No imports, no dependencies, no clock, no
// environment, no randomness: the output is a function of the input alone.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const INCLUDE_DEPTH = 8;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------- text ----------

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** Whether the UTF-16 code unit `code` is JavaScript whitespace (\s). */
function isWS(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 160 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** `s` with trailing spaces and tabs dropped. */
function stripTrailingWS(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

/** Whether `line` is empty or spaces and tabs only. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `s` holds only spaces and tabs. */
function isSpacesTabs(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The slug of ASCII text: A-Z lowered, every run of other characters one "-", none at either end, at most 64. */
function slugAscii(s) {
  let out = '';
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** A slug function with a per-build cache. NFKD is the identity on ASCII and combining marks are never ASCII. */
function makeSlugger() {
  const cache = new Map();
  const NON_ASCII = /[^\x00-\x7F]/;
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let out;
    if (!NON_ASCII.test(text)) out = slugAscii(text);
    else out = slugAscii(text.normalize('NFKD').replace(/\p{M}/gu, ''));
    cache.set(text, out);
    return out;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------- front matter ----------

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether every character of `s` is a-z or 0-9 or "-". */
function isName(s) {
  if (s === '') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: alphanumerics in groups of one or more, single "-" between. */
function isSlug(s) {
  if (s === '') return false;
  let prevDash = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
    if (alnum) {
      prevDash = false;
      continue;
    }
    if (c === 45 && i > 0 && !prevDash) {
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

/** The number in `s` from `at` for `len` digits, or -1 when any of them is not a digit. */
function digitsOf(s, at, len) {
  let v = 0;
  for (let k = 0; k < len; k++) {
    const c = s.charCodeAt(at + k);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
  }
  return v;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
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

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
      const y = digitsOf(raw, 0, 4);
      const mo = digitsOf(raw, 5, 2);
      const d = digitsOf(raw, 8, 2);
      if (y < 0 || mo < 0 || d < 0 || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
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

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Scanned line by line: the body is a slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl === -1 ? text.length : nl + 1;
  let closeLine = -1;
  let closeEnd = -1;
  let lineNo = 1;
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
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
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
    else if (line.charCodeAt(colon + 1) === 32) raw = stripTrailingWS(line.slice(colon + 2));
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

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The characters inline rendering treats as special. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * Found with indexOf: a match is skipped only when the run of backslashes right before it is odd.
 */
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

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
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

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) {
      out += s.slice(i);
      break;
    }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        out += ESCAPES[d] ?? d;
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>';
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
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(j + 1, k), env) + '</a>';
        i = m2 + 1;
      } else {
        out += '[';
        i = j + 1;
      }
      continue;
    }
    out += ESCAPES[c];
    i = j + 1;
  }
  return out;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let p = 3;
  let lang = '';
  while (p < line.length) {
    const c = line.charCodeAt(p);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    lang += line[p];
    p++;
  }
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  return p === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (!line.startsWith('```')) return false;
  let p = 3;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  return p === line.length;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  let p = h;
  while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  if (p === h) return null;
  const text = stripTrailingWS(line.slice(p));
  if (text === '') return null;
  return { depth: h, text };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let p = 3; p < line.length; p++) {
    const d = line.charCodeAt(p);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletOf(line) {
  if (line.length < 2) return null;
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null when `line` does not open one. */
function orderedOf(line) {
  let p = 0;
  while (p < line.length && line.charCodeAt(p) >= 48 && line.charCodeAt(p) <= 57) p++;
  if (p === 0 || p > 9) return null;
  if (p + 1 >= line.length) return null;
  if (line.charCodeAt(p) !== 46 || line.charCodeAt(p + 1) !== 32) return null;
  return { start: Number(line.slice(0, p)), text: line.slice(p + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let p = 0;
  while (p < line.length && line.charCodeAt(p) === 32) p++;
  if (p < 2 || p >= line.length) return false;
  return !isWS(line.charCodeAt(p));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level
 * 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lexed and rendered in one pass, straight from the split lines.
 */
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
      } else {
        text = bulletOf(line);
      }
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
    const open = ordered && startNum !== 1 ? '<ol start="' + startNum + '">' : '<' + tag + '>';
    let html = open + '\n';
    for (const parts of items) html += '<li>' + inline(parts.join('\n'), env) + '</li>\n';
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
      if (isBlankLine(line)) {
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
        const cls = lang === '' ? '' : ' class="language-' + lang + '"';
        blocks.push('<pre><code' + cls + '>' + (body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n') + '</code></pre>');
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
        blocks.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>');
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
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(kept.join('\n'), env) + '</p>\n</blockquote>');
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
  return { html: blocks.map((b) => b + '\n').join(''), toc, excerpt: excerpt ?? '' };
}

// ---------- templates ----------

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
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
      if (text !== '') tokens.push({ t: 'text', text });
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
    const standalone = isSpacesTabs(src.slice(lineStart, open)) && isSpacesTabs(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
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

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
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

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `parts` in `scope` ({ vars, parent }). `B` holds the parsed templates (`templates`, a Map
 * of name to nodes; a template that did not parse is absent) and the include depth.
 */
function renderNodes(nodes, scope, B, depth, parts) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(scope, n.path)));
        break;
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
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, B, depth + 1, parts);
        break;
      }
    }
  }
}

// ---------- the build ----------

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(B) {
  const files = [...B.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      B.sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else B.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
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

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
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

/** Whether `target` carries a scheme (a letter, then letters, digits, +, - or ., then ":"). */
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

/** A link target resolved to its href, cached per directory and target for this build. A target that resolves to
 * nothing is still recorded broken once per source that links to it. */
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

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
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

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(B) {
  const posts = [];
  for (const s of B.sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  B.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
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
  B.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A tag as templates read it (its posts as cards). */
function tagOf(B, t) {
  return { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(B, p)) };
}

/** A post's card, as lists show it. Built once per source and kept. */
function cardOf(B, s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. */
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
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(B) {
  for (const p of B.posts) B.cards.set(p, cardOf(B, p));
  const site = { title: B.input.site.title, base_url: B.base };
  const allTags = B.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = B.posts.slice(0, B.input.site.recent).map((p) => B.cards.get(p));
  const render = (name, vars) => {
    const nodes = B.templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, B, 0, parts);
    return parts.join('');
  };
  for (const s of B.sources) B.output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(B, s) });
  const per = B.input.site.per_page;
  const pages = Math.max(1, Math.ceil(B.posts.length / per));
  const indexUrl = (k) => (k === 1 ? B.base + '/' : B.base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: B.posts.slice((k - 1) * per, k * per).map((p) => B.cards.get(p)),
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

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function reportOut(B) {
  const lines = [...B.report, ...B.broken].sort(byCodeUnits);
  let pages = 0;
  for (const s of B.sources) if (!s.post) pages++;
  lines.push(`built ${pages} pages, ${B.posts.length} posts, ${B.tags.length} tags and ${B.statics.length} static files`);
  B.output[REPORT_FILE] = lines.join('\n') + '\n';
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
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
    cards: new Map(),
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
  return B.output;
}
