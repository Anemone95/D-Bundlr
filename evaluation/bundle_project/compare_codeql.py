import dataclasses
import json
import os
import csv
from pathlib import Path
import random
import re
from typing import TypeVar

from strsimpy import MetricLCS, LongestCommonSubsequence
from tqdm import tqdm

import settings
DETAIL_REPORT = True

@dataclasses.dataclass(frozen=True)
class Location:
    path: Path
    start_line: int  # start from 1
    start_column: int
    end_line: int  # start from 1
    end_column: int

    def __hash__(self):
        return hash((self.path, self.start_line, self.start_column, self.end_line, self.end_column))

    def __str__(self):
        return f"{self.path}:{self.start_line}:{self.start_column}:{self.end_line}:{self.end_column}"

    def __iter__(self):
        yield from ({
            "path": str(self.path),
            "start_line": self.start_line,
            "start_column": self.start_column,
            "end_line": self.end_line,
            "end_column": self.end_column
        }).items()


@dataclasses.dataclass(frozen=True)
class TaintReport:
    kind: str
    source: Location
    sink: Location

    def __hash__(self):
        return hash((self.kind, self.source, self.sink))

    def __iter__(self):
        yield from ({
            "kind": self.kind,
            "source": dict(self.source),
            "sink": dict(self.sink)
        }).items()

def getTaintReport(row: list[str], base_dir: Path) -> TaintReport:
    sink_file = base_dir / ("./" + row[-5])
    sink_start_line = int(row[-4])
    sink_start_column = int(row[-3])
    sink_end_line = int(row[-2])
    sink_end_column = int(row[-1])
    sink = Location(sink_file, sink_start_line, sink_start_column, sink_end_line, sink_end_column)
    source_location = extract_and_split(row[3])
    source_file = base_dir / ("./" + source_location[1][2:])
    source = Location(source_file,
                      int(source_location[-4]),
                      int(source_location[-3]),
                      int(source_location[-2]),
                      int(source_location[-1]))
    return TaintReport(row[0], source, sink)


ignored_bugs = {"Expression has no effect",
                "Duplicate property",
                "Self assignment",
                "Comparison between inconvertible types",
                "Unneeded defensive code",
                "Duplicate character in character class",
                "Insecure randomness",
                "DOM text reinterpreted as HTML",
                "Variable not declared before use",
                "Useless assignment to local variable",
                "Duplicate variable declaration",
                "Syntax error",
                "Semicolon insertion",
                "Useless conditional",
                "Return statement assigns local variable",
                "Superfluous trailing arguments",
                "Missing regular expression anchor",
                "Unreachable statement",
                "Unused variable, import, function or class",
                "Incomplete string escaping or encoding",
                'Missing variable declaration',
                'Useless assignment to property',
                'Incomplete regular expression for hostnames',
                'Invocation of non-function',
                'Access to let-bound variable in temporal dead zone',
                'Inefficient regular expression',
                'Property access on null or undefined',
                'Incomplete URL scheme check',
                'Potentially inconsistent state update',
                'Misleading indentation after control statement',
                'Incomplete URL substring sanitization',
                'Off-by-one comparison against length',
                'Unused or undefined state property',
                'Use of returnless function',
                'Ignoring result from pure array method',
                'Useless comparison test',
                "Misleading indentation of dangling 'else'",
                'Overly permissive regular expression range',
                'Identical operands',
                'Conflicting variable initialization',
                'Missing await',
                'Unsupported state update in lifecycle method',
                'Useless type test',
                'Prototype-polluting function',
                'Unknown directive',
                'Invalid prototype value',
                'Improper code sanitization',
                'Conflicting function declarations',
                'Unmatchable caret in regular expression',
                "Wrong use of 'this' for static method",
                'Unmatchable dollar in regular expression',
                'Shift out of range',
                'Unused loop iteration variable',
                'Assignment to constant',
                'Use of call stack introspection in strict mode',
                'Unsafe dynamic method access',
                'Incorrect suffix check',
                'Duplicate parameter names',
                'Unsafe HTML constructed from library input',
                'Comparison with NaN',
                'Illegal invocation',
                'Overwritten property'
                # 'Client-side request forgery',
                }

