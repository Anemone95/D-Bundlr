import json
import logging
import os
import shutil
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Callable

import CommandRunner
import settings
from TempDirectoryManager import TempDirectoryManager
from cli import Cli, read_db, jelly_run2, requires_source, sub_packages
from jelly_statistics import make_db
import JellyTask as Task
from utils import memory_str_to_megabytes, remove_non_alpha_characters

check_finish_task = ["jelly"]

dynamic_dir = None


def compare_to_dynamic_wrapper(task: Task.JellyTask, task_label: str, compare_with: str, output_file: str,
                               dynamic_dir: Path, log_file: str = None):
    if dynamic_dir is None:
        logging.error("ERR: dynamic_dir is None")
        return
    Cli._compare_callgraphs_run(task, task_label, dynamic_dir, compare_with, output_file, log_file)


def jelly_wrapper(*args, **kwargs):
    if not kwargs.get("old_dir", None):
        kwargs["old_dir"] = None
    else:
        kwargs["old_dir"] = Path(kwargs["old_dir"])

    task_label = kwargs["task_label"]
    sub_package = kwargs["task"]
    kwargs["output_dir"] = f"{settings.WORK_DIR}/{task_label}/{sub_package.canonical_name}/{sub_package.canonical_version}"
    kwargs["target_dir"] = str(sub_package.dir)
    sub_finish_file = f"{kwargs['output_dir']}/{kwargs['finish_file']}"
    if "jelly_args" in kwargs:
        kwargs["jelly_args"] = replace_variables(kwargs["task"], kwargs["task_label"], kwargs["jelly_args"])
    if "jelly_path" in kwargs:
        kwargs["jelly_path"] = replace_variables(kwargs["task"], kwargs["task_label"], kwargs["jelly_path"])
    if os.path.exists(sub_finish_file):
        return
    jelly_run2(*args, **kwargs)
    with open(sub_finish_file, "w+") as f:
        f.write("FIN")


def replace_variables(task: Task, task_label: str, s: str) -> str:
    micros = {
        "$PACKAGES_DIR": settings.PACKAGES_DIR,
        "$PACKAGE_NAME": task.canonical_name,
        "$TASK_TMP_DIR": f"{settings.TMP_DIR}/{task_label}",
        "$TARGET_TMP_DIR": f"{settings.TMP_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}",
        "$TARGET": str(task.dir),
        "$PACKAGE_DIR": f"{settings.PACKAGES_DIR}/{task.canonical_name}/{task.task.canonical_version if isinstance(task, Task.SubTask) else task.canonical_version}",
        "$PACKAGE_VERSION": task.canonical_version,
        "$TASK_LABEL": task_label,
        "$BENCHMARK_DIR": settings.PROJECT_DIR,
        "$RESULTS_DIR": f"{settings.WORK_DIR}/{task_label}",
        "$RESULT_DIR": f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}",
        "$SCRIPT_DIR": settings.SCRIPT_DIR,
        "$JELLY_PATH": settings.JELLY_PATH,
        "$MAX_MEMORY_MB": str(memory_str_to_megabytes(settings.MEMORY_PER_PROCESS)),
        "$CODE_QL_HOME": settings.CODE_QL_HOME,
    }
    for [k, v] in micros.items():
        s = s.replace(k, str(v))
    return s


def remove_dir(task: Task.JellyTask, task_label: str, rel_path: str):
    rel_path = replace_variables(task, task_label, rel_path)
    if os.path.isabs(rel_path):
        abs_path = Path(rel_path)
    else:
        abs_path = Path(settings.WORK_DIR) / task_label / task.canonical_name / task.canonical_version / rel_path
    if not os.path.exists(abs_path):
        print(f"WARN: remove path {abs_path} not exists")
        return
    if os.path.isdir(abs_path):
        shutil.rmtree(abs_path, ignore_errors=True)
    else:
        os.remove(abs_path)


