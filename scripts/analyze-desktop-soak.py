"""Aggregate bounded non-image native soak receipts after a completed run."""
import argparse, datetime, json, math, sqlite3
from pathlib import Path

def quantiles(values):
    values=sorted(value for value in values if value is not None)
    return {'count':len(values),'p50':values[max(0,math.ceil(len(values)*.5)-1)] if values else None,'p95':values[max(0,math.ceil(len(values)*.95)-1)] if values else None,'max':max(values) if values else None}

def analyze(manifest):
    config=json.loads(Path(manifest).read_text());directory=Path(config['output'])
    start=config['startAtUtcMs'];end=start+config['durationSeconds']*1000
    read=lambda name:json.loads((directory/name).read_text())
    provider=read('provider-result.json');publisher=read('publisher-result.json');debug=read('debug-result.json')
    events=[json.loads(line) for line in (directory/'debug-events.jsonl').read_text().splitlines() if line]
    samples=[]
    for source in (directory/'resources').glob('*/samples.jsonl'):
        for line in source.read_text().splitlines():
            sample=json.loads(line);stamp=datetime.datetime.fromisoformat(sample['utc'].replace('Z','+00:00')).timestamp()*1000
            if start<=stamp<=end:sample['stamp']=stamp;samples.append(sample)
    if not samples:raise ValueError('No resource samples cover the requested window')
    resources={}
    for role in ('host','server','provider'):
        series=[(sample['stamp'],next(item for item in sample['roles'] if item['role']==role)) for sample in samples]
        resources[role]={key:quantiles([item[key] for _,item in series]) for key in ('singleCorePercent','totalCorePercent','privateBytes','workingSetBytes')}
        resources[role]['privateWindows']={label:quantiles([item['privateBytes'] for stamp,item in series if low<=stamp<high]) for label,low,high in [('first10minutes',start,start+600000),('middle10minutes',start+1500000,start+2100000),('last10minutes',end-600000,end)]}
    clicks=[event for event in events if event['operation']=='click' and event['state']=='succeeded'];metrics=[event['result'] for event in events if event['operation']=='metrics' and event['state']=='succeeded'];viewports=[event for event in events if event['operation']=='viewport' and event['state']=='succeeded'];profiles=[event['result']['profile'] for event in viewports if event['result'].get('profile')]
    runtime={}
    for metric in metrics:
        for item in metric.get('native',{}).get('metrics',{}).get('metrics',[]):runtime.setdefault(item['name'],[]).append(item['value'])
    counters={name:{'first':values[0],'last':values[-1],'delta':values[-1]-values[0]} for name,values in runtime.items() if name.endswith(('Duration','Count'))}
    with sqlite3.connect(str(directory/'synthetic.sqlite')) as db:
        raw_count=db.execute("SELECT value FROM metadata WHERE key='point_count'").fetchone()[0]
        stream_count=db.execute('SELECT count(DISTINCT stream) FROM points').fetchone()[0]
    failures=[event for event in events if event['state']!='succeeded']
    result={'source':read('build-identity.json'),'window':{'startUtcMs':start,'endUtcMs':end,'requestedSeconds':config['durationSeconds'],'resourceSamples':len(samples)},'workload':read('workload.json'),'provider':provider,'publisher':publisher,'debug':debug,'database':{'retainedPoints':raw_count,'streams':stream_count,'bytes':(directory/'synthetic.sqlite').stat().st_size},'resources':resources,'clicks':{'count':len(clicks),'uniqueCards':len({event['cardIndex'] for event in clicks}),'dispatchToSecondFrameMs':quantiles([event['result']['dispatchToSecondFrameMs'] for event in clicks]),'dispatchMs':quantiles([event['result']['dispatchMs'] for event in clicks]),'mcpRoundTripMs':quantiles([event['roundTripMs'] for event in clicks])},'renderer':{'metricSamples':len(metrics),'rollingFrameP95Ms':quantiles([metric['frameP95Ms'] for metric in metrics]),'observedFrameMaxMs':max((metric['frameMaxMs'] or 0 for metric in metrics),default=0),'activeComponents':quantiles([metric['activeComponents'] for metric in metrics]),'mountedComponents':quantiles([metric['components'] for metric in metrics]),'jsHeapUsedBytes':quantiles([metric.get('native',{}).get('heap',{}).get('usedSize') for metric in metrics]),'counters':counters,'profiles':profiles},'failures':failures,'limitations':['Synthetic untrusted component clicks; no physical input or compositor presentation measurement.','rAF opportunities and cumulative renderer counters; rolling frame p95 values are not pooled per-frame quantiles.','CPU sampled for owned process trees; summed working sets include shared pages. Provider includes load/debug drivers.','Resource timestamps cover the hour; first/last CPU intervals can straddle its boundary by at most the polling interval.','Native card detail is visibility gated; all100cards are resident and visited, not simultaneously rendered as full-size cards.','Warmup cache growth is separated from late-window memory; private bytes alone do not establish a leak.']}
    expected=config['durationSeconds']*1000
    result['zoom']={'gestures':len(viewports),'stepFrameP50Ms':quantiles([event['result']['stepFrameP50Ms'] for event in viewports]),'stepFrameP95Ms':quantiles([event['result']['stepFrameP95Ms'] for event in viewports]),'stepFrameMaxMs':quantiles([event['result']['stepFrameMaxMs'] for event in viewports]),'profiles':len(profiles),'scope':'Per-gesture frame opportunity quantiles; not pooled frames or compositor presentation.'}
    result['limitations'][4]='All100cards retain their real views at far zoom; clipped/small-view readers pause. Cards are activated sequentially for input.'
    result['accepted']=provider['ingestedPoints']>=expected and raw_count>=expected and provider['durationSeconds']>=config['durationSeconds']-.5 and publisher['durationSeconds']>=config['durationSeconds']-.5 and debug['durationSeconds']>=config['durationSeconds']-.5 and not provider['errors'] and not publisher['failures'] and not debug['failures'] and not failures and len({event['cardIndex'] for event in clicks})==100
    result['accepted']=result['accepted'] and len(viewports)>=4 and stream_count==100 and len(samples)>=config['durationSeconds']//5-2
    (directory/'analysis.json').write_text(json.dumps(result,indent=2));return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--manifest',required=True);args=parser.parse_args();result=analyze(args.manifest)
    print(json.dumps({'accepted':result['accepted'],'seconds':result['provider']['durationSeconds'],'points':result['database']['retainedPoints'],'clicks':result['clicks']['count'],'cards':result['clicks']['uniqueCards']}))
    raise SystemExit(0 if result['accepted'] else 1)