all_vulns_type = set()

servere_bugs = {
    'Client-side cross-site scripting', 'Regular expression injection', 'Code injection', 'Client-side URL redirect',
    'Client-side request forgery',
    'Cross-window communication with unrestricted target origin'
}

servere_bugs2 = {
    'Client-side cross-site scripting', 'Code injection', 'Client-side URL redirect'
}


def get_sink_kind(sink_file: Path) -> str | None:
    if str(sink_file).endswith("/102.js"):
        return 'gigia'
    if "FAILED" in str(sink_file):
        return "FAILED"
    content = sink_file.read_text()
    if "Read more: https://nextjs.org/docs/messages/" in content and "href-interpolation-failed" in content:
        return "nextjs/router"
    return None


def get_vulns_from_file(file: Path) -> tuple[dict[str, list], list[TaintReport]]:
    kind2vulns: dict[str, list] = {}
    global all_vulns_type
    vulnsList = []
    with file.open() as csvfile:
        vulns = csv.reader(csvfile)
        for row in vulns:
            if row[0] in servere_bugs and row[2] == "error" and ("FAILED" not in row[-5]):
                l = kind2vulns.get(row[0], [])
                l.append(row)
                kind2vulns[row[0]] = l
                vulnsList.append(getTaintReport(row, file))
        
    return kind2vulns, vulnsList 


def diff_one_web(dir: Path, suffix="-pred"):
    compile_file = dir / 'codeql-compile-results.csv'
    unpack_file = dir / f"codeql{suffix}-results.csv"
    if not (os.path.exists(compile_file) and os.path.exists(unpack_file)):
        return False, [], [], [], [], [], []
    compile_file_log = dir / 'codeql-compile-making-db.log'
    with compile_file_log.open() as f:
        if "syntax errors" in f.read():
            return False, [], [], [], [], [], []
    return compare_files(compile_file, unpack_file)


def convert_path(input_path):
    if not isinstance(input_path, Path):
        raise ValueError("Must be a Path object")
    parts = input_path.parts

    if len(parts) < 2:
        raise ValueError("Path must have at least 2 parts")
    base = Path(settings.PACKAGES_DIR)
    new_path = base / "/".join(parts[-2:]).replace("##", "/")

    return new_path


def compare_files(base_csv, new_csv):
    compiled_vulns, compiled_vulns2 = get_vulns_from_file(base_csv)
    unpack_vulns, unpack_vulns2 = get_vulns_from_file(new_csv)

    more_vulns = []
    miss_vulns = []
    overlap_more = []
    overlap_less = []
    for [k, vs] in unpack_vulns.items():
        if k in compiled_vulns:
            if len(vs) > len(compiled_vulns[k]):
                overlap_more.append([vs, compiled_vulns[k]])
            elif len(vs) < len(compiled_vulns[k]):
                overlap_less.append([vs, compiled_vulns[k]])
        else:
            more_vulns += vs

    for [k, vs] in compiled_vulns.items():
        if k not in unpack_vulns:
            miss_vulns += vs
            
    return True, overlap_more, overlap_less, more_vulns, miss_vulns, compiled_vulns2, unpack_vulns2


def make_miss_dataset(url_list: list[str]):
    return [{"type": "url",
             "url": url.replace("https:", "https://") if url.startswith("https") else url.replace("http:", "http://")}
            for url in url_list]


K = TypeVar('K')
V = TypeVar('V')


def mapset_to_mapnumber(mapset: dict[K, set[V]]) -> list[dict[K, int], int]:
    ret = {}
    values = set()
    for [k, v] in mapset.items():
        ret[k] = len(v)
        values.update(v)
    return ret, len(values)


