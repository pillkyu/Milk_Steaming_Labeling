"""Mac의 기존 Python/Swift 학습 환경을 호출하는 수동 실행 DAG."""
from datetime import datetime,timedelta,timezone
from pathlib import Path
import json,os
from airflow.sdk import DAG
from airflow.providers.standard.operators.bash import BashOperator

ROOT=Path(os.environ['MILK_TRAINING_WORKSPACE'])
TRAINING=ROOT/'Milk_Steaming_Labeling/training'
with DAG(
    dag_id='home_steaming_training',
    description='홈 음원 내려받기 → 검사 → 특징 → 학습 → 오탐 평가',
    schedule=None,start_date=datetime(2026,11,12,tzinfo=timezone.utc),catchup=False,
    max_active_runs=1,max_active_tasks=1,tags=['홈 스티밍','모델 학습'],
    default_args={'retries':1,'retry_delay':timedelta(minutes=1),'execution_timeout':timedelta(hours=3)},
    doc_md='''# 홈 스티밍 학습
오른쪽 위 **Trigger**로 시작합니다. 같은 데이터·코드로 완료한 단계는 결과 해시를 검사하고 재사용합니다.

각 사각형을 눌러 **Logs**에서 진행 상황을 확인하세요. 마지막 **오탐 평가·결과**의 로그에 성능 표와 결과 경로가 있고, XCom에는 지표 JSON이 있습니다.

검수 완료 자료만 학습하며 사용 제외·미라벨을 정답으로 바꾸지 않습니다. 웹 이상치 경고는 자동 삭제 근거가 아닙니다. 앱 모델은 자동 교체하지 않습니다.
''',
) as dag:
    previous=None
    for task_id,stage,title in [
        ('pull_data','pull','1 · 최신 음원 받기'),
        ('inspect_data','prepare','2 · 원본·라벨 검사'),
        ('extract_features','features','3 · 특징 추출'),
        ('train_models','train','4 · 모델 학습'),
        ('evaluate_models','evaluate','5 · 오탐 평가·결과'),
    ]:
        task=BashOperator(
            task_id=task_id,task_display_name=title,
            bash_command='exec "$TRAIN_PYTHON" "$TRAIN_RUNNER" --airflow-task '+stage,
            env={'TRAIN_PYTHON':str(ROOT/'.venv-clap/bin/python'),'TRAIN_RUNNER':str(TRAINING/'runner.py'),
                 'PINNED_RUN':"{{ ti.xcom_pull(task_ids='pull_data') | tojson }}"},
            append_env=True,cwd=str(ROOT),output_processor=lambda text:json.loads(text),skip_on_exit_code=None,
        )
        if previous:previous>>task
        previous=task
