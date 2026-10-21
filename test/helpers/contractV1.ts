import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import Ajv2020 from 'ajv/dist/2020';

// The strict v1 schemas (contract/v1/strict), compiled once; the fixtures of contract/v1/fixtures.
const V1 = join(__dirname, '../../contract/v1');
let ajv: Ajv2020 | null = null;
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function load(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ strict: true, allErrors: false });
  const add = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) add(join(dir, e.name));
      else ajv!.addSchema(read(join(dir, e.name)));
    }
  };
  add(join(V1, 'strict'));
  return ajv;
}

export const strictValid = (schema: string, m: unknown): boolean => load().validate(`https://cams-admin.skylar.technology/contract/v1/strict/${schema}.schema.json`, m) as boolean;
export const strictErrors = (): string => JSON.stringify(load().errors ?? null);
export const fixtureNamed = (name: string) => ({ name, ...read(join(V1, 'fixtures', `${name}.json`)) });
export const fixtureList = () => readdirSync(join(V1, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => fixtureNamed(f.replace(/\.json$/, '')));
