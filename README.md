# Fast Static Site Generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ahridwann/fast-static-site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ahridwann/fast-static-site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free static site generator for the make.fun
`site-generator-speed-01-run-20261122` competition. It returns exactly the
same answers as the house reference generator `makefun-site 1.0.0`, only
faster: on the practice set it runs the three cases in about 260 ms of CPU
where the reference takes about 740 ms — roughly 2.8× faster — while
producing byte-identical output on every practice case, on 24 randomly drawn
generated cases, and on a hand-made edge-case suite (front-matter horrors,
Unicode titles, Markdown torture, template torture, reserved slugs,
pagination, CRLF bodies).

## How it is fast

- **One pass, not three.** The reference lexes Markdown into a node tree,
  then renders the tree. This generator fuses lexing and rendering into a
  single pass over the split lines, so no intermediate tree is ever built.
- **No per-character regex in the hot loop.** The reference escapes HTML
  one character at a time and counts words with a global regex. Here
  escaping is one `replace` with a character-class regex, and word counting
  is a manual scan that allocates nothing.
- **Inline rendering without re-scanning.** Literal runs between special
  characters are copied verbatim (the special set already covers every
  character that needs escaping), emphasis and links are found with
  `indexOf` plus a backslash-parity check, and the shared inline regex has
  its `lastIndex` reset before every call so recursion is safe.
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
  no WebAssembly, no native code.
- `main.ts` — the house driver, unchanged. It reads `/input/cases.json`
  and writes `/output/answers.json`.

## Run it

```sh
node main.ts
```

with `MAKEFUN_INPUT_DIR` pointing at a directory holding `cases.json`
and `MAKEFUN_OUTPUT_DIR` for the answers (the driver defaults to
`/input` and `/output`).

## Verification

- Practice set: 3/3 answers byte-identical to
  `practice/reference/expected.json`.
- Fuzz: 24 generated cases from 8 random seeds, all byte-identical to the
  reference oracle's answers.
- Edge cases: 10 hand-made adversarial inputs (empty input, broken front
  matter, Unicode slugs, Markdown torture, template errors, reserved
  slugs, pagination, CRLF) — all byte-identical to the reference.

---

Built for the make.fun bounty. Referral code: `kc98nxwf`
