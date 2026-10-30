import { useId, useState } from 'react';
import { domainFraction, formatNativeNumber, matchesChartCondition, type ChartData } from '../shared/native-extensions.js';
import { Table2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useControl, ControlContent, controlStyle, ControlContainer } from './ControlPresentation.js';

const palette = ['#b4a2ff', '#70d6c3', '#e8be79', '#8bbbf5', '#e891b1', '#d3df8a'];
const dash = { solid: undefined, dashed: '7 4', dotted: '2 4' };
const LIMIT = 256;
function domain(values: number[], axis?: { min?: number; max?: number; includeZero?: boolean }): [number, number] {
  const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1;
  let min = axis?.min ?? (axis?.includeZero === false ? low : Math.min(0, low));
  let max = axis?.max ?? (axis?.includeZero === false ? high : Math.max(0, high));
  if (max <= min) {
    if (axis?.min !== undefined) max = min < 0 ? 0 : min === 0 ? 1 : Math.min(Number.MAX_VALUE, min * 1.1);
    else if (axis?.max !== undefined) min = max > 0 ? 0 : max === 0 ? -1 : Math.max(-Number.MAX_VALUE, max * 1.1);
    else { min = low < 0 ? low : 0; max = high > 0 ? high : 1; }
  }
  // A one-sided extreme explicit domain has no representable expansion.
  if (max <= min) { min = -Number.MAX_VALUE; max = Number.MAX_VALUE; }
  return [min, max];
}
function interpolate(min: number, max: number, t: number) { return min * (1 - t) + max * t; }
function rawFraction(value: number, min: number, max: number) {
  const scale = Math.max(Math.abs(min), Math.abs(max), Number.MIN_VALUE), width = max / scale - min / scale;
  const result = (value / scale - min / scale) / width;
  return Number.isNaN(result) ? .5 : Math.max(-10000, Math.min(10000, result));
}
function sampled<T>(points: T[]): T[] {
  if (points.length <= LIMIT) return points;
  return Array.from({ length: LIMIT }, (_, i) => points[Math.round(i * (points.length - 1) / (LIMIT - 1))]);
}

