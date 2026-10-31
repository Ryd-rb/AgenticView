import { z } from 'zod';

const reserved=new Set(['__proto__','prototype','constructor']);
const id=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(value=>!reserved.has(value)&&!/[\u0000-\u001f\u007f]/.test(value),'Use a safe identifier');
const time=z.number().finite().int().min(0).max(8_640_000_000_000_000);
const color=z.string().length(7).regex(/^#[0-9a-fA-F]{6}$/);
const scalar=z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()]);
function boundedRecord<T extends z.ZodType>(value:T){
  return z.preprocess((input,ctx)=>{
    if(input===null||typeof input!=='object'||Array.isArray(input))return input;
    const prototype=Object.getPrototypeOf(input),keys=Reflect.ownKeys(input);
    if((prototype!==Object.prototype&&prototype!==null)||keys.length>64||keys.some(key=>typeof key!=='string'||!Object.prototype.propertyIsEnumerable.call(input,key)||!id.safeParse(key).success)){
      ctx.addIssue({code:'custom',message:'Use at most 64 own safe record keys'});return z.NEVER;
    }
    return input;
  },z.record(id,value));
}
const scalars=boundedRecord(scalar),copies=boundedRecord(id),colors=boundedRecord(color);
export const linkedStyleSchema=z.strictObject({theme:z.enum(['graphite','paper','terminal']).optional(),accent:color.optional(),background:color.optional(),panel:color.optional(),text:color.optional(),muted:color.optional(),grid:color.optional(),kinds:colors.optional(),statuses:colors.optional(),tracks:colors.optional(),rowHeight:z.number().int().min(28).max(40).optional(),fontSize:z.number().int().min(11).max(16).optional()});
export type LinkedStyle=z.infer<typeof linkedStyleSchema>;
export const linkedColumnSchema=z.strictObject({key:id,label:z.string().max(100),fields:z.array(id).min(1).max(4).optional(),format:z.enum(['text','number','datetime','duration']).optional(),decimals:z.number().int().min(0).max(10).optional(),smallDecimals:z.number().int().min(0).max(10).optional(),decimalsField:id.optional(),scale:z.number().finite().positive().optional(),suffix:z.string().max(40).optional()});
export type LinkedColumn=z.infer<typeof linkedColumnSchema>;
export const linkedRowSchema=z.strictObject({id,parentId:id.optional(),kind:id,label:z.string().max(200).optional(),status:id.optional(),time:time.optional(),endTime:time.optional(),values:scalars}).superRefine((row,ctx)=>{if(row.endTime!==undefined&&(row.time===undefined||row.endTime<row.time))ctx.addIssue({code:'custom',message:'End time requires a start time and must not precede it'});});
export type LinkedRow=z.infer<typeof linkedRowSchema>;
export const linkedSimulationSchema=z.strictObject({id,label:z.string().max(100),parentKind:id,kind:id,status:id.optional(),parentStatus:id.optional(),allowedStatuses:z.array(id).max(32).optional(),values:scalars.optional(),copyFields:copies.optional(),parentValues:scalars.optional(),parentCopyFields:copies.optional(),timeOffsetMs:z.number().int().min(0).max(86_400_000).optional(),message:z.string().max(300).optional()});
export type LinkedSimulation=z.infer<typeof linkedSimulationSchema>;
export const linkedDataSchema=z.strictObject({
  title:z.string().max(160).optional(),entityLabel:z.string().max(100).optional(),searchLabel:z.string().max(160).optional(),searchPlaceholder:z.string().max(200).optional(),chartLabel:z.string().max(160).optional(),associationLabel:z.string().max(160).optional(),emptyLabel:z.string().max(200).optional(),
  entities:z.array(z.strictObject({id,label:z.string().max(80),plural:z.string().max(80).optional(),color:color.optional(),dash:z.enum(['solid','dash','dot']).optional(),marker:z.enum(['circle','square']).optional()})).min(1).max(32),
  columns:z.array(linkedColumnSchema).max(64),rows:z.array(linkedRowSchema).max(4000),
  series:z.array(z.strictObject({rowId:id,tracks:z.array(z.strictObject({id,label:z.string().max(100),color:color.optional(),decimals:z.number().int().min(0).max(10).optional(),points:z.array(z.strictObject({time,value:z.number().finite()})).max(256)})).min(1).max(8)})).max(500),
  associations:z.array(z.strictObject({id,from:id,to:id.optional(),label:z.string().max(200).optional()})).max(4000),
  pageSize:z.number().int().min(1).max(25).optional(),selectedId:id.optional(),style:linkedStyleSchema.optional(),simulations:z.array(linkedSimulationSchema).max(16).optional(),
}).superRefine((data,ctx)=>{
  const issue=(message:string)=>ctx.addIssue({code:'custom',message});
  const unique=(values:string[],name:string)=>{if(new Set(values).size!==values.length)issue(`${name} identifiers must be unique`);};
  unique(data.entities.map(entity=>entity.id),'Entity');unique(data.columns.map(column=>column.key),'Column');unique(data.rows.map(row=>row.id),'Row');unique(data.series.map(series=>series.rowId),'Series');unique(data.associations.map(association=>association.id),'Association');unique((data.simulations??[]).map(simulation=>simulation.id),'Simulation');
  const kinds=new Set(data.entities.map(entity=>entity.id)),rows=new Map(data.rows.map(row=>[row.id,row])),roots=new Map<string,string>();
  if(data.rows.filter(row=>row.parentId===undefined).length>500)issue('At most 500 roots');
  for(const row of data.rows){
    if(!kinds.has(row.kind))issue('Row kinds must be configured entities');
    let current:LinkedRow|undefined=row;const seen=new Set<string>();let depth=0;
    while(current){if(seen.has(current.id)||++depth>16){issue('Hierarchy must be acyclic and at most 16 nodes deep');break;}seen.add(current.id);if(current.parentId===undefined){roots.set(row.id,current.id);break;}const parent=rows.get(current.parentId);if(!parent){issue('Every parent must exist');break;}current=parent;}
  }
  let pointCount=0;
  for(const series of data.series){
    if(!rows.has(series.rowId)||rows.get(series.rowId)!.parentId!==undefined)issue('Series require a root row');unique(series.tracks.map(track=>track.id),'Track');
    for(const track of series.tracks){pointCount+=track.points.length;for(let i=1;i<track.points.length;i++)if(track.points[i]!.time<=track.points[i-1]!.time)issue('Track times must strictly increase');}
  }
  if(pointCount>24000)issue('At most 24000 total track points');
  for(const association of data.associations){const from=rows.get(association.from),to=association.to===undefined?undefined:rows.get(association.to);if(!from||from.time===undefined||association.to!==undefined&&(!to||to.time===undefined||roots.get(from.id)!==roots.get(to.id)))issue('Associations require timed rows in the same root');}
  if(data.selectedId!==undefined&&!rows.has(data.selectedId))issue('Selected row must exist');
  for(const simulation of data.simulations??[])if(!kinds.has(simulation.parentKind)||!kinds.has(simulation.kind))issue('Simulation kinds must be configured entities');
});
export type LinkedData=z.infer<typeof linkedDataSchema>;