def exec_command(task: Task.JellyTask, task_label: str, command: str,
                 require_source: bool = False,
                 env: dict[str, str] = None,
                 timeout: int = None,
                 cwd: str = None,
                 log_file: str = None, finish_file: str = None):
    """

    :param task:
    :param task_label:
    :param command:
    :param timeout:
    :param log_file: relative path(/results/task_label/package_name/version/log_file) of the log file
    :return:
    """
    task_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"
    if finish_file:
        finish_file = f"{task_dir}/{finish_file}"
        if os.path.exists(finish_file):
            return
    runner = CommandRunner.CommandRunner()
    command = replace_variables(task, task_label, command)
    if env is not None:
        for [k, v] in env.items():
            env[k] = replace_variables(task, task_label, v)
            
    if log_file:
        log_file_path = f"{task_dir}/{log_file}"
    else:
        log_file_path = f"{task_dir}/{remove_non_alpha_characters(command[:10])}.log"

    if not os.path.exists(log_file_path):
        os.makedirs(os.path.dirname(log_file_path), exist_ok=True)

    runner.run_and_log(command, log_file_path, timeout=timeout, env=env, cwd=task_dir if cwd is None else replace_variables(task, task_label, cwd))
    if finish_file:
        with open(finish_file, "w") as f:
            f.write("FIN")



def hard_link(task: Task.JellyTask, task_label: str, source_file: str, target_file: str):
    if not os.path.exists(source_file) and os.path.isfile(source_file):
        print("WARN: source file not exists or source file is not a file")
        return
    os.link(source_file, target_file)


def link_dyn_callgraph(task: Task.JellyTask, task_label: str, dynamic_dir: Path, target_filename: str):
    dynamic_callgraph = (
            dynamic_dir
            / task.canonical_name
            / task.canonical_version
            / "dynamic_callgraph.json"
    )
    if not os.path.exists(dynamic_callgraph) and os.path.isfile(dynamic_callgraph):
        print("WARN: source file not exists or source file is not a file")
        return
    output_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}/{target_filename}"
    os.link(dynamic_callgraph.absolute(), output_dir)


def compare_callgraphs(task: Task.JellyTask, task_label: str, cg1: str, cg2: str, log_file: str,
                               jelly_path: str = None):
    output_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"
    callgraph_1 = Path(output_dir) / cg1
    callgraph_2 = Path(output_dir) / cg2

    runner = CommandRunner.CommandRunner(output_size=500, silent=True)
    if not jelly_path:
        path_dirs = os.environ['PATH'].split(os.pathsep)
        for directory in path_dirs:
            file_path = os.path.join(directory, "jelly")
            if os.path.exists(file_path):
                jelly_path = file_path
                break
    else:
        jelly_path=replace_variables(task, task_label, jelly_path)
    if not jelly_path:
        raise FileNotFoundError("jelly executable not found in $PATH")
    cmd = f"node {jelly_path if jelly_path else 'jelly'} --compare-callgraphs --reachability {callgraph_1} {callgraph_2}"
    output, code = runner.run_cmd(cmd,
                                  timeout=600,
                                  cwd=output_dir)
    if code != 0:
        with open(f"{output_dir}/{log_file}", "w+") as f:
            f.write(cmd+"\n\n"+"\n".join(runner.output))
    else:
        (Path(output_dir) / log_file).write_text(cmd+"\n\n"+"\n".join(output.split("\n")[-8:]))


def codeql(task: Task.JellyTask, task_label: str, rules: str | None = None, output_label: str = "codeql",
           source_root: str | None = None, timeout: int = settings.TIMEOUT):
    if source_root is None:
        source_root = task.dir
    else:
        source_root = Path(replace_variables(task, task_label, source_root))
    output_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"
    if not os.path.exists(source_root):
        logging.error(f"source root {source_root} not exists")
        with open(f"{output_dir}/analyzing.log", "w") as f:
            f.write(f"source root {source_root} not exists")
        return
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    database = f"{settings.TMP_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}/{uuid.uuid1()}"

    with TempDirectoryManager(database):
        runner = CommandRunner.CommandRunner()
        cmd = f"{settings.CODE_QL_HOME}/codeql/codeql database create --language=javascript {database} --source-root={source_root} --ram={memory_str_to_megabytes(settings.MEMORY_PER_PROCESS)} --threads={settings.CPU_PER_PROCESS}"
        _, code = runner.run_and_log(cmd, f"{output_dir}/{output_label}-making-db.log",
                                     timeout=timeout,
                                     env={"LGTM_INCLUDE_DIRS": str(source_root)},
                                     cwd=output_dir)
        if code != 0:
            return
        cmd = (f"{settings.CODE_QL_HOME}/codeql/codeql database analyze {database} "
               f"{replace_variables(task, task_label, rules) if rules is not None else ''} "
               f"--format=csv "
               f"--output={output_dir}/{output_label}-results.csv "
               f"--ram={memory_str_to_megabytes(settings.MEMORY_PER_PROCESS)} "
               f"--threads={settings.CPU_PER_PROCESS}")
        runner = CommandRunner.CommandRunner()
        runner.run_and_log(cmd, f"{output_dir}/{output_label}-analyzing.log",
                           timeout=timeout,
                           cwd=output_dir)

