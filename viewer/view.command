#!/bin/sh
set -eu
task_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_root=$(CDPATH= cd -- "$task_dir/../.." && pwd)
exec "$task_root/.venv-clap/bin/python" "$task_dir/serve.py" --open
