import json
import os
from pathlib import Path
from typing import Type, Callable

from sqlalchemy import Column, Integer, String, Float, Boolean, Sequence, ForeignKey

from db import TableBuilder, PY_TYPE, BASE, DB_CLASS, to_sql_name


def flatten_dict(d: dict[str, dict | str | int | float | bool], parent_key='', sep='_'):
    """
    Flatten a nested dictionary.

    :param d: The nested dictionary to flatten.
    :param parent_key: The base key for the nested items (used for recursion).
    :param sep: Separator between nested keys.
    :return: A flattened dictionary.
    """
    items = []
    for k, v in d.items():
        new_key = f"{parent_key}{sep}{k}" if parent_key else k
        if isinstance(v, dict):
            items.extend(flatten_dict(v, new_key, sep=sep).items())
        else:
            items.append((new_key, v))
    return dict(items)

class JsonObjectBuilder(TableBuilder):
    TYPE_MAP = {str: String(255), int: Integer, float: Float, bool: Boolean}

    def __init__(self, json_name: str, work_dir: str, foreign_keys: dict[str, str],
                 extra_columns: dict[str, list[Column, Callable[[dict[str, PY_TYPE], str], dict[str, PY_TYPE]]]]):
        """
        Extract ORM class from json file
        :param json_name: a filename in each task directory like diagnostics.json
        :param work_dir: a directory like /home/jelly/results/2020-08-01#00.00.00
        :param extra_columns: extra fields to add to the table, format like {"column_name": column_type}
        :return: an ORM class, which is also putted in OBJECTS_IN_TABLES[table_name]
        """
        super().__init__(json_name, foreign_keys, to_sql_name(os.path.splitext(json_name)[0]), work_dir)
        self.work_dir = work_dir
        self.extra_columns: dict[str, DB_CLASS] = {}
        self.extra_value_producer: dict[str, Callable[[dict[str, PY_TYPE], str], dict[str, PY_TYPE]]] = {}
        for [k, v] in extra_columns.items():
            self.extra_columns[k] = v[0]
            self.extra_value_producer[k] = v[1]

    def _get_model(self) -> Type[BASE]:
        return self._extract_class_from_json()

    def new_object(self, file_path: str, env: [str, BASE | list[BASE]]) -> BASE:
        record = {}
        record.update(self.build_foreign_keys(env))
        if os.path.exists(file_path):
            with open(file_path) as f:
                for [k, v] in flatten_dict(json.load(f)).items():
                    record[to_sql_name(k)] = v
        for [key, producer] in self.extra_value_producer.items():
            record[key] = producer(record, file_path)
        clazz = self.model(**record)
        return clazz

    def _extract_class_from_json(self) -> Type[BASE]:
        object_name = self.table_name
        json_example = None
        # First find a json example to generate the structure of the table
        for package_name in os.listdir(self.work_dir):
            package_dir = os.path.join(self.work_dir, package_name)
            if not os.path.isdir(package_dir):
                continue
            # for web task
            json_file_path = os.path.join(self.work_dir, package_name, self.file)
            if os.path.exists(json_file_path):
                json_example = json_file_path
                break
            for package_version in os.listdir(package_dir):
                json_file_path = os.path.join(self.work_dir, package_name, package_version, self.file)
                if os.path.exists(json_file_path):
                    json_example = json_file_path
                    break
            if json_example:
                break
        # Build the class dynamically
        attrs = {
            "__tablename__": to_sql_name(object_name),
            "id": Column(Integer, Sequence(f"{object_name}_id_seq"), primary_key=True),
        }
        for [k, v] in self.foreign_keys.items():
            attrs[k] = Column(Integer, ForeignKey(v), nullable=False)
        if not json_example:
            raise Exception(f"Can't find example '{self.file}' in {self.work_dir} to build diagnostic table")

        with open(json_example) as json_example:
            json_dict = flatten_dict(json.load(json_example))
        for attr_name, attr_value in json_dict.items():
            attr_type = type(attr_value)
            if attr_type in JsonObjectBuilder.TYPE_MAP:
                attrs[to_sql_name(attr_name)] = Column(JsonObjectBuilder.TYPE_MAP[attr_type], nullable=True)
            else:
                raise Exception(f"Unknown type {attr_type} for {attr_name}:{attr_value} in {json_example}")
        for [k, v] in self.extra_columns.items():
            attrs[k] = v
        new_class = type(to_sql_name(object_name), (BASE,), attrs)
        return new_class


