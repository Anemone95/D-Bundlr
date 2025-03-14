#!/usr/bin/env python3
import json
import logging
import multiprocessing
import os
import re
import shutil
import subprocess
import time
import traceback
from collections import deque
from functools import wraps
from pathlib import Path
from typing import Callable, Concatenate, ParamSpec, Protocol, Generator

import fire  # type: ignore

import JellyTask as Task
import settings
from CommandRunner import CommandRunner
from TempDirectoryManager import TempDirectoryManager
from utils import md5_string, memory_str_to_megabytes

"""
packages
    |- package_name
        |- version
            |- package.json
results
    |- timestamp
        |- package_name
            |-version
                |- callgraph.json
                |- diagnostics.json
                |- stdout.log
"""


def download(task: Task.JellyTask, package_dir: str, version_dir: str) -> bool:
    """
    Download package from npm registry or GitHub repo
    :return: success flag
    """
    os.makedirs(package_dir, exist_ok=True)

    if os.path.exists(f"{version_dir}/package.json"):
        return True

    if os.path.exists(version_dir):
        shutil.rmtree(version_dir)

    cmder = CommandRunner()
    if isinstance(task, Task.NpmTask):
        logging.info(f"Downloading {version_dir}")
        download_cmd = f"cd {package_dir} && npm pack --silent {task.package_name}@{task.version}"
        _, code = cmder.run_cmd(download_cmd)
        os.makedirs(version_dir, exist_ok=True)
        tgz = f"{task.package_name.replace('/', '-').replace('@', '')}-{task.canonical_version}.tgz"
        tar_cmd = f"cd {package_dir} && tar -zxf {tgz} -C {version_dir} --strip-components=1 && rm -rf {tgz}"
        cmder.run_cmd(tar_cmd)
    elif isinstance(task, Task.GithubTask):
        # https://stackoverflow.com/a/43136160/1098680
        # don't remove .git otherwise 'husky install not working'
        try:
            os.makedirs(version_dir)
            _, code = cmder.run_cmd(f"""\
    cd {version_dir} && \
    git init && \
    git config advice.detachedHead false && \
    git remote add origin https://github.com/{task.repo}.git && \
    git fetch --depth 1 origin {task.commit} && \
    git checkout FETCH_HEAD""", timeout=120)
        except subprocess.TimeoutExpired:
            code = -1
    else:
        assert False

    return code == 0


def sub_packages(task: Task) -> Generator[tuple[Path, Task.SubTask], None, None]:
    """
    :return: package.json filepath, subproject task
    """
    version_dir = task.dir
    queue = deque([version_dir])

    while queue:
        current_dir = queue.popleft()
        try:
            if current_dir.exists():
                if isinstance(task, Task.GithubTask) or isinstance(task, Task.NpmTask):
                    for item in current_dir.iterdir():
                        if item.is_dir() and item.name != 'node_modules':
                            queue.append(item)
                        elif item.is_file() and item.name == 'package.json':
                            with item.open() as f:
                                try:
                                    package_json_content = json.load(f)
                                except json.decoder.JSONDecodeError:
                                    logging.error(f"JSONDecodeError, {f}")
                                    continue
                                if "name" in package_json_content:
                                    name = package_json_content['name']
                                    if "version" in package_json_content:
                                        version = package_json_content['version']
                                    else:
                                        version = "null"
                                else:
                                    name = md5_string(item.read_text())[:20]
                                    version = "null"

                                if item.parent == version_dir:
                                    version = version+"#root"
                            if name and version:
                                sub_task = Task.SubTask(task, name, version, item.parent)
                                yield [item, sub_task]
                elif isinstance(task, Task.UrlTask):
                    for item in current_dir.iterdir():
                        yield [item, Task.SubTask(task, item.name, "", str(item))]
                else:
                    return []

        except PermissionError:
            continue


def sub_package_version(package_version: str, name: str, version: str):
    return f"{package_version}#{name.replace('/', '@@')}#{version.replace('/', '@@')}"
