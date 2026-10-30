import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { componentSchema } from '../shared/protocol.ts';
import { applicationManifestSchema } from '../shared/application-manifest.ts';

writeFileSync('shared/components.schema.json', JSON.stringify(z.toJSONSchema(componentSchema, { io: 'input', reused: 'ref' }), null, 2) + '\n');
writeFileSync('shared/application-manifest.schema.json', JSON.stringify(z.toJSONSchema(applicationManifestSchema, { io: 'input', reused: 'ref' }), null, 2) + '\n');
