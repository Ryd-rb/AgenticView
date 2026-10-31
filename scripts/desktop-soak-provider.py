"""Finite synthetic ingest + fixed handler connector for the native desktop soak.
No UI driver, remote feed, operational action, shell or dynamic handler source.
"""
import argparse, hashlib, http.client, importlib.util, json, math, threading, time
from pathlib import Path
from collections import deque
from urllib.parse import urlparse

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--manifest',required=True);args=parser.parse_args()
    config=json.loads(Path(args.manifest).read_text());duration=config['durationSeconds']
    if type(duration) is not int or not 1<=duration<=7200:raise ValueError('Use a finite duration <=7200s')
    url=urlparse(config['url'])
    if url.scheme!='http' or url.hostname!='127.0.0.1' or url.path not in ('','/'):raise ValueError('Synthetic soak requires its isolated loopback server')
    output=Path(config['output']);output.mkdir(parents=True,exist_ok=True)
    credentials=json.loads(Path(config['credentials']).read_text())
    source=Path(__file__).resolve().parents[1]/'examples'/'connector'/'time-series-service.py'
    spec=importlib.util.spec_from_file_location('soak_provider',source);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    def call(connection,path,token,body):
        connection.request('POST',path,json.dumps(body,separators=(',',':')),{'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        response=connection.getresponse();raw=response.read(1048577)
        if response.status>=400 or len(raw)>1048576:raise RuntimeError('Synthetic connector HTTP failure '+str(response.status))
        return json.loads(raw)
    connection=http.client.HTTPConnection(url.hostname,url.port,timeout=10)
    registration=call(connection,'/api/connectors/register',credentials['ingestToken'],{'id':'soak-provider','name':'Finite synthetic soak provider','registrationKey':config['proof']})
    if config.get('startAtUtcMs',0)>time.time()*1000:time.sleep((config['startAtUtcMs']-time.time()*1000)/1000)
    start=time.perf_counter();deadline=start+duration;errors=[];state={'ingestedPoints':0,'queries':0,'queryFailures':0,'startedUtcMs':int(time.time()*1000),'targetPointsPerHour':3600000,'pollRequests':0,'idlePolls':0};query_times=deque(maxlen=4096);poll_times=deque(maxlen=4096);complete_times=deque(maxlen=4096)
    def ingest():
        store=module.Store(str(output/'synthetic.sqlite'),max_points=10_000_000)
        # A fresh test database is required: no destructive reset or overwrite.
        if store.db.execute("SELECT value FROM metadata WHERE key='point_count'").fetchone()[0]:
            errors.append('Existing synthetic data: use a new run directory');store.close();return
        try:
            sequence=0;tick=0
            while time.perf_counter()<deadline:
                stamp=int(time.time()*1000)
                points=[{'stream':'stream-'+str(i%100),'sequence':sequence+i,'timestamp':stamp+i//100,'value':math.sin((sequence+i)*.002)+(i%100)*.01} for i in range(1000)]
                accepted=store.append({'batchId':'soak-'+str(tick),'points':points})['accepted'];state['ingestedPoints']+=accepted;sequence+=1000;tick+=1
                state['elapsedSeconds']=time.perf_counter()-start
                (output/'provider-progress.json').write_text(json.dumps(state))
                delay=min(deadline-time.perf_counter(),start+tick-time.perf_counter())
                if delay>0:time.sleep(delay)
        except Exception as error:errors.append(type(error).__name__+': '+str(error)[:200])
        finally:store.close()
    reader=module.Store(str(output/'synthetic.sqlite'),max_points=10_000_000)
    writer=threading.Thread(target=ingest);writer.start()
    try:
        while time.perf_counter()<deadline and not errors:
            poll_started=time.perf_counter()
            jobs=call(connection,'/api/connectors/soak-provider/poll',registration['token'],{})
            poll_times.append((time.perf_counter()-poll_started)*1000);state['pollRequests']+=1
            for job in jobs:
                began=time.perf_counter();result=None;error=None
                try:
                    if job['kind']!='query':raise ValueError('Only synthetic queries are allowlisted')
                    handler=job['handler']
                    allowed={f'range-{index}':f'stream-{index}' for index in range(100)}
                    if handler in allowed:result=reader.read_range(job['input'],[allowed[handler]])
                    elif handler=='rows':result=reader.read_rows(job['input'])
                    else:raise ValueError('Handler is not allowlisted')
                    state['queries']+=1;query_times.append((time.perf_counter()-began)*1000)
                except Exception as failure:state['queryFailures']+=1;error=type(failure).__name__
                completion_started=time.perf_counter()
                call(connection,'/api/connectors/soak-provider/complete',registration['token'],{'invocationId':job['id'],'claimToken':job['claimToken'],'state':'failed' if error else 'succeeded',**({'message':error} if error else {'result':result})})
                complete_times.append((time.perf_counter()-completion_started)*1000)
            # Poll returns one claimed job; drain acknowledged work without an idle delay.
            # Only an empty inbox backs off. Execution and completion remain serial.
            if not jobs:
                state['idlePolls']+=1
                time.sleep(min(.2,max(0,deadline-time.perf_counter())))
    except Exception as failure:errors.append(type(failure).__name__+': '+str(failure)[:200])
    finally:
        writer.join(timeout=15);reader.close();connection.close()
        def timing(values):
            ordered=sorted(values)
            return {'samples':len(ordered),'p50Ms':ordered[len(ordered)//2] if ordered else None,'p95Ms':ordered[min(len(ordered)-1,int(len(ordered)*.95))] if ordered else None}
        transport={'poll':timing(poll_times),'complete':timing(complete_times)};query_times=sorted(query_times)
        state.update({'durationSeconds':time.perf_counter()-start,'errors':errors,'queryP50Ms':query_times[len(query_times)//2] if query_times else None,'queryP95Ms':query_times[min(len(query_times)-1,int(len(query_times)*.95))] if query_times else None,'providerSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'transport':transport,'timingScope':'Most recent4096 observations per operation; query timing excludes HTTP; poll/complete include their HTTP roundtrip.','synthetic':True,'writerExited':not writer.is_alive()})
        (output/'provider-result.json').write_text(json.dumps(state,indent=2))
    if errors or writer.is_alive():raise SystemExit(1)

if __name__=='__main__':main()
