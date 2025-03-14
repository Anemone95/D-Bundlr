from pathlib import Path
from urllib.parse import urlparse

import settings
from utils import md5_string


class JellyTask:
    @property
    def canonical_name(self) -> str:
        raise NotImplementedError

    @property
    def canonical_version(self) -> str:
        raise NotImplementedError

    def __str__(self) -> str:
        return f"{type(self).__name__}: {self.canonical_name}/{self.canonical_version}"

    def __eq__(self, other):
        if isinstance(other, JellyTask):
            return self.canonical_name == other.canonical_name and self.canonical_version == other.canonical_version
        return False

    def __hash__(self):
        return hash((self.canonical_name, self.canonical_version))

    def to_dict(self):
        raise NotImplementedError

    @property
    def dir(self) -> Path:
        raise NotImplementedError


class GithubTask(JellyTask):
    def __init__(self, repo: str, commit: str):
        super().__init__()
        self.repo = repo
        self.commit = commit

    @property
    def canonical_name(self) -> str:
        # TODO: remove "if" when all packages are transformed into new format
        return self.repo.replace("/",
                                 "__") if not settings.OLD_PACKAGE_FORMAT else self.repo.replace(
            "/", "#")

    @property
    def canonical_version(self) -> str:
        return self.commit

    def to_dict(self):
        return {
            "type": "git",
            "repo": self.repo,
            "commitId": self.commit,
        }

    @property
    def dir(self) -> Path:
        return Path(settings.PACKAGES_DIR) / self.canonical_name / self.canonical_version


class NpmTask(JellyTask):
    def __init__(self, package_name: str, version: str):
        self.package_name = package_name
        self.version = version

    @property
    def canonical_name(self) -> str:
        return self.package_name.replace("/",
                                         "__") if not settings.OLD_PACKAGE_FORMAT else (
            self.package_name.replace("/", "#"))

    @property
    def canonical_version(self) -> str:
        return self.version

    def to_dict(self):
        return {
            "type": "npm",
            "name": self.package_name,
            "version": self.version,
        }

    @property
    def dir(self) -> Path:
        return Path(settings.PACKAGES_DIR) / self.canonical_name / self.canonical_version


def str_or_md5(input_string: str, number: int) -> str:
    if len(input_string) > number:
        return md5_string(input_string)[:number]
    else:
        return input_string


class SubTask(JellyTask):
    def __init__(self, task: JellyTask, sub_name: str, sub_version: str, _dir: str | None = None):
        self.task = task
        self.sub_name = sub_name
        self.sub_version = sub_version
        self._dir = _dir

    @property
    def canonical_name(self) -> str:
        return self.task.canonical_name

    @property
    def canonical_version(self) -> str:
        return f"{self.task.canonical_version}##{self.sub_name.replace('/', '#')[-35:]}##{self.sub_version.replace('/', '#')[-12:]}"

    def to_dict(self):
        return {
            "type": "subtask",
            "task": self.task.to_dict(),
            "subName": self.sub_name,
            "subVersion": self.sub_version
        }

    def __eq__(self, other: any):
        if isinstance(other, SubTask):
            return self.task == other.task and self.sub_name[-35:] == other.sub_name[-35:] and self.sub_version.replace(
                "#root", "")[-12:] == other.sub_version.replace("#root", "")[-12:]
        else:
            return False

    def __hash__(self):
        return hash((self.task, self.sub_name[-35:], self.sub_version.replace("#root", ""))[-12:])

    @property
    def dir(self) -> Path:
        return Path(self._dir)


class UrlTask(JellyTask):
    def __init__(self, url: str):
        super().__init__()
        self.url = url
        u = urlparse(url)
        self.host = u.netloc
        self.path = u.path
        self.scheme = u.scheme

    @property
    def canonical_name(self) -> str:
        return self.scheme + ":" + self.host

    @property
    def canonical_version(self) -> str:
        return self.path

    def to_dict(self):
        return {
            "type": "url",
            "url": self.url,
        }

    @property
    def dir(self) -> Path:
        return Path(settings.PACKAGES_DIR) / self.canonical_name / self.canonical_version


class LocalTask(JellyTask):
    def __init__(self, dir: str):
        super().__init__()
        self._dir = dir

    @property
    def canonical_name(self) -> str:
        return self._dir

    @property
    def canonical_version(self) -> str:
        return "0"

    def to_dict(self):
        return {
            "type": "local",
            "dir": self.dir,
        }

    @property
    def dir(self) -> Path:
        return Path(settings.PACKAGES_DIR) / self._dir

class ModuleTask(NpmTask):
    def __init__(self, package_name: str):
        self.package_name = package_name

    @property
    def canonical_name(self) -> str:
        return self.package_name.replace("/",
                                         "__") if not settings.OLD_PACKAGE_FORMAT else (
            self.package_name.replace("/", "#"))

    @property
    def canonical_version(self) -> str:
        return self.version

    def to_dict(self):
        return {
            "type": "module",
            "name": self.package_name
        }

    @property
    def dir(self) -> Path:
        return Path(settings.PACKAGES_DIR) / "node_modules" / self.package_name