def run_steps(task: Task.JellyTask, task_label: str, step: dict[str, any], max_cpus: int, max_memory:str, step_i: int):
    try:
        _args = {key: value for key, value in step.items() if key != "name"}
        _args["task"] = task
        _args["task_label"] = task_label
        if step["name"] in check_finish_task or (
                step["name"] == "exec_command" and step.get("require_source", False)):
            _args["finish_file"] = f".finished-{step_i}"
        # sub tasks which need dynamic_dir args
        if step["name"] in ["compare_to_dynamic", "link_dyn_callgraph"]:
            _args["dynamic_dir"] = dynamic_dir
        # TODO: refactoring this code
        if step["name"] == "jelly":
            _args["cpus"] = max_cpus
            if "memory" not in _args:
                _args["memory"] = max_memory
        if step["name"] == "conditional_step":
            _args["max_cpus"] = max_cpus
            _args["max_memory"] = max_memory
            _args["step_i"] = step_i
        func = task_executor[step["name"]]
        func(**_args)
    except Exception as e:
        print(f"Error in after_task {step['name']}")
        traceback.print_exc()

def conditional_step(task: Task.JellyTask, task_label: str, condition: str, execute: dict[str, str], max_cpus: int, max_memory: str, step_i:int):
    condition = replace_variables(task, task_label, condition)
    if eval(condition):
        run_steps(task, task_label, execute, max_cpus, max_memory, step_i)


task_executor = {
    "jelly": jelly_wrapper,
    "codeql": codeql,
    "exec_command": exec_command,
    "rm": remove_dir,
    "hard_link": hard_link,
    "link_dyn_callgraph": link_dyn_callgraph,
    "compare_to_dynamic": compare_to_dynamic_wrapper,
    "compare_callgraphs": compare_callgraphs,
    "conditional_step": conditional_step,
}


def run_pipeline_single(task: Task.JellyTask, task_label: str, black_list_packages: list[Task.JellyTask],
                        white_list_packages: list[Task.JellyTask] | None,
                        pipeline: dict[str, list[dict[str, str]]],
                        dynamic_dir: Path = None,
                        max_cpus: int = settings.CPU_PER_PROCESS,
                        max_memory: str = settings.MEMORY_PER_PROCESS,
                        ):
    if not ("before" in pipeline or "after" in pipeline or "sub_tasks" in pipeline):
        return

    # TODO: use settings to config
    with TempDirectoryManager(f"{settings.TMP_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"):
        if "before" in pipeline:
            result_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"
            if not os.path.exists(result_dir):
                os.makedirs(result_dir, exist_ok=True)

            for [i, step] in enumerate(pipeline["before"]):
                run_steps(task, task_label, step, max_cpus, max_memory, step_i=i)

        all_actions = pipeline.get("sub_tasks", []) + pipeline.get("after", [])
        need_source_code = False
        for action in all_actions:
            if "jelly" == action["name"]:
                need_source_code = True
            if "conditional_step" == action["name"] and action["execute"]["name"]=="jelly":
                need_source_code = True
            if "exec_command" == action["name"] and action.get("require_source", False):
                need_source_code = True
            if need_source_code:
                break

        if settings.INSTALL_DEPENDENCE and len(all_actions) > 0 and need_source_code:
            requires_source(lambda *args, **kwargs: None)(task, task_label, False, finish_file='.finished_prepare_package')
        idx = 0

        if "sub_tasks" in pipeline:
            for _, sub_package in sub_packages(task):
                output_dir = f"{settings.WORK_DIR}/{task_label}/{sub_package.canonical_name}/{sub_package.canonical_version}"
                # if we have out_dir, means subtask has been processed or being processed
                if os.path.exists(output_dir):
                    continue
                idx += 1
                # if has more than x sub packages, skip the rest
                if idx > settings.MAX_SUB_PACKAGES:
                    break
                # TODO: use settings to config
                with TempDirectoryManager(f"{settings.TMP_DIR}/{task_label}/{sub_package.canonical_name}/{sub_package.canonical_version}"):
                    os.makedirs(output_dir, exist_ok=True)
                    if (sub_package in black_list_packages) or (white_list_packages and sub_package not in white_list_packages):
                        output = f"{output_dir}/.skip"
                        with open(output, 'w'):
                            continue
                    for [i, action] in enumerate(pipeline.get("sub_tasks",[])):
                        run_steps(sub_package, task_label, action, max_cpus, max_memory, step_i=i)

        if "after" in pipeline:
            for [i, action] in enumerate(pipeline["after"]):
                run_steps(task, task_label, action, max_cpus, max_memory, step_i=i)

