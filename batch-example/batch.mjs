import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const [input, output, ...extra] = process.argv.slice(2);
const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const recipe = JSON.stringify({ edge: 1536, quality: 82, orientation: 'auto', sharp: sharp.versions });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function replaceFile(target, bytes, temporary = target + '.part-' + randomUUID()) {
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function outputMatches(target, expected) {
  try {
    return hash(await readFile(target)) === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function run() {
  if (!input || !output || extra.length) throw Error('Usage: node batch.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY');
  const source = await realpath(input);
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(output, { recursive: true });
  const destination = await realpath(output);
  if (!path.relative(source, destination)) throw Error('Use a separate output directory.');

  const names = entries.filter(e => e.isFile() && extensions.has(path.extname(e.name).toLowerCase()))
    .map(e => e.name).sort();
  const outputName = name => path.parse(name).name + '.webp';
  const outputKey = name => outputName(name).normalize('NFC').toLowerCase();
  const counts = new Map();
  for (const name of names) counts.set(outputKey(name), (counts.get(outputKey(name)) ?? 0) + 1);

  const databaseName = '.kuyum-batch.sqlite';
  const existing = await readdir(destination);
  if (existing.length && !existing.includes(databaseName)) throw Error('Choose an empty output directory for the first run.');
  const db = new DatabaseSync(path.join(destination, databaseName));
  const report = { converted: 0, skipped: 0, failed: 0, interrupted: false, elapsedMs: 0, files: [] };
  const started = performance.now();
  const stop = () => { report.interrupted = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    db.exec(`PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, output_hash TEXT NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO owner VALUES (1, ?)').run(source);
    if (db.prepare('SELECT source FROM owner WHERE id=1').get().source !== source) {
      throw Error('This output directory belongs to a different input directory.');
    }
    const lookup = db.prepare('SELECT fingerprint, output_hash FROM receipts WHERE name=?');
    const record = db.prepare('INSERT OR REPLACE INTO receipts VALUES (?, ?, ?)');

    for (const name of names) {
      if (report.interrupted) break;
      let status;
      let reason;
      try {
        const key = outputKey(name);
        if (counts.get(key) !== 1) throw Error('Several inputs would produce the same WebP filename.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const bytes = await readFile(path.join(source, name));
          const fingerprint = hash(recipe + ':' + hash(bytes));
          const target = path.join(destination, outputName(name));
          const receipt = lookup.get(key);
          if (receipt?.fingerprint === fingerprint && await outputMatches(target, receipt.output_hash)) {
            status = 'skipped';
          } else {
            const webp = await sharp(bytes, { failOn: 'warning' }).rotate()
              .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
              .webp({ quality: 82 }).toBuffer();
            // The SQLite write lock gives this worker exclusive use of this staging path.
            // A worker killed before rename may have left a partial file here.
            const staging = target + '.part';
            await rm(staging, { force: true });
            await replaceFile(target, webp, staging);
            record.run(key, fingerprint, hash(webp));
            status = 'converted';
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        status = 'failed';
        reason = error.message;
      }
      report[status]++;
      report.files.push({ name, status, ...(reason && { reason }) });
      console.log(status + '  ' + name);
    }
    report.elapsedMs = Math.round(performance.now() - started);
    await replaceFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ converted: report.converted, skipped: report.skipped, failed: report.failed, elapsedMs: report.elapsedMs }));
    process.exitCode = report.interrupted ? 130 : report.failed ? 1 : 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    db.close();
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 2; });
