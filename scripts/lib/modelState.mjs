import fs from 'node:fs';

/** Complete = file exists, non-empty, and no `.part` leftover from downloadFile. */
export function isModelReady(modelPath) {
  try {
    if (fs.existsSync(modelPath + '.part')) return false;
    return fs.statSync(modelPath).size > 0;
  } catch {
    return false;
  }
}

const FILE_LINE = /^(\s+file:\s*)(\S+)(.*)$/;

function findFileLine(lines) {
  let inModel = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^model:\s*(#.*)?$/.test(lines[i])) { inModel = true; continue; }
    if (inModel && /^\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) return -1;
    if (inModel && FILE_LINE.test(lines[i])) return i;
  }
  return -1;
}

export function readModelFile(configPath) {
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const i = findFileLine(lines);
  if (i < 0) throw new Error('model.file not found in ' + configPath);
  return lines[i].match(FILE_LINE)[2];
}

export function writeModelFile(configPath, relFile) {
  const text = fs.readFileSync(configPath, 'utf8');
  const lines = text.split('\n');
  const i = findFileLine(lines);
  if (i < 0) throw new Error('model.file not found in ' + configPath);
  lines[i] = lines[i].replace(FILE_LINE, (_, a, _b, c) => a + relFile + c);
  fs.writeFileSync(configPath, lines.join('\n'));
}