def install(task: Task.GithubTask|Task.NpmTask, task_label: str,  version_dir: str) -> bool:
    """
    Install dependencies for the package.
    :return: success flag
    """
    log_file = f"{version_dir}/.jelly-benchmark-install.log"
    def npm_install(t: Task.JellyTask, target_dir: str) -> tuple[str, str, int]:
        if not settings.RUNNING_IN_DOCKER:
            stdout, code = CommandRunner().run_and_log("npm install --quiet --force --ignore-scripts", log_file,
                                                       timeout=DEPENDENCE_TIMEOUT, cwd=target_dir,
                                                       env={"COREPACK_ENABLE_NETWORK": "1", "CI": "true"})
            return "npm install --quiet --force", stdout, code
        else:
            return docker_run(t, task_label, target_dir, "-w /package --entrypoint /bin/sh jelly -c 'npm install --quiet --force'", False, timeout=DEPENDENCE_TIMEOUT)

    def run_tests(t: Task.JellyTask, target_dir: str) -> tuple[str, str, int]:
        if not settings.RUNNING_IN_DOCKER:
            stdout, code = CommandRunner().run_and_log("npm --env NODE_ENV=test jelly test'", log_file, timeout=DEPENDENCE_TIMEOUT, cwd=target_dir)
            return "npm install --quiet --force", stdout, code
        else:
            return docker_run(t, task_label, target_dir, "-w /package --entrypoint /bin/sh jelly -c 'npm install --quiet --force'", False, timeout=DEPENDENCE_TIMEOUT)

    clean_node_modules = lambda target_dir: shutil.rmtree(f"{target_dir}/node_modules", ignore_errors=True)
    try:
        try:
            with open(f"{version_dir}/package.json") as f:
                package_json = json.load(f)
        except FileNotFoundError:
            # If there is no package.json file there are no dependencies to install
            return True
        except json.JSONDecodeError:
            return False
        DEPENDENCE_TIMEOUT = 60 * 20

        use_pnpm = settings.USE_PNPM
        if "workspaces" in package_json:
            # TODO: pnpm does not handle npm workspaces correctly
            # Related: https://github.com/pnpm/pnpm/issues/2255
            logging.info(f"{task.canonical_name} uses workspaces, using npm instead of pnpm")
            use_pnpm = False

        dependencies = package_json.get("dependencies", {}).keys() | package_json.get("devDependencies", {}).keys()
        # XXX: why is this check necessary?
        package_testable = False and isinstance(task, Task.GithubTask) and "test" in package_json.get("scripts", {})
        if package_testable and "jest" in dependencies:
            logging.info(f"{task.canonical_name} uses jest for tests, using npm instead of pnpm")
            use_pnpm = False

        pnpm_lockfile_path = f"{version_dir}/pnpm-lock.yaml"
        has_pnpm_lockfile = os.path.exists(pnpm_lockfile_path)
        if has_pnpm_lockfile:
            use_pnpm = True

        pnpm_workspace_path = f"{version_dir}/pnpm-workspace.yaml"
        has_pnpm_workspace = os.path.exists(pnpm_workspace_path)
        if has_pnpm_workspace:
            use_pnpm = True

        yarn_lockfile_path = f"{version_dir}/yarn.lock"
        has_yarn_lockfile = os.path.exists(yarn_lockfile_path)
        use_yarn = False
        if has_yarn_lockfile:
            use_yarn = True
        if "packageManager" in package_json:
            if "yarn" in package_json["packageManager"]:
                if not use_yarn:
                    # create a yarn.lock file
                    with open(yarn_lockfile_path, "w") as f:
                        f.write("")
                use_yarn = True

        tasks = [[version_dir, task]] if use_yarn else sub_packages(task)
        overall_code = 0
        for _, sub_task in tasks:
            target_dir = sub_task.dir
            # If the sub packages are already installed, we can skip this step
            if os.path.exists(f"{target_dir}/node_modules"):
                continue

            if use_pnpm:
                # Check whether tests run successfully when dependencies are installed with npm
                tests_work_with_npm = False
                if package_testable:
                    tests_work_with_npm = npm_install(sub_task, target_dir)[2] == 0 and run_tests(sub_task, target_dir) == 0
                    clean_node_modules(target_dir)

                if not has_pnpm_lockfile:
                    # Import lockfile to pnpm format
                    CommandRunner().run_cmd(f"cd {target_dir} && pnpm import --silent", timeout=DEPENDENCE_TIMEOUT)

                # TODO: Figure out if --force is necessary
                # It seems to imply more things in pnpm than it does in npm
                try:
                    stdout, code = CommandRunner().run_and_log(
                        (
                            f"cd {target_dir} && "
                            "pnpm install --silent --ignore-scripts"
                            # Needed to match IGNORED_COMMANDS in dynamic analysis
                            " --config.prefer-symlinked-executables=true"
                            # Better compatibility with npm
                            " --config.node-linker=hoisted"
                            " --config.resolution-mode=highest"
                        ), log_file, timeout=DEPENDENCE_TIMEOUT
                    )
                except subprocess.TimeoutExpired:
                    code = -1
                finally:
                    if not has_pnpm_lockfile:
                        # Don't leave unexpected files in the package directory
                        try: os.remove(pnpm_lockfile_path)
                        except FileNotFoundError: pass

                # Sometimes projects just do not work with pnpm, even though installation succeeds.
                # We try to detect this by running the tests (for GitHub tasks).
                if code == 0 and tests_work_with_npm and (code := run_tests(target_dir)) != 0:
                    logging.warning(f"{sub_task.canonical_name}'s tests fail with pnpm, using npm instead")
                    clean_node_modules(target_dir)
            else:
                code = -1  # satisfy static type checkers (instead of 'not use_pnpm or code != 0' below)
            if use_yarn:
                try:
                    stdout, code = CommandRunner().run_and_log(f"cd {target_dir} "
                                                               "&& corepack enable "
                                                               "&& yarn config set nodeLinker node-modules"
                                                               "&& yarn install",
                                                           log_file, timeout=DEPENDENCE_TIMEOUT)
                except subprocess.TimeoutExpired:
                    code = -1
                finally:
                    if not has_yarn_lockfile:
                        # Don't leave unexpected files in the package directory
                        try: os.remove(yarn_lockfile_path)
                        except FileNotFoundError: pass

            if code != 0:
                # pnpm fails in some cases where npm works, so we try npm
                docker_command, stdout, code = npm_install(sub_task, target_dir)
            if code != 0:
                logging.warning(f"npm install failed, skipping {sub_task.canonical_name}-{sub_task.canonical_version}\ncommand: {docker_command}\nexception: {stdout}")
                clean_node_modules(target_dir)
                overall_code = code
    except Exception as e:
        error_info = traceback.format_exc()
        logging.error(f"Error installing dependencies for {task.canonical_name}-{task.canonical_version}: {e}\n{error_info}")
        with open(log_file, "a") as file:
            file.write(f"Error installing dependencies for {task.canonical_name}-{task.canonical_version}: {e}\n")
            file.write(error_info)
    finally:
        shutil.rmtree(f"{settings.SCRIPT_DIR}/.git/hooks", ignore_errors=True)

    return overall_code == 0


