import {options} from "../options";
import {writeFileSync} from "fs";
import {isCompiledByWebpack} from "./checkcompiledbywebpack";
import {Token} from "../analysis/tokens";
import {RepresentativeVar} from "../analysis/fragmentstate";
import {ObjectPropertyVar} from "../analysis/constraintvars";
import {mapGetMap} from "../misc/util";
import {analysisOneFile} from "./unbundle";
import {decodeSourceMap} from "./extract";

async function count(file: string): Promise<Set<string>|undefined> {
    options.maxIndirections = 2; // 1 is enough
    options.maxWaves = 5; // 4 is enough
    options.cycleElimination = false;
    options.patchEscaping = false;
    const [t, ast, ] = isCompiledByWebpack(file);
    if (!t) {
        return;
    }
    let solver = await analysisOneFile(file, ast);

    let mainFragment = solver.fragmentState;
    /**
     * find module dict
     */
    const objprops: Map<Token, Map<string, RepresentativeVar>> = new Map();
    for (const v of [...mainFragment.vars, ...mainFragment.redirections.keys()])
        if (v instanceof ObjectPropertyVar)
            mapGetMap(objprops, v.obj).set(v.prop, mainFragment.getRepresentative(v));
    let mapConsumer = await decodeSourceMap(file);
    let libraries = new Set<string>();
    mapConsumer?.eachMapping((e:any) => {
        if (e.source.includes("node_modules")) {
            let lib = e.source.split("node_modules/")[1].split("/")[0];
            let second = e.source.split("node_modules/")[1].split("/")[1];
            if (lib.startsWith("@"))
                lib = lib+"/"+second;
            libraries.add(lib);
        }
    });
    return libraries;
}

if (require.main === module) {
    (async () => {
        const target_js = process.argv[2];
        const output = process.argv[3]
        let res = await count(target_js);
        if (res)
            writeFileSync(output, JSON.stringify(Array.from(res)));
    })();
}