/** Local interactions change inspection only; supplied telemetry is never mutated. */
export function ChartView({ data, manual = true }: { data: ChartData; manual?: boolean }) {
  const legendSpec=useControl('legend'),dataSpec=useControl('dataTable'),paginationSpec=useControl('pagination');
  const [hidden, setHidden] = useState<Set<string>>(new Set()), [table, setTable] = useState(dataSpec.initiallyOpen??false), [page, setPage] = useState(0);
  const clipId = `plot-${useId().replace(/:/g, '')}`, options = data.options, xAxis = options?.xAxis, yAxis = options?.yAxis;
  const key = (series: ChartData['series'][number], index: number) => series.id ?? `${index}:${series.name}`;
  const visible = data.series.map((series, index) => ({ series, index, key: key(series, index) })).filter(item => !item.series.hidden && (!options?.features?.seriesToggle || !hidden.has(item.key)));
  const all = data.series.flatMap(series => series.points), numeric = all.every(p => typeof p.x === 'number');
  const categories = [...new Set(all.map(p => String(p.x)))];
  const [xmin, xmax] = domain(numeric ? all.map(p => Number(p.x)) : [0, Math.max(1, categories.length - 1)], { ...xAxis, includeZero: xAxis?.includeZero ?? false });
  const [ymin, ymax] = domain(all.map(p => p.y), yAxis);
  const x = (v: string | number) => 64 + (numeric ? rawFraction(Number(v), xmin, xmax) : categories.indexOf(String(v)) / Math.max(1, categories.length - 1)) * 552;
  const y = (v: number) => 228 - rawFraction(v, ymin, ymax) * 200;
  const base = 228 - domainFraction(0, ymin, ymax) * 200;
  const ticks = (count: number) => Array.from({ length: count }, (_, i) => i / (count - 1));
  const rows = visible.flatMap(({ series }) => series.points.map(point => ({ name: series.name, point }))), pages = Math.max(1, Math.ceil(rows.length / 25)), current = Math.min(page, pages - 1);
  const formatY = (value: number) => formatNativeNumber(value, yAxis?.format), toggle = options?.features?.seriesToggle === true;
  const sampling = visible.some(({ series }) => series.points.length > LIMIT);
  const legend=options?.legend!==false&&legendSpec.visible!==false?<ControlContainer spec={legendSpec}><div className="chart-legend" data-control="legend" aria-label={legendSpec.label||'Chart legend'} title={legendSpec.tooltip}>{data.series.map((series,index)=>{
    const seriesKey=key(series,index),shown=!series.hidden&&(!toggle||!hidden.has(seriesKey)),label=<><i style={{backgroundColor:series.color??palette[index%palette.length]}}/>{legendSpec.appearance!=='icon'&&<>{series.name}{series.hidden&&' (agent hidden)'}</>}</>;
    return toggle?<button key={seriesKey} type="button" disabled={!manual||series.hidden} aria-pressed={shown} aria-label={series.name} title={legendSpec.tooltip??series.name} style={controlStyle(legendSpec)} onClick={()=>setHidden(previous=>{const currentKeys=new Set(data.series.map(key)),next=new Set([...previous].filter(value=>currentKeys.has(value)));if(next.has(seriesKey))next.delete(seriesKey);else next.add(seriesKey);return next;})}>{label}</button>:<span key={seriesKey} aria-label={series.name}>{label}</span>;
  })}</div></ControlContainer>:null;
  const inspector=options?.features?.dataTable&&dataSpec.visible!==false?<ControlContainer spec={dataSpec}><div data-control="dataTable">
    {dataSpec.mode!=='panel'&&<button className="chart-data-toggle" disabled={!manual} type="button" aria-label={dataSpec.label||`${table?'Hide':'Show'} chart data`} title={dataSpec.tooltip} data-control-variant={dataSpec.variant} style={controlStyle(dataSpec)} aria-expanded={table} onClick={()=>setTable(!table)}><ControlContent spec={dataSpec} label={`${table?'Hide':'Show'} chart data`} icon={<Table2 size={13}/>}/></button>}
    {(table||dataSpec.mode==='panel')&&<><div className="table-scroll"><table className="chart-data"><thead><tr><th>Series</th><th>{xAxis?.label??data.xLabel??'X'}</th><th>{yAxis?.label??data.yLabel??'Y'}</th></tr></thead><tbody>{rows.slice(current*25,current*25+25).map((row,i)=><tr key={i}><th scope="row">{row.name}</th><td>{String(row.point.x)}</td><td>{formatY(row.point.y)}</td></tr>)}</tbody></table></div>{paginationSpec.visible!==false&&<div className="pagination" data-control="pagination" title={paginationSpec.tooltip}><span>{rows.length} points</span><button aria-label={paginationSpec.label?`${paginationSpec.label}: Previous`:'Previous'} style={controlStyle(paginationSpec)} disabled={!manual||current===0} onClick={()=>setPage(current-1)}><ControlContent spec={{...paginationSpec,label:paginationSpec.label?`${paginationSpec.label}: Previous`:undefined}} label="Previous" icon={<ChevronLeft size={13}/>}/></button><span>{current+1} / {pages}</span><button aria-label={paginationSpec.label?`${paginationSpec.label}: Next`:'Next'} style={controlStyle(paginationSpec)} disabled={!manual||current+1===pages} onClick={()=>setPage(current+1)}><ControlContent spec={{...paginationSpec,label:paginationSpec.label?`${paginationSpec.label}: Next`:undefined}} label="Next" icon={<ChevronRight size={13}/>}/></button></div>}</>}
  </div></ControlContainer>:null;
  const above=(placement?:string)=>placement==='header'||placement?.startsWith('top-');
  return <div className="native-chart">
    {above(legendSpec.placement)&&legend}{above(dataSpec.placement)&&inspector}
    {data.series.length === 0 || all.length === 0 ? <p className="native-note">No chart points reported</p> : <>
      <svg className="chart chart-configurable" viewBox="0 0 640 280" role="img" aria-label={`${data.type} chart, ${visible.map(item => item.series.name).join(', ') || 'no visible series'}`}>
        <defs><clipPath id={clipId}><rect x="64" y="28" width="552" height="200" /></clipPath></defs>
        {yAxis?.visible !== false && ticks(yAxis?.ticks ?? 5).map((t, i) => <g key={`y-${i}`}>{yAxis?.grid !== false && <line className="chart-grid" x1="64" x2="616" y1={228 - t * 200} y2={228 - t * 200} />}<text x="58" y={232 - t * 200} textAnchor="end">{formatY(interpolate(ymin, ymax, t))}</text></g>)}
        {xAxis?.visible !== false && (numeric ? ticks(xAxis?.ticks ?? 5).map((t, i) => <g key={`x-${i}`}>{xAxis?.grid && <line className="chart-grid" x1={64 + t * 552} x2={64 + t * 552} y1="28" y2="228" />}<text x={64 + t * 552} y="246" textAnchor="middle">{formatNativeNumber(interpolate(xmin, xmax, t), xAxis?.format)}</text></g>) : categories.filter((_, i) => i % Math.max(1, Math.ceil(categories.length / (xAxis?.ticks ?? 5))) === 0).slice(0, 10).map(category => <text key={category} x={x(category)} y="246" textAnchor="middle">{category.length > 18 ? category.slice(0, 17) + '…' : category}</text>))}
        <g clipPath={`url(#${clipId})`}>
          {(options?.annotations ?? []).map(annotation => {
            const start = annotation.axis === 'x' ? x(annotation.value) : y(annotation.value), end = annotation.end === undefined ? start : annotation.axis === 'x' ? x(annotation.end) : y(annotation.end), color = annotation.color ?? '#e8be79';
            return <g key={annotation.id} className="chart-annotation" aria-label={annotation.label ?? `${annotation.axis} reference ${annotation.value}`}>
              {annotation.end === undefined ? <line x1={annotation.axis === 'x' ? start : 64} x2={annotation.axis === 'x' ? start : 616} y1={annotation.axis === 'y' ? start : 28} y2={annotation.axis === 'y' ? start : 228} stroke={color} strokeDasharray={dash[annotation.dash ?? 'dashed']} /> : <rect x={annotation.axis === 'x' ? Math.min(start, end) : 64} y={annotation.axis === 'y' ? Math.min(start, end) : 28} width={annotation.axis === 'x' ? Math.abs(end - start) : 552} height={annotation.axis === 'y' ? Math.abs(end - start) : 200} fill={color} fillOpacity=".13" />}
              {annotation.label && <text x={annotation.axis === 'x' ? start + 4 : 68} y={annotation.axis === 'y' ? start - 4 : 40} fill={color}>{annotation.label}</text>}
            </g>;
          })}
          {visible.map(({ series, index, key: seriesKey }) => {
            const color = series.color ?? palette[index % palette.length], points = sampled(series.points), type = series.type ?? data.type, path = points.map(p => `${x(p.x)},${y(p.y)}`).join(' '), marker = series.marker ?? (options?.markers || type === 'scatter' ? 'circle' : 'none');
            const bars = visible.filter(item => (item.series.type ?? data.type) === 'bar'), barIndex = bars.findIndex(item => item.key === seriesKey), width = Math.max(.75, Math.min(28, 440 / Math.max(1, categories.length || points.length) / Math.max(1, bars.length)));
            return <g key={seriesKey} data-series={seriesKey}>
              {type === 'area' && points.length > 0 && <polygon points={`${x(points[0].x)},${base} ${path} ${x(points.at(-1)!.x)},${base}`} fill={color} fillOpacity=".16" />}
              {(type === 'line' || type === 'area') && <polyline points={path} fill="none" stroke={color} strokeWidth={series.width ?? 2} strokeDasharray={dash[series.dash ?? 'solid']} vectorEffect="non-scaling-stroke" />}
              {points.map((point, i) => {
                const px = x(point.x), py = y(point.y), title = options?.tooltips !== false && matchesChartCondition(point.y, options?.tooltipWhen) ? `${series.name}: ${String(point.x)}, ${formatY(point.y)}${point.label ? ' · ' + point.label : ''}` : undefined;
                return <g key={i} className="chart-point">{title && <title>{title}</title>}
                  {type === 'bar' ? <rect x={px + (barIndex - (bars.length - 1) / 2) * width - width / 2} y={Math.min(py, base)} width={width} height={Math.abs(base - py)} fill={color} /> : marker === 'circle' ? <circle cx={px} cy={py} r="3" fill={color} /> : marker === 'square' ? <rect x={px - 3} y={py - 3} width="6" height="6" fill={color} /> : marker === 'diamond' ? <polygon points={`${px},${py - 4} ${px + 4},${py} ${px},${py + 4} ${px - 4},${py}`} fill={color} /> : title ? <circle cx={px} cy={py} r="5" fill="transparent" /> : null}
                  {options?.labels && i < 40 && matchesChartCondition(point.y, options.labelWhen) && <text x={px} y={py - 7} textAnchor="middle">{point.label ?? formatY(point.y)}</text>}
                </g>;
              })}
            </g>;
          })}
        </g>
        <text x="340" y="273" textAnchor="middle">{xAxis?.label ?? data.xLabel}</text><text x="12" y="128" textAnchor="middle" transform="rotate(-90 12 128)">{yAxis?.label ?? data.yLabel}</text>
      </svg>
      {sampling && <small className="native-note">Plot sampled to {LIMIT} points per series. All reported points remain available when data inspection is enabled.</small>}
    </>}
    {!above(legendSpec.placement)&&legend}{!above(dataSpec.placement)&&inspector}
  </div>;
}
