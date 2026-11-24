import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';

const file = path.join(ROOT, 'AGREEMENT.md');

// The version is a hash of the text, so changing the agreement automatically makes everyone accept it again.
export function loadAgreement() {
  const text = fs.readFileSync(file, 'utf8');
  const version = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  return { text, version };
}
