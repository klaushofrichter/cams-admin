import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';

// The strict cams-v1 schemas (contract/cams-v1/strict), compiled once.
const DIR = join(__dirname, '../../contract/cams-v1/strict');
let ajv: Ajv2020 | null = null;
function load(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ strict: false, allErrors: false });
  for (const f of readdirSync(DIR)) if (f.endsWith('.schema.json')) ajv.addSchema(JSON.parse(readFileSync(join(DIR, f), 'utf8')), f.replace(/\.schema\.json$/, ''));
  return ajv;
}

export function strictCamsValidator(name: string): (m: unknown) => boolean {
  const a = load();
  return (m) => a.validate(name, m) as boolean;
}
export function strictCamsErrors(): string {
  return JSON.stringify(load().errors ?? null);
}