def mark_import_row(content: list[str], startLine: int, startColumn: int, endLine: int, endColumn: int,
                    mark: str = "Sink"):
    line = content[startLine - 1]
    if startLine == endLine:
        content[startLine - 1] = content[startLine - 1] + f"// <-{mark}: [[{line[startColumn - 1:endColumn]}]]"
    else:
        content[startLine - 1] = content[startLine - 1] + f"// <-{mark}StartLine, Column: {startColumn}"
        content[endLine - 1] = content[endLine - 1] + f"// <-{mark}EndLine, Column: {endColumn}"
    return "\n".join(content[startLine - 5:endLine + 5])


def extract_and_split(text):
    pattern = r'\[\["(.*?)\|(.*?)"\]\]'
    match = re.search(pattern, text)
    if match:
        file_path = match.group(2)
        return file_path.split(":")
    return None
metric = MetricLCS()
lcs = LongestCommonSubsequence()
def lcs_sim(base: str, b: str) -> float:
    base = base.replace(" ","").replace("\n","")
    b = b.replace(" ","").replace("\n","")
    dom = min(len(base), len(b))
    if dom==0:
        return 0
    return lcs.length(base, b) / dom

def lcs_sim2(base: str, b: str) -> float:
    base = base.replace(" ","").replace("\n","")
    b = b.replace(" ","").replace("\n","")
    return lcs.length(base, b) / max(len(base), len(b))


file2file_sim=dict()
def find_file_from_lines(lines: list[str], _dir: Path, sample:None|int=None) -> Path | None:
    lines = map(lambda e: e.replace(" ",""), lines)
    lines = list(filter(lambda e: len(e)>5, lines))
    if sample and len(lines) > sample:
        lines = random.sample(lines, sample) 
    line_size = len(lines)
    matched_file = None
    matches_max = 0
    source_files = list(_dir.rglob('*'))
    for source_file in source_files:
        if source_file.is_file():
            if "bootstrap.js" in source_file.parts:
                continue
            if "external " in source_file.name:
                continue
            source_file_lines = source_file.read_text().splitlines()
            matches = 0
            for line in lines:
                for source_line in source_file_lines:
                    source_line = source_line.replace(" ", "")
                    if len(source_line)>5 and len(line)*0.8<len(source_line) and len(source_line)<len(line)*1.2:
                        if lcs_sim(line, source_line) > 0.75:
                            matches += 1
                            break
            if matches == line_size:
                return matched_file
            if matches > matches_max:
                matched_file = source_file
                matches_max = matches
    if matched_file is not None:
        return matched_file
    return None


def find_script_from_lines(lines: list[str], _dir: Path) -> str | None:
    file = find_file_from_lines(lines, _dir)
    if file is None:
        return None
    else:
        return "http://" + file.parts[3].replace("##", "") + "/" + "/".join(file.parts[5:])



def format_to_cris(vuln_rows: list, unbundle_dir: Path, bundle_dir: Path, output: Path):
    url = str(unbundle_dir.parts[-2]).replace(":", "://")
    vuln = vuln_rows[0]
    raw = "##".join(vuln_rows)
    report = getTaintReport(vuln_rows, unbundle_dir)
    sink_file = report.sink.path
    sink_content = sink_file.read_text().split("\n")
    sampled_sink_content = random.sample(sink_content, min(50, len(sink_content)))
    startline = report.sink.start_line - 1
    endline = report.sink.end_line - 1
    sampled_sink_content.append(sink_content[startline])
    sampled_sink_content.append(sink_content[endline])
    sink = mark_import_row(sink_content, int(vuln_rows[-4]), int(vuln_rows[-3]), int(vuln_rows[-2]), int(vuln_rows[-1]))
    source_file = report.source.path
    source_lines = source_file.read_text().split("\n")
    sampled_source_content = random.sample(source_lines, min(50, len(source_lines)))
    source = mark_import_row(source_lines, report.source.start_line, report.source.start_column, report.source.end_line, report.source.end_column, "Source")

    sink_script = find_script_from_lines(sampled_sink_content, bundle_dir)
    source_script = find_script_from_lines(sampled_source_content, bundle_dir)
    if source_script is None:
        source_script = "Can't find source script"
    if sink_script is None:
        sink_script = "Can't find sink script"

    template = f"""
## Website

<{url}>

## Bundle Script

{sink_script} (Sink Script)

Use https if http doesn't work.

## Vulnerability

{vuln}

## Raw CodeQL Result

!!Location in CodeQL report is in debundled files

```plain
{raw}
```

## Source

<{source_script}>

```javascript
{source}
```

## Sink

<{sink_script}>

```javascript
{sink}
```

"""
    output = output / f"{vuln_rows[0].replace(' ','')}-{unbundle_dir.parts[3].replace('##','')}-{'-'.join(vuln_rows[-4:])}.md"
    if not output.parent.exists():
        output.parent.mkdir(exist_ok=True)
    output.write_text(template)