P = ParamSpec("P")


class WithSourceCallable(Protocol[P]):
    def __call__(
        self,
        task: Task.JellyTask,
        task_label: str,
        rerun=False,
        *args: P.args,
        **kwargs: P.kwargs,
    ) -> None:
        ...


def requires_source(
    process: Callable[Concatenate[Task.JellyTask, str, str, str, str, P], None],
) -> WithSourceCallable[P]:
    """
    requires_source wraps the provided function with a wrapper that downloads the
    task to the packages directory, installs its dependencies and calls the
    wrapped function with appropriate paths.
    :param task: a package specification
    :param task_label: task label
    :param rerun: rerun even if this task is done before
    :return:
    """

    @wraps(process)
    def wrapper(
        task: Task.JellyTask,
        task_label: str,
        rerun=False,
        finish_file: str = ".finished",
        *args: P.args,
        **kwargs: P.kwargs,
    ):
        if not (isinstance(task, Task.GithubTask) or (isinstance(task, Task.NpmTask)) and not isinstance(task, Task.ModuleTask)):
            logging.info(f"Doesn't support {type(task)}:{task.canonical_name}-{task.canonical_version}")
            return
        parent_task_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"
        os.makedirs(parent_task_dir, exist_ok=True)
        parent_finish_file = f"{parent_task_dir}/{finish_file}_all"
        if os.path.exists(parent_finish_file) and not rerun:
            return

        package_dir = f"{settings.PACKAGES_DIR}/{task.canonical_name}"
        version_dir = f"{package_dir}/{task.canonical_version}"

        # Step1, download package
        if settings.INSTALL_DEPENDENCE and (isinstance(task, Task.GithubTask) or isinstance(task, Task.NpmTask)):
            if not download(task, package_dir, version_dir):
                logging.warning(
                    f"Download unsuccessful, skipping {task.canonical_name}-{task.canonical_version}"
                )
                return

            # Step2, npm install
            if not os.path.exists(f"{version_dir}/node_modules"):
                logging.info(f"Npm install {version_dir}")
                if not install(task, task_label, version_dir):
                    return

        # Step3, run process
        for _, sub_package in sub_packages(task):
            output_dir = f"{settings.WORK_DIR}/{task_label}/{sub_package.canonical_name}/{sub_package.canonical_version}"
            sub_finish_file = f"{output_dir}/{finish_file}"
            if os.path.exists(sub_finish_file) and not rerun:
                continue
            try:
                os.makedirs(output_dir, exist_ok=True)
                process(sub_package, task_label, sub_package.dir, output_dir, *args, **kwargs)
            finally:
                with open(sub_finish_file, "w+") as f:
                    f.write("FIN")
                logging.info(f"Output written to {output_dir}")

        with open(parent_finish_file, "w+") as f:
            f.write("FIN")

    return wrapper


