#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const TARGET_DIR = process.argv[2] || 'dist-server.next';

if (!fs.existsSync(TARGET_DIR)) {
  console.log(`[obfuscate] Target directory ${TARGET_DIR} does not exist, skipping.`);
  process.exit(0);
}

function findFiles(dir, predicate) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

// 1. Remove any source map files
const mapFiles = findFiles(TARGET_DIR, (f) => f.endsWith('.map'));
for (const mapFile of mapFiles) {
  fs.unlinkSync(mapFile);
}
if (mapFiles.length > 0) {
  console.log(`[obfuscate] Removed ${mapFiles.length} source map files.`);
}

// 2. Obfuscate all .js files
const jsFiles = findFiles(TARGET_DIR, (f) => f.endsWith('.js'));
console.log(`[obfuscate] Obfuscating ${jsFiles.length} server files in ${TARGET_DIR}...`);

const start = Date.now();
let count = 0;

for (const jsFile of jsFiles) {
  try {
    const originalCode = fs.readFileSync(jsFile, 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(originalCode, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'hexadecimal',
      log: false,
      numbersToExpressions: false,
      renameGlobals: false,
      selfDefending: false,
      simplify: true,
      splitStrings: false,
      stringArray: true,
      stringArrayCallsTransform: false,
      stringArrayEncoding: ['base64'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayThreshold: 0.75,
      stringArrayWrappersCount: 1,
      stringArrayWrappersType: 'variable',
      target: 'node',
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    }).getObfuscatedCode();

    fs.writeFileSync(jsFile, obfuscated, 'utf8');
    count += 1;
  } catch (error) {
    console.error(`[obfuscate] Failed to obfuscate ${jsFile}:`, error);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`[obfuscate] Successfully obfuscated ${count}/${jsFiles.length} files in ${elapsed}s.`);