script_to_one_domain = {}
debug = False
def diff_all_webs(rdir: Path, unpack_suffix="-pred"):
    miss_domains = set()
    miss_vulns_num = 0
    detected_place = []

    sites = set()
    sites_has_webpack = set()
    sites_failed = set()
    domains_has_webpack = set()  # ∃ domain(www.google.com/cdn.google.x) ∈ sites, domain failed
    domains_without_webpack = set()
    domains_has_vuln = set()  # domains_has_vuln ⊆ domains_has_webpack
    domains_failed = set()  # domain_has_webpack+domains_without_webpack+domains_failed = total_domains
    domains_failed2 = set()

    scripts_has_webpack = set()  # scripts = unique(domain)
    scripts_has_vulns = set()  # scripts_has_vulns ⊆ scripts
    scripts_has_more_vulns = set()  # scripts_has_vulns ⊆ scripts
    bundle_alerts = set()
    debundle_alerts = set()
    scripts_contain_at_least_one_predicted = set()

    detected_packages = {}
    detected_functions = {}
    script_has_vuln_and_mapper = set()
    more_vulns_type_to_number = {}  # {Type->number}, means more type vuln detected
    miss_sites = []
    more_vulns_type_to_uniue_script = {}
    
    unique_scripts = set()
    vulns_in_bundle = []
    vulns_in_debundle = []

    for dir in rdir.iterdir():
        if debug and len(domains_has_vuln)>10:
            break
        for site in tqdm(list(dir.iterdir())):
            if debug and len(domains_has_vuln)>10:
                break
            if site.is_dir():
                sites.add(site)
                for domain in site.iterdir():
                    unpack_json = domain / f"diag-unpack{unpack_suffix}.json"
                    unpack_json2 = domain / f"diag-unpack-base.json"
                    unpack_json3 = domain / f"diag-unpack-pred.json"
                    if unpack_json.exists() and unpack_json2.exists() and unpack_json3.exists():
                        unpack_success = False
                        domain_has_webpack = False
                        bundle_script = domain.parts[-1]
                        bundle_site = domain.parts[-2]
                        script_to_one_domain[bundle_script] = domain
                        with unpack_json.open() as f:
                            unpack_res = json.load(f)
                            if unpack_res["success"]:
                                unpack_success = True
                                if (unpack_res["mainFiles"] > 0 or unpack_res["chunks"] > 0):
                                    domain_has_webpack = True
                                    # count predict
                                    for w in unpack_res["wrappers"]:
                                        # key = "querystring"
                                        # if key in w:
                                        #     with (domain / "unpack.log").open() as f:
                                        #         for readline in f.readlines():
                                        #             if f"\"{key}\"" in readline:
                                        #                 print(domain, readline)
                                        #                 break
                                        s = detected_packages.get(w, set())
                                        s.add(bundle_script)
                                        detected_packages[w] = s
                                        scripts_contain_at_least_one_predicted.add(bundle_script)
                                    for w in unpack_res["functions"]:
                                        s = detected_functions.get(w, set())
                                        detected_functions[w] = s
                                        s.add(bundle_script)
                                        scripts_contain_at_least_one_predicted.add(bundle_script)
                                    # if len(unpack_res["wrappers"])>0:
                                    #     print("Wrapper",domain, unpack_res)
                                    # if len(unpack_res["functions"])>0:
                                    #     print("Function",domain, unpack_res)
                        if unpack_success:
                            if domain_has_webpack:
                                sites_has_webpack.add(site)
                                domains_has_webpack.add(domain)
                                scripts_has_webpack.add(bundle_script)
                            else:
                                domains_without_webpack.add(domain)
                        else:
                            domains_failed.add("/".join(domain.parts[-2:]))
                            sites_failed.add(site)
                            scripts_has_webpack.add(bundle_script)

                        if unpack_success and domain_has_webpack:
                            _script = bundle_script
                            success, overlap_more, overlap_less, more_vulns, miss_vulns, bundle_vulns, debundle_vulns = diff_one_web(domain, unpack_suffix)
                            # make Table RQ4
                            vulns_in_bundle.extend(bundle_vulns)
                            vulns_in_debundle.extend(debundle_vulns)
                            key = f"{_script}-{len(bundle_vulns)}-{len(debundle_vulns)}"
                            if key not in unique_scripts:
                                unique_scripts.add(key)
                                bundle_alerts.update(bundle_vulns)
                                debundle_alerts.update(debundle_vulns)

                            if len(more_vulns) > 0 or len(overlap_more) > 0:
                                if _script not in scripts_has_more_vulns:
                                    if len(more_vulns) > 0:
                                        for report_row in more_vulns:
                                            vuln_kind = report_row[0]
                                            sink_file = domain / f"code{unpack_suffix}/{report_row[-5]}"
                                            s = more_vulns_type_to_number.get(vuln_kind, set())
                                            s.add(_script)
                                            more_vulns_type_to_number[vuln_kind] = s
                                            key = get_sink_kind(sink_file)
                                            # USE THIS FOR FIND INTERESTING VULN
                                            # if key is None and vuln_kind in servere_bugs2:
                                            #     print(domain)
                                            if DETAIL_REPORT:
                                                format_to_cris(report_row,
                                                            domain / f"code{unpack_suffix}",
                                                            domain / f"code{unpack_suffix}-raw",
                                                            Path(settings.WORK_DIR) / "cris"
                                                            )
                                            key = key if key is not None else _script
                                            s = more_vulns_type_to_uniue_script.get(vuln_kind, set())
                                            s.add(key)
                                            more_vulns_type_to_uniue_script[vuln_kind] = s
                                    if len(overlap_more) > 0:
                                        for report_row in overlap_more:
                                            s = more_vulns_type_to_number.get(report_row[0][0][0], set())
                                            s.add(bundle_script)
                                            more_vulns_type_to_number[report_row[0][0][0]] = s
                                scripts_has_more_vulns.add(_script)
                                ## USE THIS FOR FIND DOMAIN
                                # if domain.parts[3] == '##payecom.ru##':
                                #     print('DDD',domain)
                                #     exit(0)
                                domains_has_vuln.add(domain)
                                package = convert_path(domain)
                                mapper = list(package.glob("**/*.map"))
                                if len(mapper) > 0:
                                    script_has_vuln_and_mapper.add(_script)
                            if len(unpack_res["functions"]) > 0:
                                detected_place.append(domain)
                            if len(miss_vulns) or len(overlap_less) > 0:
                                # if unpack_suffix=="-base":
                                #     print("[Missing]",domain)
                                miss_domains.add(_script)
                                miss_sites.append(bundle_site)
                    elif (domain / f"unpack{unpack_suffix}.log").exists():
                        domains_failed.add("/".join(domain.parts[-2:]))
                        sites_failed.add(site)
                        scripts_has_webpack.add(bundle_script)
                    elif (domain / f"codeql-compile{unpack_suffix}.csv").exists():
                        domains_failed2.add("/".join(domain.parts[-2:]))
                        sites_failed.add(site)
                        scripts_has_webpack.add(bundle_script)
    print(f"Total sites: {len(sites)}")
    print(f"Total sites includes webpack: {len(sites_has_webpack)}")
    print(f"Failed sites: {len(sites_failed)}")
    print(
        f"Domain(vuln/webpack/no_webpack/failed): {len(domains_has_vuln)}/{len(domains_has_webpack)}/{len(domains_without_webpack)}/({len(domains_failed)}+{len(domains_failed2)})")
    print(
        f"Script(vuln/>1 predicted/has_mapper/unique domain): {len(scripts_has_more_vulns)}/{len(scripts_contain_at_least_one_predicted)}/{len(script_has_vuln_and_mapper)}/{len(scripts_has_webpack)}")
    miss_domains = list(miss_domains)
    miss_domains.sort()
    print(f"Script has less vuln: {miss_domains}")
    print(f"Script has vuln: {len(scripts_has_vulns)}, Bundle alerts: {len(bundle_alerts)}, Debundle alerts: {len(debundle_alerts)}")

    m, n = mapset_to_mapnumber(more_vulns_type_to_number)
    print(f"Script's vuln: {m},{n}")
    m, n = mapset_to_mapnumber(more_vulns_type_to_uniue_script)
    print(f"Unique Sink: {m}, {n}")
    print(f"Script has vuln and has predicted: {len(scripts_has_vulns&scripts_contain_at_least_one_predicted)}")
    
    # print("Predict Wrappers:")
    # for [k, v] in detected_packages.items():
    #     print(k, len(v))
    # print("Functions:")
    # for [k, v] in detected_functions.items():
    #     print(k, len(v))

    # print("Miss sites wrote in miss_sites.json")
    # with open("miss_sites.json", "w") as f:
    #     json.dump(make_miss_dataset(miss_sites), f, indent=2)
    return [sites_failed, more_vulns_type_to_number, scripts_contain_at_least_one_predicted, script_has_vuln_and_mapper, bundle_alerts, debundle_alerts, vulns_in_bundle, vulns_in_debundle]