def docker_run(
        task: Task.JellyTask,
        task_label: str,
        target_dir: str,
        args: str,
        silent: bool = False,
        cpus: int = None,
        memory: str = None,
        timeout: int = None,
) -> tuple[str, str, int]:
    """
    Helper function for running things inside a docker container.
    * The provided package is mounted at /package
    * The container has no network access
    * If a timeout occurs (40 minutes) the container will be stopped and cleaned up
    """
    if not cpus:
        cpus = settings.CPU_PER_PROCESS
    if not memory:
        memory = settings.MEMORY_PER_PROCESS
    if not timeout:
        timeout = settings.TIMEOUT
    # Determine if docker is running in rootless mode
    # (in which case the --user parameter should be left out)
    docker_rootless = (
        "name=rootless"
        in subprocess.run(
            ["docker", "info", "--format", '{{join .SecurityOptions "\\n"}}'],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    )

    docker_name = re.sub(
        # replace illegal characters with _
        r"[^a-zA-Z0-9_.-]",
        "_",
        f"jelly-{task_label}-{task.canonical_name}-{task.canonical_version}" \
        .replace('#', '--') \
        .replace('@', '') \
        .replace('!', ''),
    )
    docker_cmd = f"""\
docker run \
--cpus={cpus} \
--memory={memory} \
--rm --ulimit core=0 \
--name {docker_name} \
-v '{target_dir}':/package \
{"--user $(id -u):$(id -g) -e HOME=/tmp" if not docker_rootless else ""} \
{args}\
"""
    docker_runner = CommandRunner(silent=silent)
    try:
        _, code = docker_runner.run_cmd(docker_cmd, timeout=timeout)
    except BaseException as e:
        # Stop the container if it still exists.
        # (If it exists it must be running, as we started the container with --rm)
        running = (
            subprocess.run(
                ["docker", "container", "inspect", docker_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        )
        if running:
            rm_docker = f"docker stop {docker_name} > /dev/null 2>&1 && docker rm -f {docker_name} > /dev/null 2>&1 || true"
            docker_runner.run_cmd(rm_docker)

        if not isinstance(e, subprocess.TimeoutExpired):
            # Re-raise non-timeout exceptions
            raise

        code = -1

    return docker_cmd, "\n".join(docker_runner.output), code


@requires_source
def jelly_run(task: Task.JellyTask, task_label: str, black_list_tasks: list[Task.JellyTask],
              white_list_tasks: list[Task.JellyTask] | None,
              target_dir: str, output_dir: str, jelly_args: str,
              old_dir: Path | None = None, log_file: str = "stdout.log",
              cpus: int = None,
              memory: str = None,
              timeout: int = None,
              run_in_docker: bool = True,
              **kwargs):
    if task in black_list_tasks:
        return
    if white_list_tasks and task not in white_list_tasks:
        return
    jelly_run2(task, task_label, target_dir, output_dir, jelly_args, old_dir, log_file, cpus, memory, timeout,
               run_in_docker, **kwargs)


def jelly_run2(task: Task.JellyTask, task_label: str, target_dir: str, output_dir: str, jelly_args: str,
               old_dir: Path | None = None, log_file: str = "stdout.log",
               cpus: int = None,
               memory: str = None,
               timeout: int = None,
               run_in_docker: bool = True,
               jelly_path: str = None,
               **kwargs):
    """
    run jelly on one package
    :param task: a package description
    :param task_label: task label
    :param target_dir: path to downloaded package
    :param output_dir: the desired output directory
    :param jelly_args: jelly args
    :param old_dir: directory containing results of a previous cli run
    :param log_file: log file name for this run
    :param cpus: max cpu cores
    :param memory: max memory
    :return:
    """
    if not cpus:
        cpus = settings.CPU_PER_PROCESS
    if not memory:
        memory = settings.MEMORY_PER_PROCESS
    if not timeout:
        timeout = settings.TIMEOUT
    logging.info(f"Run jelly on {task.canonical_name}-{task.canonical_version}")

    if old_dir:
        old_dir = old_dir / task.canonical_name / task.canonical_version
    old_arg = "" if old_dir is None else f"-v '{old_dir}':/old"

    os.makedirs(output_dir, exist_ok=True)
    exception = None
    if run_in_docker and settings.RUNNING_IN_DOCKER:
        docker_cmd = f"-v '{output_dir}':/workspace -w /workspace {old_arg}"
        if "--npm-test" in jelly_args:
            docker_cmd = f"{docker_cmd} jelly -i {int(timeout*0.98)} {jelly_args} /package"
        else:
            docker_cmd = f"{docker_cmd} jelly /package -i {int(timeout*0.98)} {jelly_args}"
        cmd, output, _ = docker_run(task, task_label, target_dir, docker_cmd, False, cpus, memory, timeout)
        print(f"Output to {log_file}: {cmd}")
    else:
        memory = memory_str_to_megabytes(memory)
        if not jelly_path:
            jelly_path=settings.JELLY_PATH
        if not jelly_path:
            raise FileNotFoundError("jelly executable not found in $PATH")

        if "--npm-test" in jelly_args:
            cmd = f"{'node '+jelly_path if jelly_path else 'jelly'} -i {int(timeout)} {jelly_args.replace('/old', f'{old_dir}')} {target_dir}"
        else:
            cmd = f"{'node '+jelly_path if jelly_path else 'jelly'} {target_dir} -i {int(timeout)} {jelly_args.replace('/old', f'{old_dir}')}"
        cmder = CommandRunner()
        cmder.run_and_log(cmd, log_file_path=str(Path(output_dir) / log_file), timeout=timeout + 100,
                                    env={"NODE_OPTIONS": f"--max-old-space-size={memory}"},
                                    cwd=output_dir)


def read_db(db: str) -> list[Task.JellyTask]:
    with open(db, "r") as f:
        _dict = json.load(f)
    ret: list[Task.JellyTask] = []
    for each in _dict:
        if each["type"] == "git":
            ret.append(Task.GithubTask(each["repo"], each["commitId"]))
        elif each["type"] == "npm":
            ret.append(Task.NpmTask(each["name"], each["version"]))
        elif each["type"] == "module":
            ret.append(Task.ModuleTask(each["name"]))
        elif each["type"] == "url":
            ret.append(Task.UrlTask(each["url"]))
        elif each["type"] == "subtask":
            task = each['task']
            gt = Task.GithubTask(task["repo"], task["commitId"])
            ret.append(Task.SubTask(gt, each["subName"], each["subVersion"]))
        elif each["type"] == "local":
            ret.append(Task.LocalTask(each["dir"]))
        else:
            assert False
    return ret


class Cli:

    # Allow parallelism to be controlled at command line
    def __init__(self, processes: int = settings.PROCESSES, cpus: int = settings.CPU_PER_PROCESS,
                 memory: int = settings.MEMORY_PER_PROCESS):
        """
        :param processes: Maximum number of processes to run in parallel.
            0 means the number of cores, -1 means no parallelism.
        """
        self.processes = processes
        print(f"Using {self.processes} processes")
        settings.CPU_PER_PROCESS = cpus
        settings.MEMORY_PER_PROCESS = memory

    def set_parallel(self, processes):
        self.processes = multiprocessing.cpu_count() if processes == 0 else processes
        print(f"scheduling {self.processes} processes")


    def _batch_run(
        self,
        f: Callable[Concatenate[Task.JellyTask, str, P], None],
        db: str | list[Task.JellyTask],
        task_label: str,
        black_list_tasks: list[Task.JellyTask],
        white_list_tasks: list[Task.JellyTask]|None,
        *args: P.args,
        **kwargs: P.kwargs,
    ):
        """
        run the provided function on all the tasks in db
        if self.processes is not -1, the tasks will be run in parallel with multiprocessing
        """
        if task_label == "TIMESTAMP":
            task_label = time.strftime("%Y-%m-%d#%H.%M.%S", time.localtime())
        tasks: list[Task.JellyTask] = read_db(db) if isinstance(db, str) else db

        if self.processes != -1 and self.processes != 1:
            with multiprocessing.Pool(processes=self.processes) as pool:
                for future in [
                    pool.apply_async(f, (task, task_label, black_list_tasks, white_list_tasks, *args), kwargs)
                    for task in tasks
                ]:
                    future.get()  # propagate exceptions

                pool.close()
                pool.join()
        else:
            for task in tasks:
                f(task, task_label, black_list_tasks, white_list_tasks, *args, **kwargs)

    @staticmethod
    def _check_docker():
        assert (
            subprocess.run(
                ["docker", "image", "inspect", "jelly"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        ), "Docker is not running or the 'jelly' image is missing."

    def jelly(
        self,
        db: str,
        task_label: str = "TIMESTAMP",
        jelly_args: str = "--warnings-unsupported --callgraph-json callgraph.json --diagnostics-json diagnostics.json",
        old_dir: str | None = None,
    ):
        """
        run jelly on all packages
        :param db: database.json file path
        :param task_label: unique label for this group of tasks
        :param jelly_args: arguments for jelly
        :param old_dir: directory containing results from a previous cli run
        the directory <old_dir>/<task.name>/<task.version> will be mounted at /old in the docker container
        """
        self._check_docker()

        tasks = read_db(db)

        if old_dir is None:
            old_dir_path = None
        else:
            old_dir_path = Path(old_dir).resolve(strict=True)

            for task in tasks:
                assert (
                        old_dir_path / task.canonical_name / task.canonical_version
                ).is_dir(), f"Old results directory is missing for {task}"

        tmp_output_dir = f"{settings.TMP_DIR}/{task_label}"
        with TempDirectoryManager(tmp_output_dir):
            self._batch_run(jelly_run, tasks, task_label, [], jelly_args=jelly_args, old_dir=old_dir_path)

    def pipeline(self, db: str, task_label: str = "TIMESTAMP",
                 script: str = "simple",
                 black_list: str | None = None, white_list: str | None = None):
        """
        run with pipeline script
        :param db: database.json file path
        :param task_label: unique label for this group of tasks
        :param script: script
        """
        from pipeline import run_pipeline
        run_pipeline(self, db, task_label, script, black_list, white_list)

    def statics_benchmark(self, db: str):
        succeed_cases=[]
        failed_cases=[]
        failed_reasons={}
        with open(f"{db}/github.json", "r") as f:
            succeed_cases = json.load(f)
        with open(f"{db}/github-excluded.json", "r") as f:
            failed_cases = json.load(f)
        for each in failed_cases:
            num = failed_reasons.get(each["reason"], 0)
            failed_reasons[each["reason"]]=num+1
        print(f"Total: {len(succeed_cases)}/{len(succeed_cases)+len(failed_cases)}")
        for [k, v] in failed_reasons.items():
            print(f"{k}: {v}")

    @staticmethod
    @requires_source
    def _graal_test_run(task: Task.JellyTask, task_label: str, version_dir: str, output_dir: str):
        """run 'npm test' with the GraalVM node interpreter and record results"""

        logging.info(f"Run Graal test on {task.canonical_name}-{task.canonical_version}")
        # TODO: Use --cpus docker flag to prevent to make cpu distribution more fair
        _, output, code = docker_run(
            task, task_label, version_dir,
            f"""\
-w /package --entrypoint bash jelly -c '\
cat <<END > /tmp/patch_jest.js
const argv = require("process").argv, f = argv[1] || "";
if(f.endsWith("/node_modules/.bin/jest") || f.endsWith("/node_modules/jest/bin/jest.js"))
    argv.splice(2, 0, "--runInBand");
END
env NODE_ENV=test NODE_OPTIONS="$NODE_OPTIONS --require /tmp/patch_jest" PATH="$GRAAL_HOME/bin:$PATH" npm test'\
""")

        (Path(output_dir) / "stdout.log").write_text(output)
        (Path(output_dir) / "exitcode").write_text(str(code))

    def graal_test(self, db: str, task_label: str = "TIMESTAMP"):
        """
        run 'npm test' with the GraalVM node interpreter on all packages
        :param db: database.json file path
        :param task_label: unique label for this group of tasks
        """
        self._check_docker()

        self._batch_run(self._graal_test_run, db, task_label)

    @staticmethod
    @requires_source
    def _prepare(*args):
        pass  # TODO: Make this unnecessary...

    def prepare(self, db: str | list[Task.JellyTask], task_label="TIMESTAMP", reinstall=False):
        """
        download tasks in DB and install their dependencies
        :param db: database.json file path
        :param task_label: unique label for this group of tasks
        :param reinstall: if true, removes old versions of packages before re-downloading them
        """
        if reinstall:
            if isinstance(db, str):
                db = read_db(db)
            for task in db:
                logging.info(f"Removing {task}")
                version_dir = f"{settings.PACKAGES_DIR}/{task.canonical_name}/{task.canonical_version}"
                shutil.rmtree(version_dir, ignore_errors=True)

        self._batch_run(self._prepare, db, task_label, [])

    @staticmethod
    def _compare_callgraphs_run(
            task: Task.JellyTask,
            task_label: str,
            dynamic_dir: Path,
            callgraph_json="callgraph.json",
            output_txt: str = "comparison.txt",
            log_file: str = "comparison.log",
    ):
        output_dir = f"{settings.WORK_DIR}/{task_label}/{task.canonical_name}/{task.canonical_version}"
        dynamic_callgraph = (
            dynamic_dir
            / task.canonical_name
            / task.canonical_version
            / "dynamic_callgraph.json"
        )

        if (not dynamic_callgraph.exists()) and isinstance(task, Task.SubTask):
            dynamic_callgraph = (
                    dynamic_dir
                    / task.task.canonical_name
                    / task.task.canonical_version
                    / "dynamic_callgraph.json"
            )

        static_callgraph = Path(output_dir) / callgraph_json
        if not static_callgraph.exists():
            loggg = f"Skipping {task.canonical_name}-{task.canonical_version} as the static call graph is missing"
            logging.info(loggg)
            with open(f"{output_dir}/{log_file}", "w+") as f:
                f.write(loggg)
            return

        if not dynamic_callgraph.exists():
            loggg = f"Skipping {task.canonical_name}-{task.canonical_version} as the dynamic call graph is missing"
            logging.info(loggg)
            with open(f"{output_dir}/{log_file}", "w+") as f:
                f.write(loggg)
            return

        runner = CommandRunner(output_size=20, silent=True)
        if settings.RUNNING_IN_DOCKER:
            output, code = runner.run_cmd(
                f"""\
    docker run --rm -w /workspace \
    -v '{dynamic_callgraph.absolute()}':/workspace/actual.json \
    -v '{static_callgraph}':/workspace/predicted.json \
    jelly --compare-callgraphs --reachability actual.json predicted.json\
    """)
        else:
            memory = memory_str_to_megabytes(settings.MEMORY_PER_PROCESS)
            path_dirs = os.environ['PATH'].split(os.pathsep)
            for directory in path_dirs:
                file_path = os.path.join(directory, "jelly")
                if os.path.exists(file_path):
                    jelly_path = file_path
                    break
            if not jelly_path:
                raise FileNotFoundError("jelly executable not found in $PATH")
            cmd = f"{'node '+jelly_path if jelly_path else 'jelly'} --compare-callgraphs --reachability '{dynamic_callgraph.absolute()}' '{static_callgraph}'"
            output, code = runner.run_cmd(cmd,
                                        env={"NODE_OPTIONS": f"--max-old-space-size={memory}"},
                                        cwd=output_dir)
        if code != 0:
            with open(f"{output_dir}/{log_file}", "w+") as f:
                f.write("\n".join(runner.output))
        else:
            logging.info(f"Call graph comparison:\n{output}")
            (Path(output_dir) / output_txt).write_text("\n".join(output.split("\n")[-7:]))

    def compare_callgraphs(self, db: str, dynamic_dir: str, task_label: str = "TIMESTAMP"):
        if settings.RUNNING_IN_DOCKER:
            self._check_docker()

        _dynamic_dir = Path(dynamic_dir)
        assert _dynamic_dir.is_dir(), f"'{_dynamic_dir}' is not a directory"

        tasks = []
        for task in read_db(db):
            dynamic_callgraph = (
                _dynamic_dir
                / task.canonical_name
                / task.canonical_version
                / "dynamic_callgraph.json"
            )
            try:
                with dynamic_callgraph.open() as f:
                    if json.load(f)["functions"]:
                        tasks.append(task)
                    else:
                        logging.warning(f"Skipping {task.canonical_name}-{task.canonical_version} as dynamic call graph is empty")

            except FileNotFoundError:
                logging.info(f"Skipping {task.canonical_name}-{task.canonical_version} as dynamic call graph is missing")


        assert tasks, f"'{_dynamic_dir}' does not contain any valid call graphs (dynamic_callgraph.json)"

        logging.info(f"Performing call graph comparison for {len(tasks)} projects")

        self._batch_run(
            self._compare_callgraphs_run,
            tasks,
            task_label,
            dynamic_dir=_dynamic_dir,
        )

        shutil.rmtree(f"{settings.TMP_DIR}/{task_label}", ignore_errors=True)


if __name__ == "__main__":
    logging.basicConfig(
        format="%(asctime)s : %(levelname)s : %(filename)s : %(funcName)s : %(message)s",
        level=logging.DEBUG,
    )
    fire.core.Display = lambda lines, out: print(*lines, file=out)
    fire.Fire(Cli)
