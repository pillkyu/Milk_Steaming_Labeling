"""CLI와 Airflow의 실행 잠금 및 DAG 실행별 데이터 버전 고정."""
from pathlib import Path
import fcntl,json,os,sys
from pipeline import OUTPUT,Pipeline,main,sync

OUTPUT.mkdir(parents=True,exist_ok=True)
with (OUTPUT/'pipeline.lock').open('w') as lock:
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise SystemExit('다른 학습 단계가 실행 중입니다. 완료 후 다시 실행하세요.')
    if len(sys.argv)>1 and sys.argv[1]=='--airflow-task':
        stage=sys.argv[2]
        if stage=='pull':
            sync();p=Pipeline()
            result=dict(commit=p.commit,run=str(p.root))
        else:
            pinned=json.loads(os.environ['PINNED_RUN']);p=Pipeline()
            if pinned!={'commit':p.commit,'run':str(p.root)}:
                raise SystemExit('실행 도중 데이터 또는 코드 버전이 바뀌었습니다. 새 DAG 실행으로 다시 시작하세요.')
            if stage not in ['prepare','features','train','evaluate']:raise SystemExit('알 수 없는 단계')
            p.run_stage(stage,getattr(p,stage))
            result=dict(stage=stage,run=str(p.root),status='complete')
            if stage=='evaluate':
                print((p.root/'REPORT.md').read_text())
                summary=json.loads((p.root/'summary.json').read_text())
                result.update(report=str(p.root/'REPORT.md'),models=str(p.root/'models/full/app'),
                    rawAccuracy=summary['rawAccuracy'],falsePositiveMetrics=summary['falsePositiveMetrics'],
                    endConfirmationRequests=summary['endConfirmationRequests'])
        print(json.dumps(result,ensure_ascii=False))
    else:main()
