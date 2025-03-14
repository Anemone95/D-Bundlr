import csv
import json
import math
import sys
from pathlib import Path
from tqdm import tqdm
import pandas as pd

from bundle_project.compare_codeql import TaintReport, convert_path, trans_reports_to_dict, getTaintReport
import settings

def geomean(data):
    log_sum = sum(math.log(x if x>0 else 1e-10) for x in data)
    return math.exp(log_sum / len(data)) if data else 0

# black_list_vulns = ["Hard-coded data interpreted as code"]
black_list_vulns = [""]

# solved = ["/home/c01wexu/jelly-benchmarks/results/results-03-16/https:yiwugo.com/##static.yiwugo.com##",
#           "/home/c01wexu/jelly-benchmarks/results/results-03-16/https:greatergood.com/##d1npnstlfekkfz.cloudfront.net##",
#           ]

def get_vulns_from_file(file: Path) -> tuple[dict[str, list], list[TaintReport]]:
    kind2vulns: dict[str, list] = {}
    vulnsList = []
    with file.open() as csvfile:
        vulns = csv.reader(csvfile)
        for row in vulns:
            taint_report = getTaintReport(row, file)
            if taint_report.kind not in black_list_vulns:
                l = kind2vulns.setdefault(taint_report.kind, [])
                l.append(taint_report)
                vulnsList.append(taint_report)
        
    return kind2vulns, vulnsList

def compare_reports(base_csv, new_csv):
    compiled_vulns, compiled_vulns2 = get_vulns_from_file(base_csv)
    unpack_vulns, unpack_vulns2 = get_vulns_from_file(new_csv)

    more_vulns:list[TaintReport] = []
    miss_vulns:list[TaintReport] = []
    overlap_more: list[tuple[list[TaintReport], list[TaintReport]]] = []
    overlap_less: list[tuple[list[TaintReport], list[TaintReport]]] = []
    for [k, vs] in unpack_vulns.items():
        if k in compiled_vulns:
            if len(vs) > len(compiled_vulns[k]):
                overlap_more.append((compiled_vulns[k],vs))
            elif len(vs) < len(compiled_vulns[k]):
                overlap_less.append([compiled_vulns[k], vs])
        else:
            more_vulns += vs

    for [k, vs] in compiled_vulns.items():
        if k not in unpack_vulns:
            miss_vulns += vs
            
    return True, overlap_more, overlap_less, more_vulns, miss_vulns, compiled_vulns2, unpack_vulns2

def diff_report(dir: Path, suffix="-pred"):
    compile_file = dir / 'codeql-compile-results.csv'
    unpack_file = dir / f"codeql{suffix}-results.csv"
    if not (compile_file.exists() and unpack_file.exists()):
        return False, [], [], [], [], [], []
    compile_file_log = dir / 'codeql-compile-making-db.log'
    with compile_file_log.open() as f:
        if "syntax errors" in f.read():
            return False, [], [], [], [], [], []
    return compare_reports(compile_file, unpack_file)

def get_type_to_scripts(l: set[tuple[str,str]], keys: set[str]=set()):
    total=set()
    res = {}
    for kind,s in l:
        keys.add(kind)
        res.setdefault(kind, set()).add(s)
        total.add(s)
    for k in res:
        res[k] = len(res[k])
    return res, len(total)

def get_type_to_site(l: set[tuple[str,str]], script2domain: dict[str, set[str]]):
    total=set()
    res = {}
    for kind,s in l:
        res.setdefault(kind, set()).update(script2domain[s])
        total.update(script2domain[s])
    for k in res:
        res[k] = len(res[k])
    return res, len(total)

def get_sorted_js_files(base_path: str):
    base = Path(base_path).resolve()
    js_files = sorted([str(file.relative_to(base)) for file in base.rglob("*.js")])
    return js_files

