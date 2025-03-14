import csv
from collections import defaultdict
from pathlib import Path
from bundle_project.compare_codeql import Location, TaintReport, find_file_from_lines, getTaintReport


def get_code(location:Location) -> str:
    lines = location.path.read_text().split("\n")

    start_line = location.start_line
    end_line = location.end_line
    start_column = location.start_column
    end_column = location.end_column
    if start_line < 1 or end_line > len(lines):
        raise ValueError("Start or end line is out of file bounds")

    if start_line == end_line:
        return lines[start_line - 1][max(0, start_column - 20):min(end_column+20, len(lines[start_line-1]))]
    else:
        extracted = [lines[start_line - 1][start_column - 20:]]
        extracted.extend(lines[start_line:end_line - 1])
        extracted.append(lines[end_line - 1][:end_column+20])
        return "".join(extracted)

black_list_vulns = ["Hard-coded data interpreted as code"]
def read_report(report_path: Path, base: Path) -> list[TaintReport]:
    ret: list[TaintReport] = []
    with report_path.open() as csvfile:
        vulns = csv.reader(csvfile)
        for row in vulns:
            alert = getTaintReport(row, base)
            if alert.kind in black_list_vulns:
                continue
            ret.append(getTaintReport(row, base))
    return ret

file2file = dict()

def get_corresponding_file(loc:Path, dir:Path, sample:None|int=None) -> Path | None:
    if str(loc) in file2file:
        return file2file[str(loc)]
    lines = loc.read_text().splitlines()
    source_loc = find_file_from_lines(lines, dir, sample)
    file2file[str(loc)] = source_loc
    return source_loc

class BipartiteMatcher:
    def __init__(self, edges):
        self.edges = edges
        self.left_nodes = set()
        self.right_nodes = set()
        self.match_right = {} 
        self.match_left = {}
        self.graph = defaultdict(list)
        for u, v in edges:
            self.left_nodes.add(u)
            self.right_nodes.add(v)
            self.graph[u].append(v)

    def dfs(self, u, visited):
        for v in self.graph[u]:
            if v in visited:
                continue
            visited.add(v)
            if v not in self.match_right or self.dfs(self.match_right[v], visited):
                self.match_right[v] = u
                self.match_left[u] = v
                return True
        return False

    def max_matching(self):
        for u in self.left_nodes:
            visited = set()
            self.dfs(u, visited)

        return [(u, v) for u, v in self.match_left.items()]