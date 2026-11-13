"""기존 로컬 라벨과 GitHub 라벨을 원본 위치 그대로 읽는 홈 음원 통합 뷰어."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,unquote
from collections import defaultdict
import fcntl,json,mimetypes,re,subprocess,sys,unicodedata

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
OLD=ROOT/'Analysis/PuffinFiveSounds20261027'
REPO=ROOT/'Milk_Steaming_Labeling_Data'
PORT=8091
read=lambda p:json.loads(p.read_text())

def library(old=OLD,repo=REPO):
    dataset=read(old/'dataset.json');reviews=read(old/'human-reviews.json')['files']
    parents={s['id']:s for s in dataset.get('splitOriginals',[])}
    groups=defaultdict(list)
    for s in dataset['files']:
        if s.get('datasetGroup')=='home':groups[s.get('parentSourceId',s['id'])].append(s)
    files=[];media={}
    for identity,parts in groups.items():
        source=parents.get(identity,parts[0]);segments=[];notes=[];states=[]
        for part in sorted(parts,key=lambda s:s.get('parentStart',0)):
            review=reviews.get(part['id'],{});offset=part.get('parentStart',0)
            status='사용 제외' if review.get('excluded') else '검수 완료' if review.get('reviewed') else '미검수'
            states.append(status)
            segments.extend(dict(e,start=e['start']+offset,end=e['end']+offset,reviewStatus=status,
                                 part=part['id'],airEvents=[dict(a,start=a['start']+offset,end=a['end']+offset) for a in review.get('airEvents',[]) if a['start']<e['end'] and a['end']>e['start']]) for e in review.get('segments',[]))
            if review.get('note'):notes.append(part['title']+'\n'+review['note'])
        key='local:'+identity
        files.append(dict(id=key,title=source['title'],origin='과거 로컬',duration=source['duration'],waveform=source.get('waveform',[]),
                          segments=segments,status=states[0] if len(set(states))==1 else '일부 미검수 / 상태 혼합',note='\n\n'.join(notes),
                          parts=len(parts),location=str(old/'human-reviews.json')))
        media[key]=(old/source['audio']).resolve()
        if not media[key].is_relative_to(old.resolve()):raise ValueError('기존 음원 경로가 자료 폴더 밖을 가리킵니다.')
    for path in sorted((repo/'recordings').glob('*/record.json')):
        record=read(path);s=record['source'];r=record['review']
        if s.get('datasetGroup')!='home':continue
        audio=(repo/s['originalAudio']).resolve()
        if not audio.is_relative_to((repo/'recordings').resolve()):raise ValueError('음원 경로가 저장소 밖을 가리킵니다.')
        status='사용 제외' if r['excluded'] else '검수 완료' if r['reviewed'] else '미검수'
        key='github:'+s['id']
        files.append(dict(id=key,title=s['title'],origin='GitHub',duration=s['duration'],waveform=s.get('waveform',[]),
                          segments=[dict(e,reviewStatus=status,airEvents=[a for a in r.get('airEvents',[]) if a['start']<e['end'] and a['end']>e['start']]) for e in r['segments']],
                          status=status,note=r.get('note',''),parts=1,location=str(path)))
        media[key]=audio
    for f in files:
        f['title']=unicodedata.normalize('NFC',f['title']);f['audio']='/audio/'+f['id']
        f['segments'].sort(key=lambda e:e['start'])
        assert all(0<=e['start']<e['end']<=f['duration']+.1 for e in f['segments'])
        if not media[f['id']].is_file():raise ValueError('음원 파일을 찾을 수 없습니다: '+f['title'])
    assert len({f['id'] for f in files})==len(files)
    return dict(app='home-label-library',files=files,labels=read(old/'labels.json'),commit=subprocess.check_output(['git','-C',str(repo),'rev-parse','--short','HEAD'],text=True).strip()),media

def byte_range(header,size):
    if not header:return 0,size-1
    match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
    if not match or not any(match.groups()):raise ValueError('잘못된 Range')
    a,b=match.groups();start=int(a) if a else max(0,size-int(b));end=min(int(b),size-1) if a and b else size-1
    if not 0<=start<=end<size:raise ValueError('Range 범위 오류')
    return start,end

class Handler(BaseHTTPRequestHandler):
    def respond(self,status,data,kind='application/json; charset=utf-8'):
        body=json.dumps(data,ensure_ascii=False).encode() if not isinstance(data,bytes) else data
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body)

    def do_GET(self):
        if self.headers.get('Host')!=f'127.0.0.1:{PORT}':return self.respond(403,{'error':'로컬 주소로 접속하세요.'})
        path=unquote(urlparse(self.path).path)
        try:
            if path=='/':return self.respond(200,(HERE/'index.html').read_bytes(),'text/html; charset=utf-8')
            if path=='/api/library':
                data,_=library();return self.respond(200,data)
            if path.startswith('/audio/'):
                _,media=library();file=media.get(path[len('/audio/'):])
                if file is None:return self.respond(404,{'error':'음원을 찾지 못했습니다.'})
                size=file.stat().st_size
                try:start,end=byte_range(self.headers.get('Range'),size)
                except ValueError:return self.respond(416,{'error':'음원 범위 오류'})
                self.send_response(206 if self.headers.get('Range') else 200)
                self.send_header('Content-Type',mimetypes.guess_type(file)[0] or 'application/octet-stream')
                self.send_header('Content-Length',str(end-start+1));self.send_header('Accept-Ranges','bytes')
                if self.headers.get('Range'):self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
                self.end_headers()
                with file.open('rb') as stream:
                    stream.seek(start);remaining=end-start+1
                    while remaining:
                        chunk=stream.read(min(65536,remaining))
                        if not chunk:break
                        self.wfile.write(chunk);remaining-=len(chunk)
                return
            return self.respond(404,{'error':'없는 경로입니다.'})
        except (BrokenPipeError,ConnectionResetError):pass
        except Exception as error:self.respond(500,{'error':str(error)})

    def do_POST(self):
        if self.path!='/api/sync':return self.respond(405,{'error':'라벨 수정은 지원하지 않습니다.'})
        if self.headers.get('Origin')!=f'http://127.0.0.1:{PORT}':return self.respond(403,{'error':'이 화면에서만 갱신할 수 있습니다.'})
        try:
            sys.path.insert(0,str(HERE.parent/'training'))
            from pipeline import sync,OUTPUT
            OUTPUT.mkdir(parents=True,exist_ok=True)
            with (OUTPUT/'pipeline.lock').open('w') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);sync()
            self.respond(200,{'ok':True})
        except BlockingIOError:self.respond(409,{'error':'학습 작업이 실행 중입니다. 완료 후 다시 받아 주세요.'})
        except Exception as error:self.respond(500,{'error':str(error)})

if __name__=='__main__':
    try:server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    except OSError:
        from urllib.request import urlopen
        with urlopen(f'http://127.0.0.1:{PORT}/api/library',timeout=5) as response:
            if json.load(response).get('app')!='home-label-library':raise RuntimeError('다른 서비스가 포트를 사용하고 있습니다.')
        subprocess.run(['open',f'http://127.0.0.1:{PORT}'],check=True);sys.exit(0)
    if '--open' in sys.argv:subprocess.run(['open',f'http://127.0.0.1:{PORT}'],check=True)
    print(f'홈 라벨 모아보기: http://127.0.0.1:{PORT}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:server.server_close()