def get_exec_time(log_file: Path) -> float|None:
    with log_file.open() as f:
        last_line = f.readlines()[-1]
        try:
            number = float(re.search(r"\d+\.\d+", last_line).group())
        except:
            number = None
        return number

def trans_reports_to_dict(s: set[TaintReport], keys: set[str]=set())->tuple[dict[str,int],int]:
    res = {}
    total=0
    for each in s:
        keys.add(each.kind)
        if each.kind not in res:
            res[each.kind] = 0
        res[each.kind] += 1
        total+=1
    return res, total

def get_type_to_script(s: set[TaintReport], root_path:Path, keys: set[str]=set()):
    idx = len(root_path.parts)
    res = {}
    for each in s:
        keys.add(each.kind)
        if each.kind not in res:
            res[each.kind] = set()
        res[each.kind].add(each.source.path.parts[idx+2])
    s=0
    for k in res:
        res[k] = len(res[k])
        s+=res[k]
    return res, s

def get_type_to_domain(s: set[TaintReport], root_path:Path, keys: set[str]=set()):
    idx = len(root_path.parts)
    res = {}
    for each in s:
        keys.add(each.kind)
        if each.kind not in res:
            res[each.kind] = set()
        res[each.kind].add(each.source.path.parts[idx+1])
    
    s=0
    for k in res:
        res[k] = len(res[k])
        s+=res[k]
    return res, s

