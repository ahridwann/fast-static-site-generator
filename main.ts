// site-generator-speed v5 driver: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json, answers each one
// alone with run() from solve.js, and writes /output/answers.json.
//
// Unlike the house driver, this one does not build an answers array and
// JSON.stringify it: run() already returns each case's answer as a JSON
// string (built in the JSON-escaped domain), so the driver only
// concatenates the three strings into the JSON array. The written bytes
// are exactly JSON.stringify's bytes for the same answers. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => string };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const parts: string[] = ['['];
for (let i = 0; i < cases.length; i++) {
  if (i > 0) parts.push(',');
  parts.push(run(cases[i].input));
}
parts.push(']');
writeFileSync(join(OUTPUT_DIR, 'answers.json'), parts.join(''));
