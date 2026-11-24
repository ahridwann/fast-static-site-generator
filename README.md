# Fast Static Site Generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ahridwann/fast-static-site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ahridwann/fast-static-site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free static site generator for the make.fun
`site-generator-speed-01-run-20261122` competition. It returns exactly the
same answers as the house reference generator `makefun-site 1.0.0`, only
faster: on the practice set it runs the three cases in about 464 ms of
cold CPU where the first version takes about 499 ms — roughly 7% faster —
while producing byte-identical output on every practice case, on 24
randomly drawn generated cases, and on a hand-made edge-case suite
(front-matter horrors, Unicode titles, Markdown torture, template
torture, reserved slugs, pagination, CRLF bodies).

This is version 5 of the entry. The earlier versions won on warm timings
but tied the first version cold, in a fresh process — which is how the
server measures. So this version builds its answer in the JSON-escaped
domain instead of restructuring the parser again: every HTML fragment is
generated already JSON-escaped, `run()` returns the answer as a JSON
string, and the driver only concatenates the three per-case strings, so
no whole-document `JSON.stringify` ever runs. The escaping follows
`JSON.stringify` exactly, so the written bytes are identical.

Honest status: the design is correct and verified, but the escaping work
inside `run()` costs almost exactly what the skipped `JSON.stringify`
saves, so cold it ties version 4 and beats version 1 by only ~7% — short
of the 15% cold win the entry needs to be worth submitting as a
replacement. It is kept as a verified build, not a submission claim.

## How it is fast

- **No object tree, no whole-document stringify.** The reference builds
  an object of every output path, then stringifies ~7.4 MB of it. Here
  `run()` builds the answer's JSON text directly: HTML is emitted
  already escaped (`\"` for quotes, `\n` for line breaks), template text
  is pre-escaped once per parse, and values are escaped at their
  insertion point — one fused pass instead of a second pass over the
  whole document.
- **One pass, not three.** The reference lexes Markdown into a node tree,
  then renders the tree. This generator fuses lexing and rendering into a
  single pass over the split lines, so no intermediate tree is ever built.
- **No per-character regex in the hot loop.** The reference escapes HTML
  one character at a time and counts words with a global regex. Here
  escaping is one `replace` with a character-class regex, and word
  counting is a manual scan that allocates nothing.
- **Inline rendering without re-scanning.** Literal runs between special
  characters are copied verbatim (newlines in a run are escaped in bulk,
  in C++ speed); emphasis and links are found with `indexOf` plus a
  backslash-parity check, and the shared inline regex has its `lastIndex`
  reset before every call so recursion is safe.
- **Caches scoped to one run.** Slugification, link resolution and per-post
  cards are cached inside a single `run()` call and never leak between
  cases, so repeated titles, tags and links cost almost nothing the second
  time.
- **Hand-rolled everything in the hot path.** Front matter is parsed by a
  manual line scan (no split of the body), templates are tokenized once per
  run and rendered with plain loops instead of `forEach`, and sorting uses
  code-unit comparison directly.

## Layout

- `solve.js` — the whole generator: text helpers, front matter, Markdown,
  templates, and the build pipeline. ES module, Node 22, no dependencies,
  no WebAssembly, no native code. `run(input)` returns one case's answer
  as a JSON string.
- `main.ts` — the driver the harness runs. It reads `/input/cases.json`,
  answers each case with `run()`, and writes `/output/answers.json` by
  concatenating the per-case JSON strings — byte-identical to
  `JSON.stringify` of the answers array.
- `package.json` — `{"type": "module"}`.

## Run it

```sh
node main.ts
```

with `MAKEFUN_INPUT_DIR` pointing at a directory holding `cases.json`
and `MAKEFUN_OUTPUT_DIR` for the answers (the driver defaults to
`/input` and `/output`).

## Verification

- Practice set: 3/3 answers byte-identical to
  `practice/reference/expected.json` (raw concatenated bytes, no
  re-stringify, so an escaping bug cannot hide) and to the oracle.
- Fuzz: 24 generated cases from 8 random seeds, all byte-identical to the
  reference oracle's answers.
- Edge cases: 10 hand-made adversarial inputs (empty input, broken front
  matter, Unicode slugs, Markdown torture, template errors, reserved
  slugs, pagination, CRLF) — all byte-identical to the reference,
  including a template that var-inserts page content (the unescape path).
- Determinism: the driver run twice in separate processes, byte-identical.
- Cache scope: case B after case A in the same process vs case B alone in
  a fresh process — identical.
- Cold measurement (fresh process per sample, 8 interleaved rounds):
  v5 464 ms vs v1 499 ms total, v4 464 ms. Warm `run()` only: v5 234 ms
  vs v1 220 ms (v5 wins warm in total because it skips the stringify).

---

Built for the make.fun bounty. Referral code: `kc98nxwf`
