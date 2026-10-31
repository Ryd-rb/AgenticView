import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { executionDataSchema, type ExecutionData, type ExecutionRow } from '../shared/execution-workbench.ts';
import { legacyExecutionToLinked } from '../shared/legacy-execution-adapter.ts';
import { linkedDataSchema, type LinkedData } from '../shared/linked-workbench.ts';

/** Fixed synthetic observations only. No market feed, broker, clock or random source. */
export function forexExecutionExample(count=300): ExecutionData {
  const rows:ExecutionRow[]=[], series:ExecutionData['series']=[];
  const epoch=1_793_318_400_000;
  const orderStates=['filled','partially-filled','working','filled','cancelled','filled','rejected','filled','partially-filled','pending'] as const;
  for(let i=0;i<count;i++) {
    const strategyId=String(1_233_443_222_234+i), ticker=['EUR/USD','GBP/USD','USD/JPY'][i%3]!;
    const pip=ticker==='USD/JPY'?.01:.0001, precision=ticker==='USD/JPY'?3:5;
    const round=(value:number)=>Number(value.toFixed(precision));
    const base=(ticker==='USD/JPY'?149.5:ticker==='GBP/USD'?1.29:1.08)+(i%17)*pip*3;
    const start=epoch+i*60_000, stop=i%4===0, duration=stop?(1+i%5)*86_400_000:(12+i%49)*1000;
    const end=start+duration, quantity=[500_000,1_000_000,2_400_000,12_600_000,30_000_000][i%5]!;
    const strategy:ExecutionRow={id:strategyId,kind:'strategy',strategyId,ticker,side:i%2?'sell':'buy',orderType:stop?'stop-loss':'limit',status:['running','completed','paused','error'][i%4] as ExecutionRow['status'],quantity,bid:round(base),ask:round(base+5*pip),start,end,filledQuantity:0,...(i%4===3?{error:'Synthetic strategy risk limit reached.'}:{})};
    rows.push(strategy);
    const orderCount=2+i%2;
    for(let j=0;j<orderCount;j++) {
      const id=`${strategyId}-order-${j+1}`, status=orderStates[(i*3+j)%orderStates.length]!;
      const orderStart=start+Math.round(duration*(.06+j*.14)), orderEnd=orderStart+Math.round(duration*.22);
      const orderQuantity=quantity/orderCount, filled=status==='filled'?orderQuantity:status==='partially-filled'?orderQuantity*.6:0;
      const bid=round(base+(j-1)*pip*3), ask=round(bid+5*pip);
      const order:ExecutionRow={id,parentId:strategyId,kind:'order',strategyId,ticker,side:strategy.side,orderType:j===1?'stop-loss':'limit',status,quantity:orderQuantity,bid,ask,start:orderStart,end:orderEnd,filledQuantity:filled,...(filled?{filledPrice:strategy.side==='buy'?ask:bid}:{}),...(status==='rejected'?{error:'Synthetic order rejected: price outside permitted range.'}:{})};
      rows.push(order); strategy.filledQuantity+=filled;
      if(!filled) continue;
      const count=1+(i+j)%2;
      for(let k=0;k<count;k++) {
        const tradeStart=orderStart+Math.round(duration*(.01+k*.025));
        rows.push({id:`${id}-trade-${k+1}`,parentId:id,kind:'trade',strategyId,ticker,side:order.side,orderType:order.orderType,status:(i+j+k)%5===0?'open':'closed',quantity:filled/count,bid,ask,start:tradeStart,...((i+j+k)%5===0?{}:{end:tradeStart+Math.round(duration*.12)}),filledQuantity:filled/count,filledPrice:round((strategy.side==='buy'?ask:bid)+k*pip)});
      }
    }
    // Floating point division can exceed the parent by a few ulps when all orders fill.
    strategy.filledQuantity=Math.min(strategy.quantity,strategy.filledQuantity);
    series.push({strategyId,points:Array.from({length:24},(_,point)=>{const time=start+Math.round(duration*point/23),bid=round(base+(Math.sin(point*.58+i*.2)*7+point*.16)*pip);return {time,bid,ask:round(bid+5*pip)};})});
  }
  return executionDataSchema.parse({rows,series,pageSize:12,selectedId:rows[0]!.id,demo:true,style:{theme:'graphite'}});
}

