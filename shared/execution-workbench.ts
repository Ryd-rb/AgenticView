import { z } from 'zod';

const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'Reserved identifier');
const time = z.number().finite().int().min(0).max(8_640_000_000_000_000);
const price = z.number().finite().positive();
export const executionStatuses = ['created','running','paused','completed','error','pending','working','partially-filled','filled','cancelled','rejected','open','closed','failed'] as const;
const color = z.string().length(7).regex(/^#[0-9a-fA-F]{6}$/);
const statusColors = Object.fromEntries(executionStatuses.map(status=>[status,color.optional()])) as {[Status in typeof executionStatuses[number]]:z.ZodOptional<typeof color>};
export const executionStyleSchema = z.strictObject({theme:z.enum(['graphite','paper','terminal']).optional(),accent:color.optional(),background:color.optional(),panel:color.optional(),text:color.optional(),muted:color.optional(),grid:color.optional(),bid:color.optional(),ask:color.optional(),strategy:color.optional(),statuses:z.strictObject(statusColors).optional(),rowHeight:z.number().int().min(28).max(40).optional(),fontSize:z.number().int().min(11).max(16).optional()});
export type ExecutionStyle = z.infer<typeof executionStyleSchema>;
export const executionRowSchema = z.strictObject({
  id, parentId: id.optional(), kind: z.enum(['strategy','order','trade']), strategyId: id,
  ticker: z.string().length(7).regex(/^[A-Z]{3}\/[A-Z]{3}$/), side: z.enum(['buy','sell']), orderType: z.enum(['limit','stop-loss']),
  status: z.enum(executionStatuses), quantity: z.number().finite().positive().max(1e12), bid: price, ask: price,
  start: time, end: time.optional(), filledQuantity: z.number().finite().nonnegative(), filledPrice: price.optional(), error: z.string().max(500).optional(),
}).superRefine((row, ctx) => {
  if (row.ask < row.bid) ctx.addIssue({code:'custom', message:'Ask must be at least bid'});
  if (row.end !== undefined && row.end < row.start) ctx.addIssue({code:'custom',message:'End must not precede start'});
  if (row.filledQuantity > row.quantity) ctx.addIssue({code:'custom',message:'Filled quantity exceeds quantity'});
});
export type ExecutionRow = z.infer<typeof executionRowSchema>;
export const executionDataSchema = z.strictObject({
  rows: z.array(executionRowSchema).max(4000),
  series: z.array(z.strictObject({strategyId:id, points:z.array(z.strictObject({time,bid:price,ask:price})).min(2).max(256)})).max(500),
  pageSize: z.number().int().min(1).max(25).optional(), selectedId:id.optional(), demo:z.boolean().optional(), style:executionStyleSchema.optional(),
}).superRefine((data,ctx) => {
  const issue = (message:string) => ctx.addIssue({code:'custom',message});
  const rows = new Map(data.rows.map(row => [row.id,row]));
  if (rows.size !== data.rows.length) issue('Row identifiers must be unique');
  if (data.rows.filter(row => row.kind==='strategy').length > 500) issue('At most 500 strategies');
  for (const row of data.rows) {
    if (row.kind === 'strategy') { if (row.parentId !== undefined || row.id !== row.strategyId) issue('Strategies must be roots with matching strategy identifiers'); }
    else {
      const parent = rows.get(row.parentId ?? '');
      if (!parent || parent.kind !== (row.kind==='order'?'strategy':'order') || row.strategyId!==parent.strategyId || row.ticker!==parent.ticker || row.start<parent.start) issue('Invalid execution hierarchy or parent association');
    }
  }
  const seen = new Set<string>(); let count = 0;
  for (const series of data.series) {
    if (seen.has(series.strategyId) || rows.get(series.strategyId)?.kind !== 'strategy') issue('Series require unique strategy roots');
    seen.add(series.strategyId); count += series.points.length;
    for (let i=0;i<series.points.length;i++) { const point=series.points[i]!; if(point.ask<point.bid || i>0&&point.time<=series.points[i-1]!.time) issue('Series times must increase and ask must be at least bid'); }
  }
  if (count > 12000) issue('At most 12000 price points');
  if (data.selectedId !== undefined && !rows.has(data.selectedId)) issue('Selected row must exist');
});
export type ExecutionData = z.infer<typeof executionDataSchema>;

export function formatQuantity(value:number):string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.abs(value)>=1_000_000 ? Math.round(value/1_000_000) : Number((value/1_000_000).toFixed(6))} mio`;
}
export function strategyForRow(rows:ExecutionRow[], rowId:string):ExecutionRow|undefined {
  const row = rows.find(item => item.id===rowId);
  return row && rows.find(item => item.id===row.strategyId && item.kind==='strategy');
}
const ordered = (rows:ExecutionRow[]) => [...rows].sort((a,b)=>a.start-b.start || (a.id<b.id?-1:a.id>b.id?1:0));
export function executionLanes(rows:ExecutionRow[], strategyId:string):{order:ExecutionRow;trade?:ExecutionRow;lane:number}[] {
  const result:{order:ExecutionRow;trade?:ExecutionRow;lane:number}[]=[];
  const children = new Map<string,ExecutionRow[]>();
  for(const row of rows) if(row.parentId) {const siblings=children.get(row.parentId)??[];siblings.push(row);children.set(row.parentId,siblings);}
  for(const order of ordered(children.get(strategyId)??[]).filter(row=>row.kind==='order')) {
    const trades=ordered(children.get(order.id)??[]).filter(row=>row.kind==='trade');
    if(!trades.length) result.push({order,lane:result.length});
    else for(const trade of trades) result.push({order,trade,lane:result.length});
  }
  return result;
}
export function visibleExecutionRows(rows:ExecutionRow[], expanded:Set<string>, page:number, pageSize:number, filter=''):{rows:{row:ExecutionRow;depth:number}[];totalStrategies:number;totalVisible:number;page:number;pages:number} {
  const query=filter.trim().toLowerCase(), children=new Map<string,ExecutionRow[]>(), byId=new Map(rows.map(row=>[row.id,row]));
  for(const row of rows) if(row.parentId) {const siblings=children.get(row.parentId)??[];siblings.push(row);children.set(row.parentId,siblings);}
  const retained=new Set<string>(), reveal=new Set<string>();
  if(query) for(const row of rows) if(Object.values(row).some(value=>String(value).toLowerCase().includes(query))) {
    let current:ExecutionRow|undefined=row;
    for(let depth=0;current&&depth<3;depth++) {retained.add(current.id);if(current.parentId)reveal.add(current.parentId);current=current.parentId?byId.get(current.parentId):undefined;}
    // Matching a parent keeps its complete subtree available for expansion.
    const descend=(id:string,depth:number)=>{if(depth>2)return;for(const child of children.get(id)??[]){retained.add(child.id);descend(child.id,depth+1);}};
    descend(row.id,0);
  }
  const roots=rows.filter(row=>row.kind==='strategy'&&(!query||retained.has(row.id)));
  const size=Number.isFinite(pageSize)?Math.max(1,Math.min(25,Math.trunc(pageSize))):12;
  const pages=Math.max(1,Math.ceil(roots.length/size)), currentPage=Number.isFinite(page)?Math.max(0,Math.min(pages-1,Math.trunc(page))):0;
  const flatten=(root:ExecutionRow)=>{const result:{row:ExecutionRow;depth:number}[]=[];const visit=(row:ExecutionRow,depth:number)=>{if(depth>2||query&&!retained.has(row.id))return;result.push({row,depth});if(expanded.has(row.id)||reveal.has(row.id))for(const child of children.get(row.id)??[])visit(child,depth+1);};visit(root,0);return result;};
  const totalVisible=roots.reduce((total,root)=>total+flatten(root).length,0);
  return {rows:roots.slice(currentPage*size,(currentPage+1)*size).flatMap(flatten).slice(0,180),totalStrategies:roots.length,totalVisible,page:currentPage,pages};
}