export function rootForRow(rows:LinkedRow[],rowId:string):LinkedRow|undefined{
  const byId=new Map(rows.map(row=>[row.id,row]));let row=byId.get(rowId);const seen=new Set<string>();
  for(let depth=0;row&&depth<16;depth++){if(seen.has(row.id))return;seen.add(row.id);if(row.parentId===undefined)return row;row=byId.get(row.parentId);}return;
}
export function visibleLinkedRows(rows:LinkedRow[],expanded:Set<string>,page:number,pageSize:number,filter=''):{rows:{row:LinkedRow;depth:number}[];totalRoots:number;totalVisible:number;page:number;pages:number}{
  const byId=new Map(rows.map(row=>[row.id,row])),children=new Map<string,LinkedRow[]>(),query=filter.trim().toLowerCase(),retained=new Set<string>(),reveal=new Set<string>();
  for(const row of rows)if(row.parentId!==undefined){const siblings=children.get(row.parentId)??[];siblings.push(row);children.set(row.parentId,siblings);}
  if(query)for(const row of rows)if([row.id,row.kind,row.label,row.status,...Object.values(row.values)].some(value=>value!==undefined&&String(value).toLowerCase().includes(query))){
    let current:LinkedRow|undefined=row;for(let depth=0;current&&depth<16;depth++){retained.add(current.id);if(current.parentId!==undefined)reveal.add(current.parentId);current=current.parentId===undefined?undefined:byId.get(current.parentId);}
    const descend=(id:string,depth:number)=>{if(depth>=16)return;for(const child of children.get(id)??[]){retained.add(child.id);descend(child.id,depth+1);}};descend(row.id,0);
  }
  const roots=rows.filter(row=>row.parentId===undefined&&(!query||retained.has(row.id))),size=Number.isFinite(pageSize)?Math.max(1,Math.min(25,Math.trunc(pageSize))):12,pages=Math.max(1,Math.ceil(roots.length/size)),currentPage=Number.isFinite(page)?Math.max(0,Math.min(pages-1,Math.trunc(page))):0;
  const flatten=(root:LinkedRow)=>{const result:{row:LinkedRow;depth:number}[]=[];const visit=(row:LinkedRow,depth:number)=>{if(depth>=16||query&&!retained.has(row.id))return;result.push({row,depth});if(expanded.has(row.id)||reveal.has(row.id))for(const child of children.get(row.id)??[])visit(child,depth+1);};visit(root,0);return result;};
  return {rows:roots.slice(currentPage*size,(currentPage+1)*size).flatMap(flatten).slice(0,180),totalRoots:roots.length,totalVisible:roots.reduce((total,root)=>total+flatten(root).length,0),page:currentPage,pages};
}
export function associationLanes(data:LinkedData,rootId:string,selectedId?:string):{association:LinkedData['associations'][number];from:LinkedRow;to?:LinkedRow;lane:number}[]{
  const byId=new Map(data.rows.map(row=>[row.id,row])),scope=new Set<string>();let selected=selectedId?byId.get(selectedId):undefined;
  const roots=new Map<string,string|undefined>();const findRoot=(id:string)=>{if(roots.has(id))return roots.get(id);let row=byId.get(id),root:string|undefined;const seen=new Set<string>();for(let depth=0;row&&depth<16;depth++){if(seen.has(row.id))break;seen.add(row.id);if(row.parentId===undefined){root=row.id;break;}row=byId.get(row.parentId);}roots.set(id,root);return root;};
  for(let depth=0;selected&&selected.id!==rootId&&depth<16;depth++){scope.add(selected.id);selected=selected.parentId===undefined?undefined:byId.get(selected.parentId);}
  const compareId=(a:string,b:string)=>a<b?-1:a>b?1:0;
  return data.associations.flatMap(association=>{const from=byId.get(association.from),to=association.to?byId.get(association.to):undefined;if(!from||findRoot(from.id)!==rootId||scope.size&&!scope.has(from.id)&&(!to||!scope.has(to.id)))return [];return [{association,from,to,lane:0}];}).sort((a,b)=>(a.from.time??0)-(b.from.time??0)||compareId(a.from.id,b.from.id)||(a.to?.time??0)-(b.to?.time??0)||compareId(a.to?.id??'',b.to?.id??'')||compareId(a.association.id,b.association.id)).map((item,lane)=>({...item,lane}));
}
/** Columns may address row metadata in the renderer; this helper formats one supplied scalar only. */
export function formatLinkedValue(value:unknown,column:LinkedColumn):string{
  if(value===null||value===undefined)return '—';
  if(column.format==='datetime'){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>8_640_000_000_000_000)return '—';const date=new Date(value),pad=(part:number)=>String(part).padStart(2,'0');return `${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;}
  if(column.format==='duration'){
    if(typeof value!=='number'||!Number.isFinite(value))return '—';const absolute=Math.abs(value),suffix=absolute<1000?'ms':absolute<60000?'s':absolute<3600000?'m':absolute<86400000?'h':'d',divisor=suffix==='ms'?1:suffix==='s'?1000:suffix==='m'?60000:suffix==='h'?3600000:86400000;
    return `${Number((value/divisor).toFixed(column.decimals??(suffix==='ms'?0:1)))}${suffix}${column.suffix??''}`;
  }
  if(column.format==='number'){
    if(typeof value!=='number'||!Number.isFinite(value))return '—';const scaled=value/(column.scale??1);if(!Number.isFinite(scaled))return '—';const precision=Math.abs(scaled)<1?(column.smallDecimals??column.decimals??0):(column.decimals??0);return scaled.toFixed(precision)+(column.suffix??'');
  }
  return String(value)+(column.suffix??'');
}
