import { z } from 'zod';
import { componentSchema, idSchema } from './protocol.js';

const field = z.strictObject({ key:idSchema, label:z.string().min(1).max(160), type:z.enum(['text','multiline','number','select','toggle','json']), required:z.boolean().optional(), options:z.array(z.string().max(500)).min(1).max(100).optional(), min:z.number().finite().optional(), max:z.number().finite().optional() });
const action = z.strictObject({ id:idSchema, label:z.string().min(1).max(160), kind:z.enum(['command','prompt','query','edit','history','logs','custom']), target:idSchema, handler:idSchema.optional(), description:z.string().max(2000).optional(), confirmation:z.string().max(2000).optional(), fields:z.array(field).max(24).optional() });
/** An authored application definition. Runtime bindings and telemetry are deliberately outside this format. */
export const applicationManifestSchema = z.strictObject({
  schemaVersion:z.literal(1), id:idSchema, version:z.string().min(1).max(80), name:z.string().min(1).max(160), description:z.string().max(2000).optional(), permanent:z.literal(true),
  bindings:z.array(z.strictObject({id:idSchema,label:z.string().min(1).max(160),description:z.string().max(2000).optional()})).max(64),
  actions:z.array(action).max(64), components:z.array(componentSchema).max(64),
  layout:z.strictObject({width:z.number().min(320).max(1600),height:z.number().min(240).max(1600),sizing:z.enum(['content','fixed'])}).optional(),
}).superRefine((manifest,ctx)=>{
  const bindings=new Set(manifest.bindings.map(b=>b.id));
  if(bindings.size!==manifest.bindings.length || bindings.has('agent')) ctx.addIssue({code:'custom',message:'Binding IDs must be unique; agent is reserved.'});
  if(new Set(manifest.actions.map(a=>a.id)).size!==manifest.actions.length) ctx.addIssue({code:'custom',message:'Action IDs must be unique.'});
  if(new Set(manifest.components.map(c=>c.id)).size!==manifest.components.length) ctx.addIssue({code:'custom',message:'Component IDs must be unique.'});
  for(const a of manifest.actions){
    if(a.target!=='agent' && (!bindings.has(a.target)||!a.handler)) ctx.addIssue({code:'custom',message:`Action ${a.id} requires a declared binding and handler.`});
    if(new Set(a.fields?.map(f=>f.key)).size!==(a.fields?.length??0)) ctx.addIssue({code:'custom',message:`Action ${a.id} has duplicate fields.`});
    for(const f of a.fields??[]){if(f.type==='select' && !f.options) ctx.addIssue({code:'custom',message:`Field ${f.key} requires options.`});if(f.min!==undefined&&f.max!==undefined&&f.min>f.max)ctx.addIssue({code:'custom',message:`Field ${f.key} range is inverted.`});}
  }
  const kinds=new Map(manifest.actions.map(a=>[a.id,a.kind]));
  const reference=(id:string,kind?:string)=>{if(!kinds.has(id)||(kind&&kinds.get(id)!==kind))ctx.addIssue({code:'custom',message:`Component references unavailable or incompatible action ${id}.`});};
  for(const c of manifest.components){if(c.kind==='action-panel')c.data.actionIds.forEach(id=>reference(id));if(c.kind==='log-stream')reference(c.data.actionId,'logs');if(c.kind==='table'&&c.data.sourceAction)reference(c.data.sourceAction,'query');if(c.kind==='data-grid'){for(const key of ['readAction','editAction','addAction','deleteAction','bulkAction','historyAction'] as const){const id=c.data[key];if(id)reference(id,key==='readAction'?'query':key==='historyAction'?'history':'edit');}}}
});
export type ApplicationManifest=z.infer<typeof applicationManifestSchema>;
