import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const cli = path.join(import.meta.dirname, 'batch.mjs');
const fixture = name => path.join(import.meta.dirname, 'examples', 'input', name);

async function setup(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kuyum-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const input = path.join(parent, 'input');
  const output = path.join(parent, 'output');
  await mkdir(input);
  return { input, output };
}

function start(input, output) {
  const child = spawn(process.execPath, [cli, input, output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  const done = once(child, 'close').then(([code]) => ({ code, diagnostic }));
  return { child, done };
}

async function batch(input, output, expectedCode = 0) {
  const {child, done} = start(input, output);
  child.stdout.resume();
  const {code, diagnostic} = await done;
  assert.equal(code, expectedCode, diagnostic);
  return JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
}

test('continue past corrupt input, then skip valid outputs and retry the repaired file', async t => {
  const {input, output} = await setup(t);
  await writeFile(path.join(input, 'A.jpg'), 'invalid bytes');
  await copyFile(fixture('RING-01.png'), path.join(input, 'B.png'));
  const first = await batch(input, output, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.files[0].name, 'A.jpg');
  assert.ok(first.files[0].reason);
  assert.equal(first.converted, 1);
  const expected = path.join(output, 'B.webp');
  const timestamp = (await stat(expected)).mtimeMs;
  await sharp(fixture('RING-02.png')).jpeg().toFile(path.join(input, 'A.jpg'));
  const retry = await batch(input, output);
  assert.equal(retry.converted, 1);
  assert.equal(retry.skipped, 1);
  assert.equal((await stat(expected)).mtimeMs, timestamp);
  assert.equal((await sharp(await readFile(expected)).metadata()).format, 'webp');
});

test('rebuild a changed input and a tampered or missing output', async t => {
  const {input, output} = await setup(t);
  const source = path.join(input, 'R.png');
  const target = path.join(output, 'R.webp');
  await copyFile(fixture('RING-01.png'), source);
  await batch(input, output);
  const original = await readFile(target);
  await copyFile(fixture('RING-02.png'), source);
  assert.equal((await batch(input, output)).converted, 1);
  const changed = await readFile(target);
  assert.notDeepEqual(original, changed);
  await writeFile(target, 'damaged');
  assert.equal((await batch(input, output)).converted, 1);
  assert.deepEqual(await readFile(target), changed);
  await rm(target);
  assert.equal((await batch(input, output)).converted, 1);
});

test('reject duplicate output names without discarding either source', async t => {
  const {input, output} = await setup(t);
  await copyFile(fixture('RING-01.png'), path.join(input, 'R.png'));
  await sharp(fixture('RING-02.png')).jpeg().toFile(path.join(input, 'R.jpg'));
  const report = await batch(input, output, 1);
  assert.equal(report.failed, 2);
  await assert.rejects(stat(path.join(output, 'R.webp')), { code: 'ENOENT' });
});

test('restart a killed worker and reuse the files it already finished', async t => {
  const {input, output} = await setup(t);
  for (let i = 0; i < 24; i++) {
    await copyFile(fixture('RING-01.png'), path.join(input, String(i).padStart(2, '0') + '.png'));
  }
  const {child, done} = start(input, output);
  child.stdout.once('data', () => child.kill('SIGKILL'));
  await done;
  const resumed = await batch(input, output);
  assert.ok(resumed.skipped >= 1 && resumed.converted >= 1);
  assert.equal(resumed.skipped + resumed.converted, 24);
});

test('overlapping runs leave a complete set of reusable outputs', async t => {
  const {input, output} = await setup(t);
  for (let i = 0; i < 8; i++) await copyFile(fixture('RING-02.png'), path.join(input, i + '.png'));
  const jobs = [start(input, output), start(input, output)];
  for (const job of jobs) job.child.stdout.resume();
  for (const result of await Promise.all(jobs.map(job => job.done))) assert.equal(result.code, 0, result.diagnostic);
  assert.equal((await batch(input, output)).skipped, 8);
});
