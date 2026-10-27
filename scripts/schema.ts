import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { componentSchema } from '../shared/protocol.ts';

writeFileSync('shared/components.schema.json', JSON.stringify(z.toJSONSchema(componentSchema, { io: 'input' }), null, 2) + '\n');
