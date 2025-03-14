import {options} from "../options";
import assert from "assert";
import {writeFileSync} from "fs";
import {isCompiledByWebpack} from "./checkcompiledbywebpack";
import logger from "../misc/logger";
import {AccessPathToken, ClassToken, FunctionToken, ObjectToken, Token} from "../analysis/tokens";
import {RepresentativeVar} from "../analysis/fragmentstate";
import {ObjectPropertyVar} from "../analysis/constraintvars";
import {mapGetMap} from "../misc/util";
import {analysisOneFile, isComponentToken, isNumber} from "./unbundle";
import {decodeSourceMap, locationInScope} from "./extract";

async function count(file: string): Promise<[Set<string>, Set<string>]|undefined> {
    options.maxIndirections = 2; // 1 is enough
    options.maxWaves = 5; // 4 is enough
    options.cycleElimination = false;
    options.patchEscaping = false;
    const [t, ast,] = isCompiledByWebpack(file);
    if (t !== "main") {
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
    let moduleDicts: Array<Map<number, FunctionToken | ClassToken>> = [];
    let modulesTokens: Array<ObjectToken> = [];
    for (const [t, props] of objprops) {
        let modules: Map<number, FunctionToken | ClassToken> = new Map();
        if (t instanceof ObjectToken) {
            let isModuleDict = true;
            for (const [k, v] of props) {
                if (!isNumber(k)) {
                    isModuleDict = false;
                    break;
                }
                for (const func of mainFragment.getTokens(v)) {
                    if (!(isComponentToken(func) || func instanceof AccessPathToken)) {
                        isModuleDict = false;
                        break;
                    } else if (isComponentToken(func)) {
                        modules.set(parseInt(k), func);
                    }
                }
                if (!modules.has(parseInt(k)))
                    isModuleDict = false;

                if (!isModuleDict) {
                    break;
                }
            }
            if (isModuleDict) {
                moduleDicts.push(modules);
                modulesTokens.push(t);
            }
        }
    }
    assert(modulesTokens.length === 1)
    let modulesToken = modulesTokens[0];
    let mapConsumer = await decodeSourceMap(file);

    let hoistedModule = new Set<string>();
    let plainModule = new Set<string>();
    mapConsumer?.eachMapping((e:any) => {
        if (e.source.includes("node_modules")) {
            if (!locationInScope({line: e.generatedLine!, column: e.generatedColumn!}, modulesToken.allocSite.loc!)) {
                if (!hoistedModule.has(e.source)) {
                    logger.info(`Hoisted module: ${e.source}`);
                }
                hoistedModule.add(e.source);
            } else {
                plainModule.add(e.source);
            }
        }
    });
    return [hoistedModule, plainModule];
}

if (require.main === module) {
    (async () => {
        const target_js = process.argv[2];
        const output = process.argv[3]
        let res = await count(target_js);
        if (res)
            writeFileSync(output, JSON.stringify({hoisted:Array.from(res[0]), plain:Array.from(res[1])}));
    })();
}