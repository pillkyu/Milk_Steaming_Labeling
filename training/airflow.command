#!/bin/sh
set -eu
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_root=$(CDPATH= cd -- "$task_dir/../.." && pwd)
export MILK_TRAINING_WORKSPACE="$task_root"
export AIRFLOW_HOME="$task_root/TrainingRuns/Airflow/home"
export AIRFLOW__CORE__DAGS_FOLDER="$task_dir/dags"
export AIRFLOW__CORE__LOAD_EXAMPLES=False
export AIRFLOW__CORE__PARALLELISM=1
export AIRFLOW__CORE__SIMPLE_AUTH_MANAGER_ALL_ADMINS=True
export AIRFLOW__API__HOST=127.0.0.1
export AIRFLOW__API__PORT=8088
export AIRFLOW__API__BASE_URL=http://127.0.0.1:8088
export AIRFLOW__CORE__EXECUTION_API_SERVER_URL=http://127.0.0.1:8088/execution/
export PATH="$task_root/TrainingRuns/Airflow/.venv/bin:/opt/homebrew/bin:$PATH"
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
mkdir -p "$AIRFLOW_HOME"
if [ "$#" -eq 0 ]; then set -- standalone; fi
exec "$task_root/TrainingRuns/Airflow/.venv/bin/airflow" "$@"
