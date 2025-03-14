import multiprocessing
import os
import threading
import logging
import platform
import subprocess
import traceback
import time
from pathlib import Path

import psutil

from collections import deque

OS_LINUX = "ELF"


def kill(proc_pid):
    try:
        process = psutil.Process(proc_pid)
        for proc in process.children(recursive=True):
            proc.kill()
        process.kill()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        pass


class CommandRunner:
    """
    Run command and get output
    """
    def __init__(self, output_size: int = 5000, silent: bool = False):
        self.output: deque[str] = deque(maxlen=output_size)
        self.silent = silent
        self.lastline = ''

    def log(self, log_line):
        logging.info(log_line)

    def callback(self):
        return "\n".join(self.output)

    def run_cmd(self, cmd: str, timeout: float | None = None, env: dict[str, str] | None = None,
                cwd: str | None = None) -> tuple[str, int]:
        logging.info("Running cmd: \"{}\"".format(cmd))
        kargs = {"shell": True, "bufsize": 1024, "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
                 "stdin": subprocess.DEVNULL}
        if env:
            _env = os.environ.copy()
            _env.update(env)
            kargs["env"] = _env
        if cwd:
            kargs["cwd"] = cwd
        process = subprocess.Popen(cmd, **kargs)
        log_thread = threading.Thread(target=self.print_log, args=(process.stdout,))
        log_thread.daemon = True
        log_thread.start()

        try:
            process.wait(timeout=timeout)
        except BaseException:
            # If the call to wait does not complete normally (for instance due
            # to a KeyboardInterrupt or a timeout), try to clean up the process
            # with kill.
            kill(process.pid)
            raise
        finally:
            log_thread.join(timeout=5)

        return self.callback(), process.returncode

    def print_log(self, stdout):
        for log_line in self._log_line_iter(stdout):
            if not self.silent:
                self.log(log_line)
            self.output.append(log_line)

    def _log_line_iter(self, reader):
        while True:
            buf = reader.read(1024)
            if buf:
                lines = buf.decode('utf8', errors='ignore')
                lines = lines.replace('\r\n', '\n').replace('\r', '\n').split('\n')
                lines[0] = self.lastline + lines[0]
                for line in lines[:-1]:
                    if len(line) > 0:
                        yield line
                self.lastline = lines[-1]
            else:
                break

    def run_and_log(self, cmd: str, log_file_path: str, timeout: float | None = None,
                    env: dict[str, str] | None = None,
                    cwd: str | None = None) -> tuple[str, int]:
        start_time = time.time()
        try:
            log, code = self.run_cmd(cmd, timeout, env, cwd)
            return log, code
        except Exception as e:
            trace = traceback.format_exc()
            self.log(trace)
            self.output.append(trace)
            return self.callback(), -1
        finally:
            end_time = time.time()
            duration = end_time - start_time
            if not os.path.exists(log_file_path):
                os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
            with open(log_file_path, "w+") as f:
                f.write(cmd + "\n\n" + ("\n".join([f"{e}={env[e]}" for e in env]) if env else "") +"\n\n"+ "\n".join(self.output) + "\n\n" + f"Execution time: {duration} seconds")
