import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const appDir = path.resolve(import.meta.dirname, '../app');
const archive = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-desktop-release.mjs <app.asar>');
const require = createRequire(path.join(appDir, 'package.json'));
const packagerRequire = createRequire(require.resolve('@electron/packager'));
const asar = await import(pathToFileURL(packagerRequire.resolve('@electron/asar')).href);
const all = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
const extract = name => asar.extractFile(archive, name.replaceAll('/', path.sep));
const version = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
assert.equal(JSON.parse(extract('package.json')).version, version);
for (const required of ['node_modules/pixi.js/dist/pixi.js', 'node_modules/untitled-pixi-live2d-engine/dist/cubism.js',
  'vendor/live2dcubismcore.min.js', 'renderer/mouth-controller.js', 'safe-logging.js']) {
  assert.ok(extract(required).length > 0, `Missing runtime: ${required}`);
}
assert.ok(!all.some(name => /^(release|dist|distribution|tests)(\/|$)/.test(name)), 'Build or test artifacts leaked into package');

const ignored = name => /^(node_modules|release|dist|distribution|tests)(\/|$)/.test(name)
  || /^assets\/voice\/backups(\/|$)/.test(name) || /^vendor\/live2dcubismcore-5(?:\.|$)/.test(name)
  || ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].includes(name);
let ownFiles = 0;
function checkTree(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const name = prefix + entry.name;
    if (ignored(name)) continue;
    if (entry.isDirectory()) checkTree(path.join(directory, entry.name), name + '/');
    else if (entry.isFile()) {
      assert.ok(extract(name).equals(fs.readFileSync(path.join(directory, entry.name))), `Source/package mismatch: ${name}`);
      ownFiles++;
    }
  }
}
checkTree(appDir);

const dialogues = JSON.parse(extract('assets/voice/dialogues.json')).dialogues;
assert.equal(new Set(dialogues.map(line => line.id)).size, dialogues.length, 'Duplicate dialogue IDs');
for (const line of dialogues) {
  const wav = extract(`assets/voice/${line.file}`);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let fmt = false, data = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + size <= wav.length, `Truncated WAV: ${line.id}`);
    if (name === 'fmt ') {
      assert.equal(wav.readUInt16LE(start), 1); assert.equal(wav.readUInt16LE(start + 2), 1);
      assert.equal(wav.readUInt32LE(start + 4), 32000); assert.equal(wav.readUInt16LE(start + 14), 16);
      fmt = true;
    }
    if (name === 'data') data = size > 0;
    offset = start + size + (size % 2);
  }
  assert.ok(fmt && data, `Missing WAV data: ${line.id}`);
}

const model = JSON.parse(extract('assets/model/yukino-live2d-final.model3.json')).FileReferences;
const resources = [model.Moc, model.DisplayInfo, ...model.Textures, ...model.Expressions.map(item => item.File),
  ...Object.values(model.Motions).flat().map(item => item.File)].filter(Boolean);
for (const file of resources) assert.ok(extract(`assets/model/${file}`).length > 0, `Missing model resource: ${file}`);
console.log(JSON.stringify({version, ownFiles, wavFiles: dialogues.length, modelReferences: resources.length,
  result: 'PASS: own sources byte-identical; required browser runtimes intact; no build/test artifacts'}, null, 2));
