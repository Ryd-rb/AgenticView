import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executionDataSchema, executionStyleSchema, executionLanes, formatQuantity, strategyForRow, visibleExecutionRows, type ExecutionData, type ExecutionRow } from '../shared/execution-workbench.ts';
import { forexExecutionExample, forexExecutionManifest } from '../scripts/forex-example.ts';

function sample():ExecutionData {
  const strategy:ExecutionRow={id:'s',kind:'strategy',strategyId:'s',ticker:'EUR/USD',side:'buy',orderType:'limit',status:'running',quantity:1e6,bid:1.08,ask:1.0805,start:100,end:200,filledQuantity:5e5};
  const order:ExecutionRow={...strategy,id:'o',parentId:'s',kind:'order',status:'partially-filled',start:110};
  return {rows:[strategy,order,{...order,id:'t',parentId:'o',kind:'trade',status:'open',start:120,quantity:5e5,filledQuantity:5e5}],series:[{strategyId:'s',points:[{time:100,bid:1.08,ask:1.0805},{time:200,bid:1.09,ask:1.0905}]}]};
}
test('execution schema preserves absent optional settings and rejects broken associations',()=>{
  const data=sample();assert.deepEqual(executionDataSchema.parse(data),data);
  assert.deepEqual(executionDataSchema.parse({rows:[],series:[]}),{rows:[],series:[]});
  const invalid:((data:ExecutionData)=>void)[]=[
    d=>{d.rows.push({...d.rows[0]!});},d=>{d.rows[0]!.parentId='o';},d=>{d.rows[0]!.strategyId='other';},
    d=>{d.rows[1]!.parentId='t';},d=>{d.rows[2]!.parentId='s';},d=>{d.rows[2]!.strategyId='missing';},d=>{d.rows[2]!.ticker='GBP/USD';},d=>{d.rows[2]!.start=109;},
    d=>{d.rows[0]!.quantity=0;},d=>{d.rows[0]!.quantity=1e12+1;},d=>{d.rows[0]!.filledQuantity=1e6+1;},d=>{d.rows[0]!.ask=1;},d=>{d.rows[0]!.end=99;},d=>{d.rows[0]!.start=.5;},d=>{d.rows[0]!.ticker='EUR/USD\n';},
    d=>{d.series[0]!.points[1]!.time=100;},d=>{d.series[0]!.points[1]!.ask=1;},d=>{d.series.push(structuredClone(d.series[0]!));},d=>{d.series[0]!.strategyId='o';},d=>{d.selectedId='missing';},d=>{d.pageSize=26;},
  ];
  for(const mutate of invalid){const candidate=structuredClone(data);mutate(candidate);assert.equal(executionDataSchema.safeParse(candidate).success,false);}
  for(const key of ['__proto__','constructor','prototype']) {
    assert.equal(executionDataSchema.safeParse({...data,rows:data.rows.map((row,i)=>i===0?{...row,id:key}:row)}).success,false);
    assert.equal(executionDataSchema.safeParse(JSON.parse(JSON.stringify(data).slice(0,-1)+`,"${key}":{}}`)).success,false);
  }
  assert.equal(executionDataSchema.safeParse({...data,broker:'not-supported'}).success,false);
  assert.equal(executionDataSchema.safeParse({...data,rows:[{...data.rows[0],command:'not-supported'}]}).success,false);
});
test('execution bounds cover root counts, row counts, samples and aggregate points',()=>{
  const base=sample().rows[0]!;
  const roots=(count:number)=>Array.from({length:count},(_,i)=>({...base,id:'s'+i,strategyId:'s'+i}));
  assert.equal(executionDataSchema.safeParse({rows:roots(500),series:[]}).success,true);
  assert.equal(executionDataSchema.safeParse({rows:roots(501),series:[]}).success,false);
  assert.equal(executionDataSchema.safeParse({rows:Array.from({length:4001},()=>base),series:[]}).success,false);
  const points=(count:number)=>Array.from({length:count},(_,i)=>({time:i,bid:1,ask:2}));
  assert.equal(executionDataSchema.safeParse({rows:roots(1),series:[{strategyId:'s0',points:points(256)}]}).success,true);
  assert.equal(executionDataSchema.safeParse({rows:roots(1),series:[{strategyId:'s0',points:points(257)}]}).success,false);
  assert.equal(executionDataSchema.safeParse({rows:roots(47),series:Array.from({length:47},(_,i)=>({strategyId:'s'+i,points:points(256)}))}).success,false);
});
test('styles are typed, bounded and reject arbitrary CSS and reserved status keys',()=>{
  const value={theme:'paper',accent:'#aBc123',statuses:{filled:'#00aa00',failed:'#aa0000'},rowHeight:28,fontSize:16};
  assert.deepEqual(executionStyleSchema.parse(value),value);
  for(const style of [{theme:'other'},{accent:'red'},{bid:'#000000\n'},{rowHeight:27},{rowHeight:40.5},{fontSize:17},{css:'body{}'},{statuses:{unknown:'#000000'}},JSON.parse('{"statuses":{"__proto__":"#000000"}}')])assert.equal(executionStyleSchema.safeParse(style).success,false);
});
test('quantities use million units with whole-million rounding above one million',()=>{
  assert.equal(formatQuantity(500_000),'0.5 mio');assert.equal(formatQuantity(1_000_000),'1 mio');assert.equal(formatQuantity(2_400_000),'2 mio');assert.equal(formatQuantity(12_600_000),'13 mio');assert.equal(formatQuantity(30_000_000),'30 mio');assert.equal(formatQuantity(Number.NaN),'—');
});
test('parent resolution and association lanes remain deterministic with multiple fills',()=>{
  const data=sample();const second={...data.rows[2]!,id:'t2',start:125};const unfilled={...data.rows[1]!,id:'o2',start:130,filledQuantity:0};data.rows.push(second,unfilled);
  for(const row of data.rows)assert.equal(strategyForRow(data.rows,row.id)?.id,'s');assert.equal(strategyForRow(data.rows,'missing'),undefined);
  const lanes=executionLanes(data.rows,'s');assert.equal(lanes.length,3);assert.equal(new Set(lanes.map(lane=>lane.lane)).size,3);assert.deepEqual(lanes.map(lane=>[lane.order.id,lane.trade?.id]),[['o','t'],['o','t2'],['o2',undefined]]);
  assert.deepEqual(executionLanes([...data.rows].reverse(),'s'),lanes);
});
test('root paging, expansions and subtree filtering keep ancestors and bound mounted rows',()=>{
  const data=forexExecutionExample(), expanded=new Set(data.rows.map(row=>row.id));
  const closed=visibleExecutionRows(data.rows,new Set(),0,12);assert.equal(closed.rows.length,12);assert.equal(closed.totalStrategies,300);assert.equal(closed.pages,25);assert.ok(closed.rows.every(item=>item.depth===0));
  const next=visibleExecutionRows(data.rows,new Set(),1,12);assert.notEqual(next.rows[0]!.row.id,closed.rows[0]!.row.id);
  const trade=data.rows.find(row=>row.kind==='trade')!;const filtered=visibleExecutionRows(data.rows,new Set(),0,12,trade.id);assert.deepEqual(filtered.rows.map(item=>item.row.id),[trade.strategyId,trade.parentId,trade.id]);assert.deepEqual(filtered.rows.map(item=>item.depth),[0,1,2]);
  const open=visibleExecutionRows(data.rows,expanded,0,25);assert.ok(open.rows.length<=180);assert.equal(open.totalVisible,data.rows.length);assert.equal(visibleExecutionRows(data.rows,expanded,999,25).page,11);
  const none=visibleExecutionRows(data.rows,expanded,0,25,'not-a-synthetic-id');assert.equal(none.rows.length,0);assert.equal(none.pages,1);
  const root=sample().rows[0]!;const crowded=[root,...Array.from({length:300},(_,i)=>({...sample().rows[1]!,id:'order-'+i}))];assert.equal(visibleExecutionRows(crowded,new Set(['s']),0,1).rows.length,180);
});
test('synthetic fixture is deterministic, bounded, hierarchy-valid and matches its generator',()=>{
  const manifest=forexExecutionManifest();const text=readFileSync(new URL('../examples/applications/forex-execution.agenticview.json',import.meta.url),'utf8');
  assert.deepEqual(JSON.parse(text),manifest);assert.deepEqual(forexExecutionExample(),forexExecutionExample());assert.ok(Buffer.byteLength(text)<262_144);
  const data=executionDataSchema.parse(forexExecutionExample());assert.equal(data.rows.filter(row=>row.kind==='strategy').length,300);assert.ok(data.rows.length>=1800&&data.rows.length<=2400);assert.equal(data.series.reduce((count,series)=>count+series.points.length,0),7200);
  const byId=new Map(data.rows.map(row=>[row.id,row]));for(const row of data.rows)if(row.parentId){const parent=byId.get(row.parentId)!;assert.equal(row.strategyId,parent.strategyId);assert.ok(row.start>=parent.start);}
  for(const series of data.series){const ticker=byId.get(series.strategyId)!.ticker;for(const point of series.points)assert.ok(Math.abs(point.ask-point.bid-(ticker==='USD/JPY'?.05:.0005))<1e-9);}
});
