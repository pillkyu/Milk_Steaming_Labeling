"""이 Mac의 검증된 Chic 학습 코드를 재사용하는 홈 음원 수집→학습→평가 파이프라인."""
import os
os.environ['OMP_NUM_THREADS']='2'
os.environ['OPENBLAS_NUM_THREADS']='2'
from pathlib import Path
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import argparse,hashlib,importlib,json,pickle,shutil,subprocess,sys,time
import numpy as np

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
REPO=ROOT/'Milk_Steaming_Labeling_Data'
OLD=ROOT/'Analysis/HomeSteaming20261111'
ENGINE=ROOT/'Analysis/HomeSteamingApp20261111'
DATA=ROOT/'Analysis/PuffinFiveSounds20261027'
APP=ROOT.parent/'ADA/2026-C6-A04-BEANDOONG/chic/Services/SoundAnalysis'
OUTPUT=ROOT/'TrainingRuns/HomeSteaming'
read=lambda p:json.loads(Path(p).read_text())
def sha(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()
def write(p,value):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True)
    tmp=p.with_suffix(p.suffix+'.tmp');tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n');tmp.replace(p)
def command(args,**kwargs):
    return subprocess.run([str(a) for a in args],check=True,**kwargs)
def git(*args):
    return subprocess.check_output(['git','-C',str(REPO),*args],text=True).strip()


def sync():
    credentials=['git','-c','credential.helper=','-c','credential.helper=!gh auth git-credential']
    if not REPO.exists():command(credentials+['clone','https://github.com/pillkyu/Milk_Steaming_Labeling_Data.git',str(REPO)])
    else:
        if git('status','--porcelain'):raise RuntimeError('데이터 저장소에 로컬 변경이 있습니다. 덮어쓰지 않고 중단합니다.')
        remote=git('remote','get-url','origin')
        if remote not in ['https://github.com/pillkyu/Milk_Steaming_Labeling_Data.git','git@github.com:pillkyu/Milk_Steaming_Labeling_Data.git']:
            raise RuntimeError('데이터 저장소 origin이 예상한 저장소와 다릅니다.')
        command(credentials+['-C',str(REPO),'pull','--ff-only'])


def assign_folds(sources):
    """동일 원본·세션은 같은 분할에 두며 기존 원본 분할은 유지합니다."""
    used={}
    for s in sources:
        if s['pcmSHA256'] in used:raise ValueError('중복 PCM 원본이 있습니다.')
        used[s['pcmSHA256']]=s['id']
        if 'fold' not in s:
            group=s.get('sessionGroup') or s['id']
            s['fold']=int(hashlib.sha256(group.encode()).hexdigest()[:8],16)%5
    groups={}
    for s in sources:
        g=s.get('sessionGroup') or s['id']
        if g in groups and groups[g]!=s['fold']:raise ValueError('같은 세션이 여러 분할에 걸쳐 있습니다.')
        groups[g]=s['fold']
    return sources


def phase_fp(source,replay):
    """미라벨을 음성 정답으로 쓰지 않고, 알려진 라벨에서만 클래스별 오탐을 셉니다."""
    order=['normal_air','surface_sputter','metallic_squeal','balanced_rolling']
    truth=np.full(len(replay['raw']),-2,dtype=int)
    t=(2048+512*np.arange(len(truth)))/48000
    for e in source['segments']:
        if e['label'] not in order+['steam_start','steam_end','non_steam']:continue
        mask=(t>=e['start']+2048/48000)&(t<e['end'])
        truth[mask]=order.index(e['label']) if e['label'] in order else -1
    prediction=np.asarray(replay['raw']);result={}
    for i,label in enumerate(order):
        positive=truth==i;negative=(truth!=-2)&~positive;flag=(prediction==i)&negative
        result[label]=dict(tp=int(np.sum((prediction==i)&positive)),fp=int(flag.sum()),fn=int(np.sum((prediction!=i)&positive)),tn=int(np.sum((prediction!=i)&negative)),
            falseSeconds=float(flag.sum()*512/48000),falseEpisodes=int(np.sum(flag&~np.r_[False,flag[:-1]])))
    return result