DEBUG=True
def diff_all_webs(rdir: Path):
    sites = set()
    sites_has_webpack = set()
    sites_failed = set()
    script_failed = set()
    script_failed2 = set()
    script_failed3 = set()
    script_using_webpack = set()
    
    # unique script
    alerts_in_bundle = set()
    alerts_in_pred = set()
    alerts_in_base = set()
    
    # unique script
    vuln_script_in_bundle:set[tuple[str, str]]=set() # (kind, script_key)
    vuln_script_in_pred=set()
    vuln_script_in_base=set()

    vuln_sites_in_bundle:set[tuple[str, str]]=set() # (kind, script_key)
    vuln_sites_in_pred=set()
    vuln_sites_in_base=set()
    
    # ununique script
    delta_alerts_in_pred:set[TaintReport] = set()
    delta_alerts_in_base:set[TaintReport] = set()
    
    delta_scripts_in_pred:set[tuple[str,str]] = set()
    delta_scripts_in_base:set[tuple[str,str]] = set()

    scriptkey2sites = {}
    script_has_vuln_and_mapper=set()
    
    # in unique script
    unique_scripts = set()
    vuln_types = set()
    detected_lib_to_num = {}
    
    predictTimes=[]
    pointerAnalysisTimes=[]
    dbundlerTimes=[]
    
    predictedBy={"PatternMatching":0, "Similarity":0, "ML":0}

    n1=0
    n2=0
    # for dir in rdir.iterdir():
    for site in tqdm(list(rdir.iterdir())):
        if not site.is_dir():
            continue
        sites.add(site)
        for script_dir in site.iterdir():
            unpack_json_base = script_dir / f"diag-unpack-base.json"
            unpack_json_pred = script_dir / f"diag-unpack-pred.json"
            bundle_script = script_dir.parts[-1]
            bundle_site = script_dir.parts[-2]
            if not (unpack_json_base.exists() and unpack_json_pred.exists()):
                sites_failed.add(site)
                script_failed.add(script_dir)
                continue
            unpack_json_base = json.loads(unpack_json_base.read_text())
            unpack_json_pred = json.loads(unpack_json_pred.read_text())

            if not unpack_json_base["success"] and unpack_json_pred["success"]:
                sites_failed.add(site)
                script_failed2.add(script_dir)
                continue
            if not (unpack_json_pred["mainFiles"]>0 or unpack_json_base["chunks"]>0):
                continue
            success1, overlap_more1, overlap_less1, more_vulns1, miss_vulns1, bundle_vulns1, pred_debundle_vulns = diff_report(script_dir, "-pred")
            success2, overlap_more2, overlap_less2, more_vulns2, miss_vulns2, bundle_vulns2, base_debundle_vulns = diff_report(script_dir, "-base")
            script_files = get_sorted_js_files(script_dir / f"code-pred-raw")
            
            script_key = f"{bundle_script}--{'-'.join(script_files)}"
            sites_has_webpack.add(site)
            script_using_webpack.add(script_key)
            if not (success1 and success2):
                sites_failed.add(site)
                script_failed3.add(script_dir)
                continue

            # ununique scripts data area
            for each in miss_vulns2:
                if each.kind=="Improper code sanitization":
                    print("Debundle: Missing", script_dir)

            for each in bundle_vulns1:
                vuln_sites_in_bundle.add((each.kind, site))
            for each in pred_debundle_vulns:
                vuln_sites_in_pred.add((each.kind, site))
            for each in base_debundle_vulns:
                vuln_sites_in_base.add((each.kind, site))
            scriptkey2sites.setdefault(script_key, set()).add(bundle_site)
            # unique scripts data area
            if script_key in unique_scripts:
                continue
            unique_scripts.add(script_key)
            if DEBUG:
                debug_kind = "Unsafe HTML constructed from library input"
                pred_alert=set()
                for each in pred_debundle_vulns:
                    if each.kind == debug_kind:
                        pred_alert.add(each)

                base_alert=set()
                for each in base_debundle_vulns:
                    if each.kind == debug_kind:
                        base_alert.add(each)

                ground_alert=set()
                for each in bundle_vulns1:
                    if each.kind == debug_kind:
                        ground_alert.add(each)
                if len(pred_alert)<len(base_alert):
                    print(f"pred: {len(pred_alert)}")
                    print(f"base: {len(base_alert)}")
                    print(script_dir)
                    # exit(0)
                n1+=len(base_alert)
                n2+=len(ground_alert)
                if len(base_alert)<len(ground_alert):
                    print(f"ground: {len(ground_alert)}")
                    print(f"base: {len(base_alert)}")
                    print(script_dir)



            alerts_in_bundle.update(bundle_vulns1)
            alerts_in_pred.update(pred_debundle_vulns)
            alerts_in_base.update(base_debundle_vulns)

            delta_alerts_in_pred.update(more_vulns1)

            for old,new in overlap_more1:
                num = len(new)-len(old)
                for i in range(num):
                    delta_alerts_in_pred.add(new[i])
                    
            delta_alerts_in_base.update(more_vulns2)

            for old,new in overlap_more2:
                num = len(new)-len(old)
                for i in range(num):
                    delta_alerts_in_base.add(new[i])

            for each in bundle_vulns1:
                vuln_script_in_bundle.add((each.kind, script_key))
            for each in pred_debundle_vulns:
                vuln_script_in_pred.add((each.kind, script_key))
            for each in base_debundle_vulns:
                vuln_script_in_base.add((each.kind, script_key))

            for each in more_vulns1:
                delta_scripts_in_pred.add((each.kind, script_key))
            for _tuple in overlap_more1:
                # 0 is compiled vulns, 1 is unpacked vulns
                for each in _tuple[1]:
                    delta_scripts_in_pred.add((each.kind, script_key))
            for each in more_vulns2:
                delta_scripts_in_base.add((each.kind, script_key))
            for _tuple in overlap_more2:
                for each in _tuple[1]:
                    delta_scripts_in_base.add((each.kind, script_key))

            for w in unpack_json_pred["wrappers"]:
                if type(w) is dict:
                    detected_lib_to_num.setdefault(w["name"], set()).add(script_key)
                    predictedBy.setdefault(w["by"], 0)
                    predictedBy[w["by"]] += 1
                else:
                    detected_lib_to_num.setdefault(w, set()).add(script_key)
            for w in unpack_json_pred["functions"]:
                if type(w) is dict:
                    detected_lib_to_num.setdefault(w["name"], set()).add(script_key)
                    predictedBy.setdefault(w["by"], 0)
                    predictedBy[w["by"]] += 1
                else:
                    detected_lib_to_num.setdefault(w, set()).add(script_key)

            predictedBy.setdefault(unpack_json_pred.get("predictedBy", "unknown"), 0)
            predictedBy[unpack_json_pred.get("requireFunctionPredictedBy", "unknown")] +=1
            predictTimes.append(unpack_json_pred.get("predictTime", 0))
            pointerAnalysisTimes.append(unpack_json_pred.get("pointerAnalysisTime", 0))
            dbundlerTimes.append(unpack_json_pred.get("dbundlerTime", 0))

            if len(base_debundle_vulns)>0 or len(pred_debundle_vulns)>0:
                package = convert_path(script_dir)
                mapper = list(package.glob("**/*.map"))
                if len(mapper) > 0:
                    script_has_vuln_and_mapper.add(script_dir)

        # debug
        # break
    # print(n1,n2)
                
    alerts_in_bundle, total_alerts_in_bundle = trans_reports_to_dict(alerts_in_bundle,vuln_types)
    alerts_in_pred, total_alerts_in_pred = trans_reports_to_dict(alerts_in_pred,vuln_types)
    alerts_in_base, total_alerts_in_base = trans_reports_to_dict(alerts_in_base,vuln_types)
    delta_alerts_in_pred, total_delta_alerts_in_pred = trans_reports_to_dict(delta_alerts_in_pred)
    delta_alerts_in_base, total_delta_alerts_in_base = trans_reports_to_dict(delta_alerts_in_base)
    
    _vuln_script_in_bundle,total_script_in_bundle= get_type_to_scripts(vuln_script_in_bundle, vuln_types)
    _vuln_script_in_pred,total_script_in_pred= get_type_to_scripts(vuln_script_in_pred, vuln_types)
    _vuln_script_in_base,total_script_in_base= get_type_to_scripts(vuln_script_in_base, vuln_types)
    _delta_scripts_in_pred, total_delta_scripts_in_pred = get_type_to_scripts(delta_scripts_in_pred)
    _delta_scripts_in_base, total_delta_scripts_in_base = get_type_to_scripts(delta_scripts_in_base)
    
    _vuln_sites_in_bundle,total_sites_in_bundle = get_type_to_site(vuln_script_in_bundle, scriptkey2sites)
    _vuln_sites_in_pred,total_sites_in_pred = get_type_to_site(vuln_script_in_pred, scriptkey2sites)
    _vuln_sites_in_base,total_sites_in_base = get_type_to_site(vuln_script_in_base, scriptkey2sites)
    delta_sites_in_pred, total_delta_sites_in_pred = get_type_to_site(delta_scripts_in_pred, scriptkey2sites)
    delta_sites_in_base, total_delta_sites_in_base = get_type_to_site(delta_scripts_in_base, scriptkey2sites)
    
    lines = [ [
        "Vuln Type",
        "Bundle(Alerts)",
        "Bundle(Scripts)",
        "Bundle(Sites)",
        "Base(Alerts)",
        "Base(Scripts)",
        "Base(Sites)",
        "B-New(Alerts)",
        "B-New(Scripts)",
        "B-New(Sites)",
        "Pred(Alerts)",
        "Pred(Scripts)",
        "Pred(Sites)",
        "P-New(Alerts)",
        "P-New(Scripts)",
        "P-New(Sites)"
    ] ]
    for key in vuln_types:
        lines.append([key,
                 alerts_in_bundle.get(key, 0),
                 _vuln_script_in_bundle.get(key, 0), 
                 _vuln_sites_in_bundle.get(key, 0),

                 alerts_in_base.get(key, 0),
                 _vuln_script_in_base.get(key, 0),
                 _vuln_sites_in_base.get(key, 0),

                 delta_alerts_in_base.get(key, 0),
                 _delta_scripts_in_base.get(key, 0),
                 delta_sites_in_base.get(key, 0),

                 alerts_in_pred.get(key, 0),
                 _vuln_script_in_pred.get(key, 0),
                 _vuln_sites_in_pred.get(key, 0),

                 delta_alerts_in_pred.get(key, 0),
                 _delta_scripts_in_pred.get(key, 0),
                 delta_sites_in_pred.get(key, 0)
                 ])
    lines.append(["Total", total_alerts_in_bundle, total_script_in_bundle, total_sites_in_bundle,
                  total_alerts_in_base, total_script_in_base, total_sites_in_base,
                  total_delta_alerts_in_base, total_delta_scripts_in_base, total_delta_sites_in_base,
                  total_alerts_in_pred, total_script_in_pred, total_sites_in_pred,
                  total_delta_alerts_in_pred, total_delta_scripts_in_pred, total_delta_sites_in_pred
                 ])
    lines.append(["totalScripts", len(unique_scripts), "","","","","","","","","","","","","","",""])
    lines.append(["totalWebPackSites", len(sites_has_webpack), "","","","","","","","","","","","","","",""])
    print("Unique_scripts",len(unique_scripts))
    print("Total sites",len(sites_has_webpack))
    print("ReidentifiedLibraries", len(detected_lib_to_num), detected_lib_to_num.keys())
    _sum=0
    for each in detected_lib_to_num:
        _sum+=len(detected_lib_to_num[each])

    print("UniqueIdentifiedLibs", _sum)
    print("PredictedBy", predictedBy)
    print("PredictTimes", geomean(predictTimes))
    print("PointerAnalysisTimes", geomean(pointerAnalysisTimes))
    print("DbundlerTimes", geomean(dbundlerTimes))


    lines.append(["ReidentifiedLibraries", len(detected_lib_to_num), "","","","","","","","","","","","","","",""])
    lines.append(["UniqueIdentifiedLibs", _sum, "","","","","","","","","","","","","","",""])

    top_5 = sorted(detected_lib_to_num.items(), key=lambda x: len(x[1]), reverse=True)[:5]
    lines.append(["Top 5 packages", "", "","","","","","","","","","","","","","",""])

    for each in top_5:
        print(each[0],len(each[1]))
        lines.append(["",each[0], len(each[1]),"","","","","","","","","","","","","",""])

    df = pd.DataFrame(lines)
    df.to_excel("./tmp/output.xlsx", index=False, header=False)
    
    script_has_vuln_and_mapper

    # dataset = []
    # for domain in script_has_vuln_and_mapper:
    #     dataset.append({
    #         "type": "url",
    #         "url": domain.parts[-2].replace(":","://"),
    #     })
    # with open(f"{settings.PROJECT_DIR}/misc/bundle_project/tranco/sourcemapper_db.json", "w") as f:
    #     json.dump(dataset, f, indent=2)
        
    for eachline in lines:
        print(" & ".join(map(lambda e: str(e), eachline)))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python rq3_4.py <result-path>")
        sys.exit(1)
    path = Path(sys.argv[1])
    diff_all_webs(path)
