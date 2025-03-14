import os
import shutil


class TempDirectoryManager:
    def __init__(self, path, need_clean=True):
        self.path = path
        self.need_clean = need_clean

    def __enter__(self):
        if os.path.exists(self.path):
            shutil.rmtree(self.path, ignore_errors=True)
        os.makedirs(self.path)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        shutil.rmtree(self.path, ignore_errors=True)
        return False