class JsonBuilder(JsonObjectBuilder):
    def __init__(self, json_file: str, work_dir: str):
        super().__init__(json_file,
                         work_dir,
                         {"package_id": "package.id"}, {})

class DiagnosticsBuilder(JsonObjectBuilder):

    def __init__(self, diagnostic_file: str, work_dir: str):
        super().__init__(diagnostic_file,
                         work_dir,
                         {"package_id": "package.id"},
                         {"success": [Column(Boolean), DiagnosticsBuilder.is_success],
                          "error": [Column(String(255)), DiagnosticsBuilder.diag_reason]})

    @staticmethod
    def is_success(records: dict[str, PY_TYPE], file_path: str) -> bool:
        success = True
        if os.path.exists(file_path):
            if records.get("aborted", False) or records.get("timeout", False):
                success = False
        else:
            success = False
        return success

    @staticmethod
    def diag_reason(records: dict[str, PY_TYPE], file_path: str) -> str:
        error = None
        if os.path.exists(file_path):
            diag = records
            if diag.get("aborted", False):
                error = "OOM"
            elif diag.get("timeout", False):
                error = "TLE"
        else:
            stdout_log = Path(file_path.replace("diagnostics", "stdout").replace(".json", ".log"))
            log_text = "" if not stdout_log.is_file() else stdout_log.read_text()
            if "young object promotion failed Allocation failed" in log_text:
                error = "SEMI_OOM"
            elif "Time limit reached" in log_text:
                error = "TLE"
            elif "JavaScript heap out of memory" in log_text:
                error = "OOM"
            elif "OOMErrorHandler" in log_text:
                error = "OOM"
            elif "Fatal JavaScript invalid size error" in log_text:
                error = "OOM"
            elif "Segmentation fault" in log_text:
                error = "SEGMENTATION_FAULT"
            elif "called after throwing an instance of 'std::bad_alloc" in log_text:
                error = "BAD_ALLOC"
            elif "Maximum call stack size exceeded" in log_text:
                error = "RE-StackOverflow"
            elif "JavaScript invalid size error" in log_text:
                error = "RE-InvalidSize"
            elif "Unexpected module" in log_text:
                error = "RE-UnexpectedModule"
            elif "code: 'MODULE_NOT_FOUND'" in log_text:
                error = "MODULE_NOT_FOUND"
            elif log_text.endswith("Killed"):
                error = "Killed"
            elif "TypeError: Cannot read properties of undefined (reading 'reset')" in log_text:
                error = "TypeError: Cannot read properties of undefined (reading 'reset')"
            elif "Map maximum size exceeded" in log_text:
                error = "MapMaximumSizeExceeded"
            elif "AssertionError [ERR_ASSERTION]: FunctionExpression " in log_text:
                error = "AssertionError [ERR_ASSERTION]: FunctionExpression at x has no FunctionInfo"
            elif "AssertionError [ERR_ASSERTION]: ArrowFunctionExpression at" in log_text:
                error = "AssertionError [ERR_ASSERTION]: ArrowFunctionExpression at x has no FunctionInfo"
            elif "RangeError: Invalid array length" in log_text:
                error = "InvalidArrayLength"
            elif "RangeError [ERR_OUT_OF_RANGE]" in log_text:
                error = "ERR_OUT_OF_RANGE(SerializeSize)"
            else:
                error = "Unknown"
        return error
