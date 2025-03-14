import re
from abc import ABC, abstractmethod
from typing import Type, Union

from sqlalchemy import Column, Integer, String, Float, Boolean
from sqlalchemy.orm import declarative_base

BASE = declarative_base()
PY_TYPE = Union[int, str, float, bool, None]
DB_TYPE = Union[Type[Integer], Type[String], Type[Float], Type[Boolean]]
DB_CLASS = Union[Integer, String, Float, Boolean]


def to_sql_name(pascal_case: str) -> str:
    # transform "aaBbbCcc" to "aa_bbb_ccc
    s1 = re.sub(r"(?P<key>[A-Z])", r"_\g<key>", pascal_case)
    # transform "aa-bbb-ccc" to "aa_bbb_ccc"
    s2 = re.sub('-', '_', s1)
    snake_case = s2.lower()
    return snake_case


class Package(BASE):
    __tablename__ = 'package'

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    version = Column(String(255), nullable=False)


class TableBuilder(ABC):
    def __init__(self, _file: str, foreign_keys: dict[str, str], table_name: str, work_dir: str):
        """
        :param _file: file in each task directory like diagnostics.json
        :param foreign_keys: foreign keys to other tables, format like {"column_name": "table_name.column_name"}
        :param work_dir: a directory like /home/jelly/results/2020-08-01#00.00.00
        """
        self.file = _file
        self.work_dir = work_dir
        self.model = None
        self.table_name = table_name
        self.foreign_keys = foreign_keys

    def get_model(self):
        """
        Used for create a table and cache it
        :return: an ORM class
        """
        if self.model is None:
            self.model = self._get_model()
        return self.model

    @abstractmethod
    def _get_model(self) -> Type[BASE]:
        """
        Used for create a table
        :return: an ORM class
        """
        pass

    @abstractmethod
    def new_object(self, file_path: str, env: dict[str, BASE | list[BASE]]) -> list[BASE] | BASE | None:
        """
        Used for read ORM object from a file
        :return: a list of ORM objects or a single ORM object
        """
        pass

    def build_foreign_keys(self, env: dict[str, BASE | list[BASE]]) -> dict[str, Integer]:
        """
        Build foreign keys for a record
        """
        record = {}
        for [key, value] in self.foreign_keys.items():
            table, column = value.split(".")
            record[key] = getattr(env[table], column)
        return record