def run_pipeline(cli: Cli, db: str, task_label: str, script: str, black_list: str | None, white_list: str | None):
    """
    run with pipeline script
    :param db: database.json file path
    :param task_label: unique label for this group of tasks
    :param black_list: don't analysis the task
    :param script: script
    """
    global dynamic_dir
    global task_executor
    # cli._check_docker()
    tasks = read_db(db)
    if not script.endswith(".json"):
        script = f"{settings.SCRIPT_DIR}/script/{script}.json"

    black_list_tasks = []
    if black_list:
        black_list_tasks = read_db(black_list)
    white_list_tasks = None
    if white_list:
        white_list_tasks = read_db(white_list)
    with open(script, "r") as f:
        text = "".join(f.readlines())

    pipeline = json.loads(text)
    version_pattern = r"^(?!/)(?!.*##).+$"
    # configure settings
    task_name = "sqlite"
    if "settings" in pipeline:
        if "parallel" in pipeline["settings"]:
            cli.set_parallel(pipeline["settings"]["parallel"])
        if "task_name" in pipeline["settings"]:
            task_name = pipeline["settings"]["task_name"]
        if "task_name" in pipeline["settings"] and task_label == "TIMESTAMP":
            task_label = f"{pipeline['settings']['task_name']}-{time.strftime('%Y-%m-%d#%H.%M.%S', time.localtime())}"
        if "cpu_per_process" in pipeline["settings"]:
            settings.CPU_PER_PROCESS = pipeline["settings"]["cpu_per_process"]
        if "mem_per_process" in pipeline["settings"]:
            settings.MEMORY_PER_PROCESS = pipeline["settings"]["mem_per_process"]
        if "version_pattern" in pipeline["settings"]:
            version_pattern = pipeline["settings"]["version_pattern"]
    if task_label == "TIMESTAMP":
        task_label = time.strftime('%Y-%m-%d#%H.%M.%S', time.localtime())
    db2dynamic = Path(settings.PROJECT_DIR, "data", "_db2dynamic.json")
    if db2dynamic.exists():
        with Path(settings.PROJECT_DIR, "data", "_db2dynamic.json").open() as f:
            try:
                dynamic_dir = Path(settings.PROJECT_DIR, "data", json.load(f)[os.path.basename(db)])
            except KeyError:
                print(f"{db} can't find mapping in _db2dynamic.json")
    micros = {
        "$RESULTS_DIR": f"{settings.WORK_DIR}/{task_label}",
        "$DYNAMIC_DIR": f"{dynamic_dir}",
        "$TASK_NAME": task_name,
    }
    for [k, v] in micros.items():
        text = text.replace(k, v)
    pipeline = json.loads(text)
    """
    run sub tasks
    """
    if pipeline.get("sub_tasks") or pipeline.get("before") or pipeline.get("after"):
        tmp_output_dir = f"{settings.TMP_DIR}/{task_label}"
        with TempDirectoryManager(tmp_output_dir):
            cli._batch_run(run_pipeline_single, tasks, task_label, black_list_tasks, white_list_tasks, pipeline,
                           dynamic_dir, settings.CPU_PER_PROCESS, settings.MEMORY_PER_PROCESS)
    """
    build database
    """
    if "db_builders" in pipeline:
        if "settings" in pipeline and "db_uri" not in pipeline["settings"]:
            raise Exception("db_uri is required for db_builders")
        db_file = Path(micros["$RESULTS_DIR"], f"{task_name}.db")
        if db_file.exists():
            os.remove(db_file)
        try:
            make_db(micros["$RESULTS_DIR"], pipeline["settings"]["db_uri"], pipeline["db_builders"], version_pattern)
        except Exception as e:
            print(f"Error in making db")
            traceback.print_exc()