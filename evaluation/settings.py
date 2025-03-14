import os
from datetime import datetime
import importlib.util
from utils import is_running_in_docker

# The directory containing this file
SCRIPT_DIR = os.path.split(os.path.realpath(__file__))[0]
PROJECT_DIR = SCRIPT_DIR
# The directory containing the output of the jelly analysis
WORK_DIR = os.path.join(PROJECT_DIR, "results")
# The directory containing the target packages
PACKAGES_DIR = os.path.join(PROJECT_DIR, "dataset")
# For tmp files
TMP_DIR = os.path.join(PROJECT_DIR, "tmp")
START_TIME = datetime.now()
OLD_PACKAGE_FORMAT=False

PROCESSES = 4
CPU_PER_PROCESS = 4
MEMORY_PER_PROCESS = "30g"
TIMEOUT = 60 * 40
USE_PNPM = False
RUNNING_IN_DOCKER = False
INSTALL_DEPENDENCE = True
CODE_QL_HOME = os.getenv('CODE_QL_HOME', '/codeql-home')
MAX_SUB_PACKAGES = 987654321

JELLY_PATH = os.path.join(PROJECT_DIR, "..", "d-bundlr", "lib")

local_settings_path = 'settings-local.py'
if os.path.exists(os.path.join(SCRIPT_DIR, local_settings_path)):
    spec = importlib.util.spec_from_file_location("local_settings", local_settings_path)
    local_settings = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(local_settings)
    if hasattr(local_settings, "PROCESSES"):
        PROCESSES = local_settings.PROCESSES
    if hasattr(local_settings, "MEMORY_PER_PROCESS"):
        MEMORY_PER_PROCESS = local_settings.MEMORY_PER_PROCESS
    if hasattr(local_settings, "TIMEOUT"):
        TIMEOUT = local_settings.TIMEOUT
    if hasattr(local_settings, "JELLY_PATH"):
        JELLY_PATH = local_settings.JELLY_PATH
    if hasattr(local_settings, "RUNNING_IN_DOCKER"):
        RUNNING_IN_DOCKER = local_settings.RUNNING_IN_DOCKER
    if hasattr(local_settings, "INSTALL_DEPENDENCE"):
        INSTALL_DEPENDENCE = local_settings.INSTALL_DEPENDENCE
    if hasattr(local_settings, "PACKAGES_DIR"):
        PACKAGES_DIR = local_settings.PACKAGES_DIR
    if hasattr(local_settings, "WORK_DIR"):
        WORK_DIR = local_settings.WORK_DIR
    if hasattr(local_settings, "TMP_DIR"):
        TMP_DIR = local_settings.TMP_DIR
    if hasattr(local_settings, "CODE_QL_HOME"):
        CODE_QL_HOME = local_settings.CODE_QL_HOME
    if hasattr(local_settings, "OLD_PACKAGE_FORMAT"):
        OLD_PACKAGE_FORMAT = local_settings.OLD_PACKAGE_FORMAT
    if hasattr(local_settings, "MAX_SUB_PACKAGES"):
        MAX_SUB_PACKAGES = local_settings.MAX_SUB_PACKAGES