/** Authored domain configuration for the generic workbench. Compact synthetic
 * samples keep the 300-root demonstration inside the existing HTTP envelope. */
export function forexLinkedExample(count=300,theme:'graphite'|'paper'|'terminal'='graphite'):LinkedData {
  const legacy=forexExecutionExample(count);legacy.style={theme};
  const data=legacyExecutionToLinked(legacy),aliases:Record<string,string>={orderType:'type',quantity:'qty',spread:'pips',filledQuantity:'filled',filledPrice:'price',precision:'dp',remaining:'left',entryPrice:'entry'};
  const key=(value:string)=>aliases[value]??value;
  for(const row of data.rows){if(row.label===row.id)delete row.label;row.values=Object.fromEntries(Object.entries(row.values).filter(([field,value])=>field!=='duration'&&value!==null&&value!=='').map(([field,value])=>[key(field),value]));}
  for(const column of data.columns){column.fields=column.key==='duration'?['time','endTime']:(column.fields??[column.key]).map(key);if(column.decimalsField)column.decimalsField=key(column.decimalsField);}
  for(const [index,association]of data.associations.entries())association.id='link-'+index;
  for(const series of data.series)for(const track of series.tracks){const points=track.points;track.points=Array.from({length:Math.min(12,points.length)},(_,i)=>points[Math.round(i*(points.length-1)/11)]!).filter(Boolean);}
  for(const operation of data.simulations??[]){for(const field of ['values','parentValues'] as const)if(operation[field])operation[field]=Object.fromEntries(Object.entries(operation[field]!).map(([field,value])=>[key(field),value]));for(const field of ['copyFields','parentCopyFields'] as const)if(operation[field])operation[field]=Object.fromEntries(Object.entries(operation[field]!).map(([target,source])=>[key(target),key(source)]));}
  return linkedDataSchema.parse(data);
}

export function forexExecutionManifest(count=12,theme:'graphite'|'paper'|'terminal'='graphite') {
  const windowIcons={graphite:{icon:'chart',color:'#74d4c8',background:'#101722'},paper:{icon:'layers',color:'#2157aa',background:'#f3f6fa'},terminal:{icon:'terminal',color:'#72e3bc',background:'#0b1413'}};
  return {schemaVersion:1,id:`forex-execution-${theme}`,version:'1.2.0',name:`FX execution - ${theme[0]!.toUpperCase()+theme.slice(1)}`,description:'Local simulation of strategy, order and trade observations. No broker connection or live trading.',permanent:true,icon:'chart',windowIcon:windowIcons[theme],bindings:[],actions:[],componentLayout:{mode:'vertical'},layout:{width:1500,height:1000,sizing:'content'},components:[{id:'forex-execution',title:'Synthetic forex execution',kind:'linked-workbench',configuration:{presentation:{surface:'plain',density:'compact'},controls:{header:{visible:false}},manualFields:['data.style']},data:forexLinkedExample(count,theme)}]};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const manifest=forexExecutionManifest(), text=JSON.stringify(manifest)+'\n';
  if(Buffer.byteLength(text)>262_144) throw new Error('Synthetic fixture exceeds its byte budget.');
  let elements=0; const visit=(value:unknown)=>{elements++;if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==='object')for(const item of Object.values(value))visit(item);};visit(manifest);
  if(elements>100_000)throw new Error('Synthetic fixture exceeds its JSON element budget.');
  writeFileSync(new URL('../examples/applications/forex-execution.agenticview.json',import.meta.url),text);
  for(const theme of ['paper','terminal'] as const)writeFileSync(new URL(`../examples/applications/forex-execution-${theme}.agenticview.json`,import.meta.url),JSON.stringify(forexExecutionManifest(12,theme))+'\n');
  console.log(JSON.stringify({roots:manifest.components[0]!.data.series.length,rows:manifest.components[0]!.data.rows.length,points:manifest.components[0]!.data.series.reduce((n,s)=>n+s.tracks.reduce((n,t)=>n+t.points.length,0),0),bytes:Buffer.byteLength(text),elements}));
}
