import logging
import os
import re
import sqlite3
import sys
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, registry

import settings
from db import Package

db_file = 'sqlite.db'


def default_make_db(work_dir: str):
    db_uri = f'sqlite:///{os.path.join(work_dir, db_file)}'
    producers = [
        {
            "name": "DiagnosticsBuilder",
            "diagnostic_file": "diagnostics.json",
        },
        {
            "name": "SoundnessBuilder",
            "_file": "comparison.txt",
            "foreign_keys": {"diagnostics_id": "diagnostics.id"},
            "table_name": "soundness",
        },
        {
            "name": "LogBuilder",
            "_file": "stdout.log",
            "foreign_keys": {"diagnostics_id": "diagnostics.id"},
            "table_name": "log",
        }
    ]
    make_db(work_dir, db_uri, producers)


def make_db(work_dir: str, db_uri: str, producers: list[dict[str, str]], version_pattern: str):
    from db.diagnostics import DiagnosticsBuilder, JsonBuilder
    from db.logs import LogBuilder
    """
    Generate sqlite.db from diagnostics.json and stdout.log
    :param work_dir: a directory like /home/jelly/results/2020-08-01#00.00.00
    """
    db = create_engine(db_uri, echo=False)
    producer_map = {
        "DiagnosticsBuilder": DiagnosticsBuilder,
        "LogBuilder": LogBuilder,
        "JsonBuilder": JsonBuilder,
    }
    _producers = []
    for producer in producers:
        _args = {key: value for key, value in producer.items() if key != "name"}
        _args["work_dir"] = work_dir
        _producers.append(producer_map[producer["name"]](**_args))

    Package.__table__.create(bind=db, checkfirst=True)
    for producer in _producers:
        producer.get_model().__table__.create(bind=db, checkfirst=True)
    session = sessionmaker(bind=db)()
    registry().configure()
    for package_name in sorted(os.listdir(work_dir)):
        package_dir = os.path.join(work_dir, package_name)
        if not os.path.isdir(package_dir):
            continue
        for package_version in sorted([package_dir, *os.listdir(package_dir)]):
            env = {}
            version_dir = os.path.join(package_dir, package_version)
            if not re.match(version_pattern, package_version):
                continue
            record = {"name": package_name, "version": package_version}
            skip = os.path.join(version_dir, ".skip")
            if os.path.exists(skip):
                continue
            package = Package(**record)
            env["package"] = package
            has_record = False
            session.add(package)
            session.flush()
            for producer in _producers:
                obj = producer.new_object(os.path.join(version_dir, producer.file), env)
                if obj is None:
                    continue
                if type(obj) is list:
                    for o in obj:
                        session.add(o)
                        session.flush()
                else:
                    session.add(obj)
                    session.flush()
                env[producer.get_model().__tablename__] = obj
                has_record = True
            if not has_record:
                session.delete(package)
                session.flush()
    session.commit()


def report(work_dir, sql=f"{settings.SCRIPT_DIR}/sql/default_report.sql") -> dict[str, int]:
    if not os.path.exists(os.path.join(work_dir, db_file)):
        default_make_db(work_dir)
    ret = {}
    conn = sqlite3.connect(os.path.join(work_dir, db_file))
    cursor = conn.cursor()
    cursor.execute(Path(sql).read_text())
    res = cursor.fetchone()
    for i, col in enumerate(cursor.description):
        col_name = col[0]
        val = res[i]
        ret[col_name] = val
    conn.close()
    return ret


if __name__ == '__main__':
    logging.basicConfig(format='%(asctime)s : %(levelname)s : %(filename)s : %(funcName)s : %(message)s',
                        level=logging.DEBUG)
    path = sys.argv[1]
    print(report(path))