class Pipeline:
    def __init__(self):
        self.commit=git('rev-parse','HEAD')
        inputs=[Path(__file__),HERE/'replay.swift',HERE/'validate-dataset.mjs',HERE.parent/'site/records.mjs',HERE.parent/'site/feedback.mjs',
                ENGINE/'experiment.py',ENGINE/'end_export.py',ENGINE/'evaluate.py',OLD/'sources.json',OLD/'audit.json']
        inputs+=list((ENGINE/'source').glob('*.swift'))+list((ENGINE/'baseline/models').glob('*.mlmodel'))
        inputs+=list((ENGINE/'native').iterdir())+[OLD/'native/extract',APP/'ChicEndRule.swift',APP/'SteamingAudioAnalyzer.swift']
        self.hashes={str(p):sha(p) for p in inputs}
        fingerprint=hashlib.sha256(json.dumps(self.hashes,sort_keys=True).encode()).hexdigest()[:12]
        self.root=OUTPUT/'runs'/f'{self.commit[:12]}-{fingerprint}'
        self.root.mkdir(parents=True,exist_ok=True)
        self.state=read(self.root/'state.json') if (self.root/'state.json').exists() else {}
        write(self.root/'provenance.json',dict(dataCommit=self.commit,codeHashes=self.hashes,python=sys.version,
            grouping='original-file holdout; recording-session metadata unavailable for current uploads',
            thresholds='existing app thresholds unchanged; no automatic model promotion'))
        self.env={**os.environ,'DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer'}
        sys.path.insert(0,str(ENGINE));self.ex=importlib.import_module('experiment');self.ex.R=self.root
        self.setup_dependencies()
        self.ex.PROTO_ROOT=OUTPUT/'dependencies'
        self.ev=importlib.import_module('evaluate');self.ev.R=self.root

    def setup_dependencies(self):
        dest=OUTPUT/'dependencies'
        for relative in ['coremltools/proto','google']:
            if not (dest/relative).exists():
                src=Path('/private/tmp/chic-coreml-inspect')/relative
                if not src.exists():raise RuntimeError('CoreML 내보내기 의존성이 없습니다: '+str(src))
                shutil.copytree(src,dest/relative,ignore=shutil.ignore_patterns('__pycache__'))

    def run_stage(self,name,fn):
        if self.state.get(name,{}).get('status')=='complete':
            for relative,digest in self.state[name]['artifacts'].items():
                p=self.root/relative
                if not p.is_file() or sha(p)!=digest:raise RuntimeError('완료된 결과가 변경되었거나 없습니다: '+str(p))
            print('REUSE',name,flush=True);return
        started=time.time();self.state[name]={'status':'running'};write(self.root/'state.json',self.state)
        print('START',name,flush=True)
        try:fn()
        except BaseException as error:
            self.state[name]={'status':'failed','error':str(error)};write(self.root/'state.json',self.state);raise
        patterns={
            'prepare':['sources.json','data-audit.json','protocol.json','snapshot/recordings/*/*','source/*.swift','native/replay','baseline/models/*.mlmodel'],
            'features':['features/*.f64','phase-features/*.f64','models/*/*/train.f64','models/*/*/labels.json','models/*/*/classes.json','models/*/test.f64','models/*/split.json','models/*/offsets.json'],
            'train':['models/*/*/scores.f64','models/*/*/model.pickle','models/*/*/training.json','models/*/*/pred@*.npz','models/*/app/*.mlmodel'],
            'evaluate':['REPORT.md','summary.json','checks.json','fp-by-source.json','evaluation-rows.json']}
        artifacts={str(p.relative_to(self.root)):sha(p) for pattern in patterns[name] for p in self.root.glob(pattern)}
        self.state[name]={'status':'complete','seconds':round(time.time()-started,2),'artifacts':artifacts};write(self.root/'state.json',self.state)
        print('DONE',name,self.state[name]['seconds'],'seconds',flush=True)

    def prepare(self):
        snapshot=self.root/'snapshot';snapshot.mkdir(exist_ok=True)
        paths=git('ls-tree','-r','--name-only',self.commit,'recordings').splitlines()
        for rel in paths:
            target=snapshot/rel;target.parent.mkdir(parents=True,exist_ok=True)
            with target.open('wb') as out:command(['git','-C',REPO,'show',f'{self.commit}:{rel}'],stdout=out)
        command(['node',HERE/'validate-dataset.mjs',snapshot])
        oldaudit=read(OLD/'audit.json')
        for name,digest in oldaudit['snapshots'].items():
            if sha(DATA/name)!=digest:raise RuntimeError('기존 라벨 스냅샷이 바뀌었습니다. 원본 매핑을 갱신해야 합니다: '+name)
        sources=read(OLD/'sources.json');oldhash={}
        for s in sources:
            if sha(s['pcm'])!=s['pcmSHA256']:raise RuntimeError('기존 PCM 해시 불일치')
            originals=list((DATA/'media'/s['id']).glob('original.*'))
            if len(originals)==1:oldhash[sha(originals[0])]=s['id']
            s['origin']='legacy';s['sessionGroup']=s['id']
        audit=[];new=[];superseded=set();seen={s['pcmSHA256']:s['id'] for s in sources}
        ffmpeg=next((ROOT/'.venv').glob('lib/python*/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-*'))
        for path in sorted((snapshot/'recordings').glob('*/record.json')):
            record=read(path);s=record['source'];review=record['review'];sid=s['id']
            if sid in oldhash:superseded.add(oldhash[sid])
            status='excluded' if review['excluded'] else 'unreviewed' if not review['reviewed'] else 'included'
            audit.append(dict(id=sid,title=s['title'],status=status,feedback=Counter(c['decision'] for c in review.get('feedback',{}).get('checks',[]))))
            if status!='included':continue
            pcm=path.parent/'audio.f32'
            command([ffmpeg,'-nostdin','-v','error','-y','-i',snapshot/s['originalAudio'],'-ac','1','-ar','48000','-f','f32le',pcm])
            duration=pcm.stat().st_size/4/48000
            if abs(duration-s['duration'])>.1:raise RuntimeError('브라우저/로컬 음원 길이가 다릅니다: '+s['title'])
            digest=sha(pcm)
            if digest in seen:
                old_id=seen[digest]
                if any(n['id']==old_id for n in new):raise RuntimeError('서로 다른 업로드가 같은 PCM입니다. 라벨 충돌을 확인하세요.')
                superseded.add(old_id)
            seen[digest]=sid
            segments=json.loads(json.dumps(review['segments']))
            for e in segments:
                if e['end']>duration:e['end']=duration
                if e['start']>=e['end']:raise RuntimeError('디코딩 후 음원 범위를 벗어난 구간입니다.')
            new.append(dict(id=sid,title=s['title'],kind='recording',domain='home',origin='github',sourceGroup=s['sourceGroup'],sessionGroup=sid,
                pcm=str(pcm),pcmSHA256=digest,duration=duration,features=str(self.root/'phase-features'/f'{sid}.f64'),segments=segments))
        sources=[s for s in sources if s['id'] not in superseded]+new
        assign_folds(sources)
        for f in range(5):
            labels={e.get('endSignal',e['label']) for s in sources if s['fold']!=f for e in s['segments']}
            if not set(['normal_air','surface_sputter','metallic_squeal','balanced_rolling','steam_start','steam_end','steam_purge','non_steam'])<=labels:
                raise RuntimeError('일부 분할에 학습 클래스가 부족합니다.')
        write(self.root/'sources.json',sources)
        write(self.root/'data-audit.json',dict(records=audit,originals=len(sources),newOriginals=len(new),superseded=sorted(superseded),
            events=dict(Counter(e.get('endSignal',e['label']) for s in sources for e in s['segments'])),
            excludedLabels=['unknown','exclude','excess_bubbling'],snapshotHashes=oldaudit['snapshots']))
        shutil.copytree(ENGINE/'baseline',self.root/'baseline',dirs_exist_ok=True)
        for name in ['source','native']:shutil.copytree(ENGINE/name,self.root/name,dirs_exist_ok=True)
        shutil.copy2(APP/'ChicEndRule.swift',self.root/'source/ChicEndRule.swift')
        shutil.copy2(APP/'SteamingAudioAnalyzer.swift',self.root/'baseline/source/SteamingAudioAnalyzer.swift')
        shutil.copy2(HERE/'replay.swift',self.root/'source/replay.swift')
        common=['ChicModelV3_5','ChicStartGate','ChicDisplayFilter','ChicEndRule','ChicEndDetector','ChicV2FeatureExtractor','ChicV2SpectralFeatures','replay']
        command(['xcrun','swiftc','-O','-module-cache-path',OUTPUT/'swift-cache',*[self.root/'source'/f'{n}.swift' for n in common],'-o',self.root/'native/replay'],env=self.env)
        write(self.root/'protocol.json',dict(read(ENGINE/'protocol.json'),sourceFiles=len(sources),originals=len(sources),
            split='five original-file folds; legacy assignments retained, new original IDs hashed; same-session independence unverified',
            endPolicy='current app asks for confirmation and continues; all detector requests logged, not automatic terminations',
            dataCommit=self.commit))

    def features(self):
        sources=read(self.root/'sources.json');(self.root/'phase-features').mkdir(exist_ok=True);(self.root/'features').mkdir(exist_ok=True)
        for s in sources:
            frames=(Path(s['pcm']).stat().st_size//4-2048)//512+1
            p=Path(s['features'])
            if not p.exists():command([OLD/'native/extract',s['pcm'],p],env=self.env)
            x=np.memmap(p,'<f8','r').reshape(-1,273)
            assert len(x)==frames and np.isfinite(x).all()
            for gain in [0,-24]:
                target=self.root/'features'/f"{s['id']}@{gain}.f64";cached=ENGINE/'features'/target.name
                if s['origin']=='legacy' and not target.exists():
                    if cached.stat().st_size!=frames//10*1845*8:raise RuntimeError('기존 특징 캐시 길이 오류')
                    os.link(cached,target)
                if target.exists() and target.stat().st_size!=frames//10*1845*8:target.unlink()
        self.ex.capture()
        self.ex.prepare_tables(sources)

    def train(self):
        for f in [0,1,2,3,4,'full']:
            base=self.root/'models'/str(f)
            frames=(base/'test.f64').stat().st_size//(273*8)
            for h,classes in self.ex.CLASSES.items():
                score=base/h/'scores.f64'
                if score.exists() and score.stat().st_size!=frames*len(classes)*8:score.unlink()
            for h in ['Activity','End']:
                cached=base/h/'model.pickle'
                if cached.exists():
                    try:pickle.loads(cached.read_bytes())
                    except (EOFError,pickle.UnpicklingError):cached.unlink()
        self.ex.train_phase();self.ex.train_end()
        argv=sys.argv;sys.argv=['experiment.py','export']
        try:self.ex.export()
        finally:sys.argv=argv
        # 기존 앱 모델의 출력 계약을 유지하며 실행 식별자를 모델에도 기록합니다.
        proto=self.ex.proto()
        for model in (self.root/'models/full/app').glob('*.mlmodel'):
            spec=proto.Model();spec.ParseFromString(model.read_bytes())
            spec.description.metadata.versionString=self.root.name
            spec.description.metadata.shortDescription='Home steaming candidate; see run REPORT.md and provenance.json'
            model.write_bytes(spec.SerializeToString())
            command(['xcrun','coremlcompiler','compile',model,model.parent],env=self.env,stdout=subprocess.DEVNULL)

    def evaluate(self):
        sources=read(self.root/'sources.json');rows=[];per_source=[]
        dest=self.root/'results';dest.mkdir(exist_ok=True)
        def replay(s):
            out=dest/f"{s['id']}.json"
            command([self.root/'native/replay',s['pcm'],self.root/'models'/str(s['fold'])/'app',self.root/'baseline/models/ChicAudioFeatures.mlmodelc',out],env=self.env,stdout=subprocess.DEVNULL)
            return s,read(out)
        with ThreadPoolExecutor(2) as pool:
            for s,v in pool.map(replay,sources):
                base=self.root/'models'/str(s['fold']);lo,hi=read(base/'offsets.json')[s['id']]
                heads={h:np.memmap(base/h/'scores.f64','<f8','r').reshape(-1,len(classes))[lo:hi] for h,classes in self.ex.CLASSES.items()}
                assert np.array_equal(self.ev.phase_states(heads['Gate'],heads['Air'],heads['Metallic']),v['raw'])
                a=np.load(base/'Activity/pred@0.npz')[s['id']];e=np.load(base/'End/pred@0.npz')[s['id']]
                assert np.max(np.abs(np.c_[a[:,:2],e[:,2:]]-np.asarray(v['scores'])))<2e-6
                rows.append(self.ev.measure(s,v,heads['Start'][:,1]))
                requests=[dict(**r,label=self.ev.point_label(s,r['time'])) for r in v['endRequests']]
                per_source.append(dict(id=s['id'],origin=s['origin'],phase=phase_fp(s,v),endRequests=requests))
        self.ev.self_check();summary=self.ev.summary(rows)
        totals={}
        for label in self.ev.ORDER:
            q={key:sum(r['phase'][label][key] for r in per_source) for key in ['tp','fp','fn','tn','falseSeconds','falseEpisodes']}
            q.update(precision=q['tp']/max(1,q['tp']+q['fp']),recall=q['tp']/max(1,q['tp']+q['fn']),falsePositiveRate=q['fp']/max(1,q['fp']+q['tn']))
            totals[label]=q
        requests=[dict(source=r['id'],**e) for r in per_source for e in r['endRequests']]
        summary['falsePositiveMetrics']=totals
        summary['endConfirmationRequests']=dict(total=len(requests),duringKnownWork=sum(r['label'] in self.ev.ORDER+['steam_start'] for r in requests),unscored=sum(r['label']=='unscored' for r in requests))
        summary['newUploadSubset']=self.ev.summary([r for r in rows if next(s for s in sources if s['id']==r['id'])['origin']=='github'])
        summary['interpretation']='OOF development evaluation; current app keeps running after end-confirmation requests; not an independent test of the full-data export'
        write(self.root/'evaluation-rows.json',rows);write(self.root/'fp-by-source.json',per_source);write(self.root/'summary.json',summary)
        self.verify_exports(sources)
        self.report(summary)

    def verify_exports(self,sources):
        d=self.root/'verification';d.mkdir(exist_ok=True);models=self.root/'models/full/app';errors={}
        for h,classes in self.ex.CLASSES.items():
            names=classes+['breath_whistle'] if h=='Gate' else classes;write(d/f'{h}.json',names)
            command([self.root/'native/score',models/(self.ex.NAMES[h]+'.mlmodelc'),self.root/'models/full/test.f64',d/f'{h}.json',d/f'{h}.f64'],env=self.env)
            actual=np.fromfile(d/f'{h}.f64','<f8').reshape(-1,len(names));expected=np.fromfile(self.root/'models/full'/h/'scores.f64','<f8').reshape(-1,len(classes))
            if h=='Gate':assert np.all(actual[:,-1]==0);actual=actual[:,:-1]
            errors[h]=float(abs(actual-expected).max());assert errors[h]<1e-12
        x=np.concatenate([np.memmap(self.root/'features'/f"{s['id']}@0.f64",'<f8','r').reshape(-1,1845)[:3] for s in sources]);x.astype('<f8').tofile(d/'end-input.f64')
        command([self.root/'native/score-end',models/'ChicEndV3_5.mlmodelc',d/'end-input.f64',d/'end-output.f64'],env=self.env)
        a=pickle.loads((self.root/'models/full/Activity/model.pickle').read_bytes());e=pickle.loads((self.root/'models/full/End/model.pickle').read_bytes())
        errors['End']=float(abs(np.c_[a.predict_proba(x),e.predict_proba(x)]-np.fromfile(d/'end-output.f64','<f8').reshape(-1,8)).max());assert errors['End']<2e-6
        for f in range(5):
            split=read(self.root/'models'/str(f)/'split.json');assert set(split['train']).isdisjoint(split['test'])
            for head in [*self.ex.CLASSES,'Activity','End']:
                assert set(read(self.root/'models'/str(f)/head/'training.json')['sources'])<=set(split['train'])
        write(self.root/'checks.json',dict(nativeExportMaxError=errors,allOOFNativeReplayMatches=True,originalSplitChecked=True,modelFiles={p.name:sha(p) for p in models.glob('*.mlmodel')}))

    def report(self,s):
        audit=read(self.root/'data-audit.json');table=[]
        for label,q in s['falsePositiveMetrics'].items():
            table.append(f"| {label} | {q['precision']:.1%} | {q['recall']:.1%} | {q['falseSeconds']:.2f} | {q['falseEpisodes']} |")
        text=f'''# 홈 스티밍 학습 결과

데이터 커밋: `{self.commit}` · 실행: `{self.root.name}`

기존 홈 자료와 사용 가능한 신규 녹음 {audit['newOriginals']}개를 합친 원본 {audit['originals']}개. 웹의 검수 완료/사용 제외를 반영하고 미라벨·끓는음은 학습/채점에서 제외했습니다. 웹 이상치 점수로 자동 삭제하지 않았습니다.

원본 단위 5분할 개발 평가의 작업음 정확도 **{s['rawAccuracy']:.1%}**, macro-F1 **{s['rawMacroF1']:.1%}**입니다. 아래 정밀도는 알려진 비작업 라벨까지 오탐에 포함해 이 작업음 전용 정확도와 분모가 다릅니다.

| 소리 | 정밀도 | 재현율 | 다른 정답에서의 오탐 시간(초) | 오탐 연속 구간 수 |
|---|---:|---:|---:|---:|
{chr(10).join(table)}

현재 앱은 종료 소리가 나도 자동 종료하지 않고 사용자에게 확인합니다. 종료 확인 요청 {s['endConfirmationRequests']['total']}회 중 알려진 작업/시작 구간에서 {s['endConfirmationRequests']['duringKnownWork']}회, 미채점 구간에서 {s['endConfirmationRequests']['unscored']}회입니다. 원시 소리 분류 오탐과 실제 사용자 알림 횟수는 다릅니다.

최종 모델: `models/full/app/`의 5개 `.mlmodel` 및 컴파일 결과. 플랫폼 특징 모델은 `baseline/models/ChicAudioFeatures.mlmodel`을 그대로 사용합니다. 전체 자료로 다시 학습한 최종 모델 자체의 독립 테스트 점수는 아닙니다. 앱에는 자동 적용하지 않았습니다.

기존 Gate→Air/Metallic, 273차원 입력, Start, 1845차원 End 구조와 문턱을 유지했습니다. 숨소리/휘파람은 홈 정답이 없어 전용 출력은 미학습(0)입니다. 롤링으로 귀결되는 기존 분기 특성상 롤링 오탐이 클 수 있습니다. 성능이 좋다고 판정하거나 문턱을 시험 데이터에 맞춰 바꾸지 않았습니다.

`data-audit.json`: 파일별 포함/제외. `fp-by-source.json`: 원본별 오탐 및 종료 확인 요청. `checks.json`: 모든 평가 모델의 네이티브 재생 일치와 최종 CoreML 내보내기 검증. `provenance.json`: 코드·데이터 버전. `state.json`: 단계별 상태와 시간.

한계: 같은 날/같은 세션 독립성을 확인할 메타데이터가 없습니다. 미라벨은 정상/비스티밍 정답이 아니므로 오탐의 분모에 넣지 않았습니다. 독립된 배경음·사용자 환경에서의 최종 검증이 필요합니다.
'''
        (self.root/'REPORT.md').write_text(text)
        write(OUTPUT/'latest.json',dict(run=str(self.root),report=str(self.root/'REPORT.md'),models=str(self.root/'models/full/app'),dataCommit=self.commit))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage',choices=['all','prepare','features','train','evaluate'],nargs='?',default='all')
    parser.add_argument('--no-pull',action='store_true',help='이미 내려받은 커밋을 사용')
    args=parser.parse_args()
    if not args.no_pull:sync()
    pipeline=Pipeline();print('RUN',pipeline.root,flush=True)
    stages=['prepare','features','train','evaluate']
    for stage in stages[:stages.index(args.stage)+1] if args.stage!='all' else stages:
        pipeline.run_stage(stage,getattr(pipeline,stage))
    print('RESULT',pipeline.root,flush=True)


if __name__=='__main__':main()