if __name__ == "__main__":
    path = "/scratch/wenyuan/result-03-01"
    failed_domain, more_vulns_type_to_number,scripts_contain_at_least_one_predicted, script_has_vuln_and_mapper, unique_bundle_vulns, unique_pred_debundle_vulns, bundle_vulns, pred_debundle_vulns, diff_ = diff_all_webs(Path(path))

    keys=set()
    bundle_alerts_dict = trans_reports_to_dict(unique_bundle_vulns,keys)
    bundle_scripts_dict,total = get_type_to_script(unique_pred_debundle_vulns,Path(path),keys)
    bundle_domain_dict,total2 = get_type_to_domain(bundle_vulns,Path(path),keys)
    
    print(json.dumps(bundle_alerts_dict, indent=2), len(unique_bundle_vulns))
    print(json.dumps(bundle_scripts_dict, indent=2), total)
    print(json.dumps(bundle_domain_dict, indent=2), total2)
    
    pred_debundle_alerts_dict = trans_reports_to_dict(unique_pred_debundle_vulns,keys)
    pred_debundle_scripts_dict,total = get_type_to_script(unique_pred_debundle_vulns,Path(path),keys)
    pred_debundle_domain_dict,total2 = get_type_to_domain(pred_debundle_vulns,Path(path),keys)

    print("With prediction")
    print(json.dumps(pred_debundle_alerts_dict, indent=2))
    print(json.dumps(pred_debundle_scripts_dict, indent=2), total)
    print(json.dumps(pred_debundle_domain_dict, indent=2), total2)

    failed_domain2, more_vulns_type_to_number2,_,_,_,unique_basic_debundle_vulns,_,basic_debundle_vulns = diff_all_webs(Path(path), "-base")
    print("Without prediction")
    basic_debundle_alerts_dict = trans_reports_to_dict(unique_basic_debundle_vulns,keys)
    basic_debundle_scripts_dict,total = get_type_to_script(unique_basic_debundle_vulns,Path(path),keys)
    basic_debundle_domain_dict,total2 = get_type_to_domain(basic_debundle_vulns,Path(path),keys)

    print(json.dumps(basic_debundle_alerts_dict, indent=2))
    print(json.dumps(basic_debundle_scripts_dict, indent=2), total)
    print(json.dumps(basic_debundle_domain_dict, indent=2), total2)

    for [k,v] in more_vulns_type_to_number.items():
        v2 = more_vulns_type_to_number2[k]
        for each_v in v-v2:
            print("More vulns:", script_to_one_domain[each_v])

        for each_v in v2-v:
            print("Less vulns:", script_to_one_domain[each_v])
    dataset = []
    for script in script_has_vuln_and_mapper:
        domain = script_to_one_domain[script]
        dataset.append({
            "type": "url",
            "url": domain.parts[-2].replace(":","://"),
        })
    with open("sourcemapper_db.json", "w") as f:
        json.dump(dataset, f, indent=2)


    # for failed in failed_domain:
    #     if failed not in failed_domain2:
    #         print(failed)

    # base_analysis_time = []
    # pred_analysis_time = []
    # base_makedb_time = []
    # pred_makedb_time = []
    # for script in scripts_contain_at_least_one_predicted:
    #     domain = script_to_one_domain[script]
    #     base_analysis_file = domain / "codeql-base-analyzing.log"
    #     base_makedb_file = domain / "codeql-base-making-db.log"
    #     pred_analysis_file = domain / "codeql-pred-analyzing.log"
    #     pred_makedb_file = domain / "codeql-pred-making-db.log"
        
    #     if base_makedb_file.exists() and pred_makedb_file.exists():
    #         base_makedb_time.append(get_exec_time(base_makedb_file))
    #         pred_makedb_time.append(get_exec_time(pred_makedb_file))
    #     if base_analysis_file.exists() and pred_analysis_file.exists():
    #         base_analysis_time.append(get_exec_time(base_analysis_file))
    #         pred_analysis_time.append(get_exec_time(pred_analysis_file))
    # base_analysis_time = list(filter(lambda e: e is not None, base_analysis_time))
    # pred_analysis_time = list(filter(lambda e: e is not None, pred_analysis_time))
    # base_makedb_time = list(filter(lambda e: e is not None, base_makedb_time))
    # pred_makedb_time = list(filter(lambda e: e is not None, pred_makedb_time))
    # print("Base/pred analysis time:", sum(base_analysis_time)/len(base_analysis_time), sum(pred_analysis_time)/len(pred_analysis_time), len(base_analysis_time))
    # print("Base/pred makedb time:", sum(base_makedb_time)/len(base_makedb_time), sum(pred_makedb_time)/len(pred_makedb_time))

    
    # failed_domain3 = diff_all_webs(
    #     Path(path), "3")
    # print(failed_domain - failed_domain2)
    # failed_domain2 = diff_all_webs(
    #     Path("./results/bundle-codeql-2025-01-11#16.24.53"))
    # print("---------------")
    # print(failed_domain2-failed_domain)
    # print("---------------")
    # print(failed_domain-failed_domain2)
