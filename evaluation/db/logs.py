import re
from pathlib import Path
from typing import Type

from sqlalchemy import Column, Integer, ForeignKey, String, Text
from db import TableBuilder, BASE

error_pattern = re.compile(r'Error.*', re.MULTILINE)
warning_pattern = re.compile(r'Warning.*', re.MULTILINE)
debug_pattern = re.compile(r'DEBUG:.*', re.MULTILINE)


class LogTemplate:
    id = Column(Integer, primary_key=True, autoincrement=True)
    level = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)


class LogBuilder(TableBuilder):

    def _get_model(self) -> Type[BASE]:
        attrs: dict[str, str | Column] = {"__tablename__": self.table_name}
        for key, value in self.foreign_keys.items():
            attrs[key] = Column(Integer, ForeignKey(value), nullable=False)
        return type(self.table_name, (LogTemplate, BASE), attrs)

    def new_object(self, file_path: str, env: dict[str, BASE | list[BASE]]) -> list[BASE] | BASE | None:
        path = Path(file_path)
        if path.is_file():
            log_text = path.read_text()
            log_records = []
            for pat, level in ((error_pattern, "ERROR"), (warning_pattern, "WARNING"), (debug_pattern, "VARSET")):
                for line in set(pat.findall(log_text)):
                    records = {"level": level, "message": line}
                    records.update(self.build_foreign_keys(env))
                    log_records.append(self.get_model()(**records))
            return log_records
        return None
