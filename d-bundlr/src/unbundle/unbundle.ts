import Solver from "../analysis/solver";
import {
    findRequireFunctionByML,
    findRequireFunctionByPatternMatching,
    findRequireFunctionBySimilarity
} from "./similiarity";
import {
    AccessPathToken,
    AllocationSiteToken,
    ArrayToken,
    ClassToken,
    FunctionToken,
    ObjectToken,
    Token
} from "../analysis/tokens";
import {FragmentState, RepresentativeVar} from "../analysis/fragmentstate";
import {
    ConstantVar,
    ConstraintVar,
    FunctionReturnVar, isObjectPropertyVarObj,
    NodeVar,
    ObjectPropertyVar
} from "../analysis/constraintvars";
import {
    getOrSet,
    Location,
    locationToString,
    locationToStringWithFile,
    mapGetArray,
    mapGetMap,
    mapGetSet
} from "../misc/util";
import logger, {writeStdOutIfActive} from "../misc/logger";
import {options} from "../options";
import fs, {statSync} from "fs";
import {codeFromLocation} from "../misc/files";
import * as beautify from 'js-beautify';
import assert from "assert";
import {
    ArrayExpression,
    ArrowFunctionExpression,
    ExpressionStatement, Function,
    FunctionDeclaration,
    Identifier, isBlockStatement, isDirectiveLiteral, isExpression, isFunctionDeclaration,
    Node,
    NumericLiteral,
    SourceLocation
} from "@babel/types";
import * as t from "@babel/types";
import {nuutila} from "../misc/scc";
import {finalizeCallEdges} from "../analysis/finalization";
import path, {resolve} from "path";
import {File} from "@babel/types";
import {isCompiledByWebpack} from "./checkcompiledbywebpack";
import {buildNatives} from "../natives/nativebuilder";
import {preprocessAst} from "../parsing/extras";
import {visit} from "../analysis/astvisitor";
import {Operations} from "../analysis/operations";
import {findEscapingObjects} from "../analysis/escaping";
import {widenObjects} from "../analysis/widening";
import {isSubTree, MATCHED_NODE} from "./subASTSearch";
import {AccessPath} from "../analysis/accesspaths";
import {ARRAY_ALL, ARRAY_UNKNOWN} from "../natives/ecmascript";
import {MODULES_MAP} from "./webpackfingerprint";
import traverse, {NodePath} from "@babel/traverse";
import {
    FunctionPrototype,
    INDEX_JS,
    MODULE_WRAPPER_FUNCTION,
    predictFunctionPrototypeByML,
    prepareContext,
    prepareContext2,
    moduleMapToString,
    predictModuleNaiveWrapper, codeToFile, contextToString, BUNDLE_FUNCTION
} from "./verifypackageis";
import * as parser from "@babel/parser";
import generate from "@babel/generator"
import {applyTransforms, transformCode} from "./unminify";
import sequence from "./minify/sequence";
import {ModuleEvent} from "../blended/sandbox/moduleevent";
import {VM} from "../blended/sandbox/webpackbox";
import {transformFunctionAst} from "./functionAstTransform";
import Timer from "../misc/timer";
import {parse, ParserOptions} from "@babel/parser";
import splitvariabledecl from "./minify/splitvariabledecl";
import * as m from '@codemod/matchers';

let ori = fs.writeFileSync;
// @ts-ignore
fs.writeFileSync = (path: fs.PathLike | number, data: any, options: fs.WriteFileOptions) => {
    ori(path, data, options);
}

let SOUND_MODE = options.soundMode;
let PREDICT = options.predict;
let ML_PREDICT = options.machineLearning && options.predict;
let PREDICT_REQUIRE = true;
let SPLIT_FUNCTION_IN_MAIN = false; //NEED FIX if set to true

export function isNumber(value: any) {
    if (typeof value === 'string') {
        return !isNaN(<any>value) && value.trim() !== '';
    } else {
        return typeof value === 'number' && Number.isFinite(value);
    }
}

// FIXME: fix replace block
// e.g., replace("a(b())", "b()", "c()")
// but later replace("a(b())", "a(b())", "d()")// here we failed
// function replaceBlock(content: string, block: string, newBlock: string = "", historyReplaced: Map<string, string>): string {
//     const i = content.indexOf(block); // string.replace doesn't like very long strings
//     return content.substring(0, i) + newBlock + content.substring(i + block.length)
// }

class ReplaceBlocker {
    private content: string;
    private replaceTask: Array<[string, string]>;
    constructor(content: string) {
        this.content = content;
        this.replaceTask = [];
    }
    replaceBlock(block:string, newBlock: string=""): void {
        this.replaceTask.push([block, newBlock]);
    }

    replace(content: string, block: string, newBlock: string = ""): string {
        const i = content.indexOf(block); // string.replace doesn't like very long strings
        return content.substring(0, i) + newBlock + content.substring(i + block.length)
    }
    apply(): string {
        // sort by length descending
        this.replaceTask.sort((a, b) => b[0].length - a[0].length);
        for (let [block, newBlock] of this.replaceTask) {
            const i = this.content.indexOf(block); // string.replace doesn't like very long strings
            if (i>0)
                this.content = this.content.substring(0, i) + newBlock + this.content.substring(i + block.length);
        }
        return this.content;
    }
}

export function isComponentToken(t: Token): t is FunctionToken {
    return t instanceof FunctionToken;
}

function getComponentTokenLocation(t: FunctionToken | ClassToken): (SourceLocation & { filename?: string }) {
    if (t instanceof FunctionToken) {
        assert(t.fun.loc);
        return t.fun.loc;
    } else {
        assert(t.allocSite.loc);
        return t.allocSite.loc;
    }
}

// function componentHasFreeVariables(t: FunctionToken | ClassToken, a: GlobalState): boolean {
//     if (t instanceof FunctionToken) {
//         let f = a.functionInfos.get(t.fun);
//         assert(f);
//         return f.freeVarsWrite.size > 0 || f.freeVarsRead.size > 0 || f.freeVarsReadArguments !== undefined || f.freeVarsReadThis !== undefined;
//     } else {
//         throw new Error("Not implemented checking class free variables");
//     }
// }

function extractFileName(filePath: string): string {
    // const parts = path.split('/');
    // const fileWithExtension = parts[parts.length - 1];
    // const fileName = fileWithExtension.split('.')[0];

    const parsedPath = path.parse(filePath);
    return parsedPath.name;
}

function getDebundedFileName(component: FunctionToken): string {
    let componentLocation = component.fun.loc!;
    return `${extractFileName(componentLocation.filename)}-${(<FunctionDeclaration>component.fun).id?.name}-${componentLocation.start.line}-${componentLocation.start.column}-${componentLocation.end.line}-${componentLocation.end.column}`;
}

function getFunctionTokenFromVar(v: RepresentativeVar, f: FragmentState): FunctionToken | undefined {
    for (const token of f.getTokens(v)) {
        if (token instanceof FunctionToken) {
            return token;
        }
    }
    return undefined;
}

function locationInLocation(loc1: SourceLocation, loc2: SourceLocation): boolean {
    return loc1.filename === loc2.filename && loc1.start.index >= loc2.start.index
        && loc1.end.index <= loc2.end.index;
}

export async function analysisOneFile(file: string, sourceCodeAst: File): Promise<Solver> {
    let solver = new Solver();
    const a = solver.globalState;
    const d = solver.diagnostics;
    a.reachedFile(file);
    a.entryFiles.add(resolve(options.basedir, file));
    const moduleInfo = a.getModuleInfo(file);
    // initialize analysis state for the module
    solver.prepare();
    assert(sourceCodeAst);
    moduleInfo.loc = sourceCodeAst.program.loc!;
    a.filesAnalyzed.push(file);
    const fileSize = statSync(file).size;
    d.codeSize += fileSize;
    if (moduleInfo.packageInfo.isEntry)
        d.codeSizeMain += fileSize;
    else
        d.codeSizeDependencies += fileSize;

    const {globals, globalsHidden, moduleSpecialNatives, globalSpecialNatives} = buildNatives(solver, moduleInfo);
    a.globalSpecialNatives = globalSpecialNatives;

    // preprocess the AST
    preprocessAst(sourceCodeAst, moduleInfo, globals, globalsHidden);

    // traverse the AST
    writeStdOutIfActive("Traversing AST...");
    solver.fragmentState.maybeEscaping.clear();
    visit(sourceCodeAst, new Operations(file, solver, moduleSpecialNatives));

    // propagate tokens until fixpoint reached for the module
    await solver.propagate("main");

    if (options.alloc && options.widening) {
        // find escaping objects and add UnknownAccessPaths
        const escaping = findEscapingObjects(moduleInfo, solver);

        // widen escaping objects for this module
        widenObjects(escaping, solver);

        // propagate tokens (again) until fixpoint reached
        await solver.propagate("widening");
    }

    finalizeCallEdges(solver);
    solver.updateDiagnostics();
    return solver;
}

export function getObjProps(mainFragment: FragmentState): Map<Token, Map<string, Set<RepresentativeVar>>> {
    const objprops: Map<Token, Map<string, Set<RepresentativeVar>>> = new Map();
    for (const v of [...mainFragment.vars, ...mainFragment.redirections.keys()])
        if (v instanceof ObjectPropertyVar) {
            mapGetSet(mapGetMap(objprops, v.obj), v.prop).add(mainFragment.getRepresentative(v));
        }
    return objprops;
}

export function findModuleMap(mainFragment: FragmentState, objprops: Map<Token, Map<string, Set<RepresentativeVar>>>): Array<ObjectToken | ArrayToken> {
    // FIXME: if module map is empty?
    // FIXME: if module map is list? check jsecode
    // TODO: use the outermost one as the successor
    let modulesTokens: Array<ObjectToken | ArrayToken> = [];
    for (const [t, props] of objprops) {
        if (t instanceof ObjectToken) {
            let isModuleDict = true;
            for (const [, vs] of props) {
                for (let v of vs) {
                    if (v instanceof ObjectPropertyVar && v.accessor !== "normal")
                        continue
                    for (const func of mainFragment.getTokens(v)) {
                        if (!(isComponentToken(func) || func instanceof AccessPathToken)) {
                            isModuleDict = false;
                            break;
                        }
                    }
                    if (!isModuleDict) {
                        break;
                    }
                }
            }
            if (isModuleDict) {
                modulesTokens.push(t);
            }
        }
    }
    // for array type map
    for (const [t, props] of objprops) {
        let modules: Map<number, FunctionToken> = new Map();
        if (t instanceof ArrayToken) {
            let isModuleDict = true;
            for (const [k, vs] of props) {
                if (k === ARRAY_ALL || k === ARRAY_UNKNOWN)
                    continue;
                if (!isNumber(k)) {
                    isModuleDict = false;
                    break;
                }
                for (let v of vs) {
                    if (v instanceof ObjectPropertyVar && v.accessor !== "normal")
                        continue
                    for (const func of mainFragment.getTokens(v)) {

                        if (!(isComponentToken(func) || func instanceof AccessPathToken)) {
                            isModuleDict = false;
                            break;
                        } else if (isComponentToken(func)) {
                            modules.set(parseInt(k), func);
                        }
                    }
                }
                if (!modules.has(parseInt(k)))
                    isModuleDict = false;

                if (!isModuleDict) {
                    break;
                }
            }
            if (isModuleDict) {
                modulesTokens.push(t);
            }
        }
    }
    function locSpan(loc: SourceLocation): number {
        return loc.end.index - loc.start.index;

    }

    // sort by the length of the location
    const length = modulesTokens.length;
    for (let i = 0; i < length - 1; i++) {
        let bigIndex = i;
        for (let j = i + 1; j < length; j++) {
            if (locSpan(modulesTokens[j].allocSite.loc!) > locSpan(modulesTokens[bigIndex].allocSite.loc!)) {
                bigIndex = j;
            }
        }
        if (bigIndex !== i) {
            const temp = modulesTokens[i];
            modulesTokens[i] = modulesTokens[bigIndex];
            modulesTokens[bigIndex] = temp;
        }
    }

    return modulesTokens;
}

function getRequireCodeFromId(moduleId: string | number): string {
    if (typeof moduleId === "number")
        return `require('./${moduleId}.js')`;
    else {
        moduleId = moduleId.replaceAll("/", "_").replaceAll("+","__");
        if (!moduleId.startsWith("./")) {
            moduleId=`./${moduleId}`;
        }
        return `require('${moduleId}')`;
    }
}

function getRequireCodeFromPackage(predictPackage: FunctionPrototype): string {
    let requirePackageCode: string;
    if (predictPackage.functionName===BUNDLE_FUNCTION) {
        requirePackageCode = getRequireCodeFromId(predictPackage.packageName);
    } else if (predictPackage.functionFile === INDEX_JS) {
        if (predictPackage.functionName === MODULE_WRAPPER_FUNCTION) {
            requirePackageCode = `require('${predictPackage.packageName}')`;
        } else {
            requirePackageCode = `require('${predictPackage.packageName}').${predictPackage.functionName}`;
        }
    } else {
        if (predictPackage.functionName === MODULE_WRAPPER_FUNCTION) {
            requirePackageCode = `require('${predictPackage.packageName}/${predictPackage.functionFile}')`;
        } else {
            requirePackageCode = `require('${predictPackage.packageName}/${predictPackage.functionFile}').${predictPackage.functionName}`;
        }
    }
    return requirePackageCode;
}

function replaceRequireCallSites(replacer:ReplaceBlocker, scale: SourceLocation, requireCallSites: Map<Node, number | string>, knownPackages: Map<number | string | FunctionToken, FunctionPrototype>, ): void {
    for (const [callNode, moduleId] of requireCallSites) {
        if (locationInLocation(callNode.loc!, scale)) {
            let replaceCode: string;
            let predictPackage = knownPackages.get(moduleId);
            let requireCode = getRequireCodeFromId(moduleId);
            if (predictPackage) {
                let requirePackageCode = getRequireCodeFromPackage(predictPackage);
                if (SOUND_MODE) {
                    replaceCode = `${requireCode} || ${requirePackageCode}`;
                } else {
                    replaceCode = requirePackageCode;
                }
            } else {
                replaceCode = requireCode;
            }
            replacer.replaceBlock(codeFromLocation(callNode.loc!, -1), replaceCode);
            requireCallSites.delete(callNode);
        }
    }
}

function replaceRequireDcallsites(replacer:ReplaceBlocker, scale: SourceLocation, exportCallSites: Map<Node, [NodeVar, Map<string, Array<NodeVar>>]>, f: FragmentState): void {
    for (const [callNode, [firstArgNode, map]] of exportCallSites) {
        if (locationInLocation(callNode.loc!, scale)) {
            let codes: string[] = [];
            for (const [field, vs] of map) {
                if (vs.length > 0) {
                    if (f.hasToken(f.getRepresentative(firstArgNode), dummyExportToken))
                        codes.push(`exports.${field}=${vs.map(v => codeFromLocation(v.node.loc, -1)).join("||")}`);
                    else
                        codes.push(`${codeFromLocation(firstArgNode.node.loc, -1)}.${field}=${vs.map(v => codeFromLocation(v.node.loc, -1)).join("||")}`);
                }
            }
            if (codes.length > 0)
                replacer.replaceBlock(codeFromLocation(callNode.loc!, -1), `${codes.join(",")}`);
            exportCallSites.delete(callNode);
        }
    }
}

function replaceRequireNcallsites(replacer:ReplaceBlocker, scale: SourceLocation, requireDefaultCallSites: Map<Node, NodeVar>): void {
    for (const [callNode, v] of requireDefaultCallSites) {
        if (locationInLocation(callNode.loc!, scale)) {
            replacer.replaceBlock(codeFromLocation(callNode.loc!, -1), `(()=>{return ${codeFromLocation(v.node.loc, -1)}||${codeFromLocation(v.node.loc, -1)}.default})`);
            requireDefaultCallSites.delete(callNode);
        }
    }
}

function replaceRequireTcallsites(replacer:ReplaceBlocker, scale: SourceLocation, requireTcallsites: Map<Node, [NodeVar | ConstantVar, number]>) {
    for (const [callNode, [v, n]] of requireTcallsites) {
        if (locationInLocation(callNode.loc!, scale)) {
            let replaceCode: string;
            if (n & 1 && v instanceof ConstantVar) {
                replaceCode = getRequireCodeFromId(v.value);
            } else if (v instanceof NodeVar) {
                replaceCode = codeFromLocation(v.node.loc, -1);
            } else {
                continue;
            }
            if (n & 8 || n & 4 || n & 16) {
                replacer.replaceBlock(codeFromLocation(callNode.loc!, -1), replaceCode);
                requireTcallsites.delete(callNode);
                continue;
            } else if (n & 2) {
                replacer.replaceBlock(codeFromLocation(callNode.loc!, -1), `(${replaceCode}[Symbol.toStringTag]= 'Module', ${replaceCode}['__esModule']= true, ${replaceCode}['default']=${replaceCode}), ${replaceCode}`);
                requireTcallsites.delete(callNode);
            }
        }
    }
}

const beautyOpt = {
    indent_size: 2,
    space_in_empty_paren: true,
};

class DummyAP extends AccessPath {
    constructor(name: string) {
        super(name);
    }
}

let dummyRequireFunction = new AccessPathToken(new DummyAP("require"));
let dummyModuleToken = new AccessPathToken(new DummyAP("module"));
let dummyExportToken = new AccessPathToken(new DummyAP("export"));

export function buildModulesDict(modulesToken: AllocationSiteToken,
                          objprops: Map<Token, Map<string, Set<RepresentativeVar>>>,
                          mainFragment: FragmentState
) {
    let modulesDict = new Map();
    for (const [k, vs] of objprops.get(modulesToken) ?? new Map()) {
        if (k !== ARRAY_ALL && k !== ARRAY_UNKNOWN) {
            for (let v of vs) {
                for (const func of mainFragment.getTokens(v)) {
                    if (isComponentToken(func)) {
                        modulesDict.set(isNumber(k) ? parseInt(k) : k, func);
                    }
                }
            }
        }
    }
    return modulesDict;
}

// different callsites meanings are at https://github.com/webpack/webpack/blob/main/lib/RuntimeGlobals.js#L122
async function extractModulesFromModuleDict(moduleDict: Map<number | string, FunctionToken | ClassToken>,
                                            requireCallSites: Map<Node, number | string>,
                                            requireDcallsites: Map<Node, [NodeVar, Map<string, Array<NodeVar>>]>,
                                            requireNcallsites: Map<Node, NodeVar>,
                                            requireTcallsites: Map<Node, [NodeVar | ConstantVar, number]>,
                                            folderPath: string,
                                            knownPackages: Map<number | string | FunctionToken, FunctionPrototype>,
                                            f: FragmentState,
                                            failedFiles: string[],
                                            succeedFiles: string[],
                                            file: string,
                                            ignoreModules: Set<string|number>,
): Promise<boolean> {
    let success=true;
    for (let [fileNo, func] of moduleDict) {
        if (!SOUND_MODE && knownPackages.has(fileNo)) {
            if (func instanceof FunctionToken) {
                for (const [node,] of requireCallSites) {
                    if (locationInLocation(node.loc!, func.fun.body.loc!)) {
                        requireCallSites.delete(node);
                    }
                }
                for (const [node,] of requireDcallsites) {
                    if (locationInLocation(node.loc!, func.fun.body.loc!)) {
                        requireDcallsites.delete(node);
                    }
                }
                for (const [node,] of requireNcallsites) {
                    if (locationInLocation(node.loc!, func.fun.body.loc!)) {
                        requireNcallsites.delete(node);
                    }
                }
            }
            continue;
        }
        if (!SOUND_MODE && ignoreModules.has(fileNo))
            continue;
        if (func instanceof FunctionToken) {
            let code = codeFromLocation(func.fun.loc, -1);
            let replaceBlocker = new ReplaceBlocker(code);
            // code = code.substring(1, code.length - 1);
            replaceRequireCallSites(replaceBlocker, func.fun.loc!, requireCallSites, knownPackages);
            replaceRequireDcallsites(replaceBlocker, func.fun.loc!, requireDcallsites, f);
            replaceRequireNcallsites(replaceBlocker, func.fun.loc!, requireNcallsites);
            replaceRequireTcallsites(replaceBlocker, func.fun.loc!, requireTcallsites);
            let codeAST = parser.parse(`(${replaceBlocker.apply()})`);
            let funcAst = <ArrowFunctionExpression>(<ExpressionStatement>codeAST.program.body[0]).expression;
            // FIXME: can't replace export
            // let s = await analysisOneFile("moduleFunction.js", codeAST);
            // let moduleVar = s.fragmentState.varProducer.nodeVar(funcAst.params[0]);
            // let exportVar = s.fragmentState.varProducer.nodeVar(funcAst.params[1]);
            // let moduleToken = new ConstantVar("MODULE", "string");
            // let exportToken = new ConstantVar("EXPORT", "string");
            traverse(codeAST, {
                AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
                    if (path.node.left.type === "MemberExpression" && path.node.left.object.type === "Identifier") {
                        let node = path.node.left.object;
                        const binding = path.scope.getBinding(node.name);
                        if (binding) {
                            const bindingFunction = binding.scope.getFunctionParent()?.path?.node; // function where the identifier is declared, undefined if module scope
                            if (bindingFunction === funcAst) {
                                if (funcAst.params[0]) {
                                    if ((locationToString(funcAst.params[0].loc, false, true, false) !== locationToString(node.loc)) &&
                                        (locationToString(binding?.identifier.loc, false, true, false) === locationToString(funcAst.params[0].loc, false, true, false))) {
                                        path.node.left.object = t.identifier("module");
                                    }
                                }
                                if (funcAst.params[1])
                                    if (locationToString(funcAst.params[1].loc, false, true, false) !== locationToString(node.loc)
                                        && locationToString(binding?.identifier.loc, false, true, false) === locationToString(funcAst.params[1].loc, false, true, false)) {
                                        path.node.left.object = t.memberExpression(t.identifier("module"), t.identifier("exports"));
                                    }
                            }
                        }
                    }
                },
            });
            let body = (<ArrowFunctionExpression>(<ExpressionStatement>codeAST.program.body[0]).expression).body;
            let codeAst = t.file(t.program([isExpression(body) ? t.expressionStatement(body) : t.blockStatement([body])]));
            let genCode = generate(codeAst, {}).code;
            let [c, format] = transformCode(genCode);
            genCode = format === "js" ? beautify.js(c, beautyOpt) : c;
            let filename;
            if (typeof fileNo === "number")
                filename = `${folderPath}/${fileNo}.${format}`;
            else {
                fileNo = fileNo.replaceAll("/", "_").replaceAll("+","__");
                let filepath;
                if (fileNo.endsWith(".js")||fileNo.endsWith(".ts")||fileNo.endsWith(".tsx")||fileNo.endsWith(".jsx"))
                    filepath = `${folderPath}/${fileNo}`;
                else
                    filepath = `${folderPath}/${fileNo}.${format}`;
                const dir = path.dirname(filepath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, {recursive: true});
                }
                if (filepath.endsWith(".ts") || filepath.endsWith(".tsx"))
                    genCode = "// @ts-nocheck\n" + genCode;
                filename=filepath;
            }

            if (verifyLegalAst(genCode, filename)) {
                fs.writeFileSync(filename, genCode);
                succeedFiles.push(filename);
            } else {
                logger.error(`Generated code for ${filename} has illegal AST`);
                if (!fs.existsSync(failedDir)) {
                    fs.mkdirSync(failedDir, { recursive: true });
                }
                fs.writeFileSync(`${failedDir}/${path.basename(filename)}`,genCode);
                failedFiles.push(file);
                success = false;
            }
        } else {
            success = false;
            throw new Error("Not implemented class separation");
        }
    }
    return success;
}

function updateRequireGraph(requireGraph: Map<number | string | Node, Set<number | string>>,
                            callSiteNode: Node,
                            modulesToken: AllocationSiteToken,
                            modulesDict: Map<string | number, FunctionToken>,
                            value: string | number): void {
    if (locationInLocation(callSiteNode.loc!, modulesToken.allocSite.loc!)) {
        for (const [key, func] of modulesDict) {
            if (locationInLocation(callSiteNode.loc!, func.fun.loc!)) {
                mapGetSet(requireGraph, key).add(value);
            }
        }
    } else {
        mapGetSet(requireGraph, callSiteNode).add(value);
    }
}

function getFunctions(functionVar: NodeVar, fragment: FragmentState): [NodeVar[], Token[]] {
    let getFunctions = getTokensFromVar(functionVar, fragment);
    let values: NodeVar[] = []
    for (let getFunction of getFunctions) {
        if (getFunction instanceof FunctionToken) {
            let returnVar = fragment.varProducer.returnVar(getFunction.fun);
            let prev = Array.from(fragment.reverseSubsetEdges.get(fragment.getRepresentative(returnVar))!)[0];
            assert(prev instanceof NodeVar);
            values.push(prev);
        }
    }
    return [values, getFunctions];
}

interface UnbundleDiagnostics {
    mains: Array<string>,
    chunks: Array<string>,
    errors: Array<Error>,
    success: Array<number | string>,
    wrappers: Set<string>,
    functions: Set<string>,
    requireFunctionPredictedBy: "PatternMatching" | "Similarity" | "ML" |undefined,
    failedFiles: Array<string>,
}

let failedDir = `${options.debundleDir}-FAILED/`;
export async function unbundle(files: string[]): Promise<UnbundleDiagnostics> {
    options.maxIndirections = 1; // 1 is enough
    options.maxWaves = 20; // 10 is enough
    options.cycleElimination = false;
    options.patchEscaping = false;
    SOUND_MODE = options.soundMode;
    PREDICT = options.predict;
    failedDir = `${options.debundleDir}-FAILED/`;
    ML_PREDICT = options.machineLearning && options.predict;
    let requireFunctionPredictedBy:"PatternMatching"|"Similarity"|"ML"|undefined;

    let globalTimer = new Timer();
    const file2ast: Map<string, [File, Map<string, Node | Node[]>]> = new Map();
    const namespace2main: Map<string, string> = new Map();
    const mains: string[] = [];
    const chunks: string[] = [];
    const file2namespace: Map<string, string> = new Map();
    const namespace2modulesMap: Map<string, Map<string | number, FunctionToken>> =
        new Map<string, Map<string | number, FunctionToken>>();
    const namespace2requireGraph: Map<string, Map<number | string | Node, Set<number | string>>> = new Map(); // moduleA --Require-->moduleB
    const namespace2funcDependenceGraph: Map<string, Map<FunctionToken | string, Map<RepresentativeVar, FunctionToken | RepresentativeVar | number | string>>> = new Map();
    const idOrNode2file: Map<number | string | Node, string> = new Map();
    const namespace2separateFunctions: Map<string, Array<(p: Map<number | string | FunctionToken, FunctionPrototype>, ignore:Set<number|string>) => Promise<[boolean, string, string[]]>>> = new Map();
    const failedFiles: Array<string> = [];
    const files2raw: Map<string, string> = new Map();

    if (fs.existsSync(`${options.debundleDir!}-raw`)) {
        fs.rmSync(`${options.debundleDir!}-raw`, {recursive: true, force: true});
    }
    // collect webpacked files and their information like (main/chunk, namespace, ast, ...)
    const fileContents: Set<string> = new Set()
    for (const f of files) {
        let file = resolve(options.basedir, f);
        let fileContent = fs.readFileSync(file, "utf8");
        if (fileContents.has(fileContent)) {
            continue;
        }
        fileContents.add(fileContent);

        let [clz, ast, map] = isCompiledByWebpack(file);
        if (clz === "main") {
            let namespaceName;
            let patterns = [/(self|this)\["(webpack[A-Za-z0-9\-_]*)"]/, /(self|this)\.(webpack[A-Za-z0-9\-_]*)\s/]
            for (let p of patterns) {
                const matches = p.exec(codeFromLocation(ast!.loc!, -1));
                if (matches && matches.length > 0) {
                    namespaceName = matches[2];
                    break;
                }
            }
            if (!namespaceName) {
                logger.info("Namespace not found by pattern, use filename as namespace");
                namespaceName = extractFileName(file);
            }

            assert(namespace2main.get(namespaceName) === undefined, `Duplicate namespace ${namespaceName}, ${file} and ${namespace2main.get(namespaceName)}`);
            logger.info(`Namespace '${namespaceName}' found in main`);
            mains.push(file);
            file2namespace.set(file, namespaceName);
            file2ast.set(file, [ast!, map]);
        } else if (clz === "chunk") {
            let node = map.get("NAMESPACE")
            assert(node && !Array.isArray(node), `Cannot find namespace in chunk ${file}`);
            let namespaceName = codeFromLocation(node.loc!, -1).replaceAll("\"", "");
            logger.info(`Namespace '${namespaceName}' found in chunk`);
            chunks.push(file);
            file2namespace.set(file, namespaceName);
            file2ast.set(file, [ast!, map]);
        }
        if (clz === "main" || clz === "chunk") {
            if (f.includes("../"))
                continue;
            let filePath = `${options.debundleDir}-raw/${f}`;
            if (!fs.existsSync(path.dirname(filePath))) {
                fs.mkdirSync(path.dirname(filePath), {recursive: true});
            }

            let [ast,] = applyTransforms(fs.readFileSync(file, 'utf-8'), [sequence, splitvariabledecl]);
            fs.writeFileSync(filePath, beautify.js(generate(ast, {}).code, beautyOpt));
            files2raw.set(file, filePath);
        }
    }
    // analyze each file
    let file2Solver = new Map<string, Solver>();
    for (const [file, [ast,]] of file2ast) {
        file2Solver.set(file, await analysisOneFile(file, ast));
    }

    if (fs.existsSync(options.debundleDir!)) {
        fs.rmSync(options.debundleDir!, {recursive: true, force: true});
    }

    for (let [file, solver] of file2Solver) {
        globalTimer.checkTimeout();
        let namespace = file2namespace.get(file)!;
        const folderPath = `${options.debundleDir}/${namespace}`;
        if (!fs.existsSync(folderPath))
            fs.mkdirSync(folderPath, {recursive: true});
        if (mains.includes(file)) {
            // process main
            let mainFragment = solver.fragmentState;
            let [mainAst, matchedResult] = file2ast.get(file)!;
            namespace2main.set(namespace, file);
            /**
             * find require function and modules map
             */
            let funcAst = matchedResult.get(MATCHED_NODE);
            let modulesDict: Map<string | number, FunctionToken> | undefined = undefined;
            let modulesToken: ObjectToken | ArrayToken | undefined = undefined;
            let requireFunction: Function | undefined;
            let objprops = getObjProps(mainFragment);

            try {
                assert(funcAst && !Array.isArray(funcAst));
                requireFunction = findRequireFunctionByPatternMatching(mainFragment.a, funcAst);
                assert(requireFunction, "Cannot find require function");

                /**
                 * find modules map
                 */
                let modulesMapNode = matchedResult.get(MODULES_MAP);
                assert(modulesMapNode && !Array.isArray(modulesMapNode) && modulesMapNode.type === "Identifier");
                let possibleModulesMap: Array<Token> = [];
                let modulesMapVar: NodeVar | undefined = undefined;
                traverse(mainAst, {
                    Identifier(path: NodePath<Identifier>) {
                        if (path.node === modulesMapNode) {
                            const binding = path.scope.getBinding(path.node.name);
                            modulesMapVar = mainFragment.varProducer.nodeVar(binding?.identifier!);
                        }
                    }
                });

                assert(modulesMapVar, "Cannot find require token var");
                for (let t of mainFragment.getTokens(modulesMapVar)) {
                    if (t instanceof ObjectToken || t instanceof ArrayToken)
                        possibleModulesMap.push(t);
                }
                if (possibleModulesMap.length > 1) {
                    let modulesTokens = findModuleMap(mainFragment, objprops);
                    for (let i = 0; i < modulesTokens.length; i++) {
                        let m = modulesTokens[i];
                        if (possibleModulesMap.includes(m)) {
                            modulesToken = modulesTokens[i];
                        }
                    }
                    if (modulesToken) {
                        modulesDict = buildModulesDict(modulesToken, objprops, mainFragment);
                        requireFunctionPredictedBy = "PatternMatching";
                    } else {
                        throw new Error("Cannot find modules map(pointer & pattern matching phase)")
                    }
                } else if (possibleModulesMap.length === 1) {
                    modulesToken = <ObjectToken | ArrayToken>possibleModulesMap.pop()!;
                    modulesDict = buildModulesDict(modulesToken, objprops, mainFragment);
                    requireFunctionPredictedBy = "PatternMatching";
                } else {
                    throw new Error("Cannot find modules map(pointer & pattern matching phase)")
                }
            } catch (e) {
                if (!(modulesDict && modulesToken) && (PREDICT||PREDICT_REQUIRE)) {
                    let requireFunctionCandidate = findRequireFunctionBySimilarity(solver.globalState);
                    function verifyIsRequire(requireFunctionCandidate:Function) {
                        let context = prepareContext2(solver.fragmentState, requireFunctionCandidate);

                        let args = [];
                        for (let pid in requireFunctionCandidate.params) {
                            let p = requireFunctionCandidate.params[pid];
                            let pName = p.type === "Identifier" ? p.name : pid;
                            context.set(pName, "packageId");
                            args.push(pName);
                        }

                        let track: Array<ModuleEvent> = [];
                        let vm = new VM({}, context, (event) => {
                            track.push(event);
                        });
                        try {
                            let code = `(${codeFromLocation(requireFunctionCandidate.loc, -1)})`;
                            let codeAST = parser.parse(code, options);
                            traverse(codeAST, {
                                IfStatement(path: NodePath<t.IfStatement>) {
                                    path.node.test = t.booleanLiteral(false);
                                }
                            });
                            let transCodeAST = transformFunctionAst(codeAST);
                            let genCode = generate(transCodeAST, {}).code;
                            vm.run(`${genCode.replace(/;$/, '')}(${args.join(",")})`, "function.js");
                        } catch (e) {
                            logger.warn(`[PREDICT] Executing error in ${locationToStringWithFile(requireFunctionCandidate.loc)}, ${e}`);
                        }
                        let moduleVar: ConstraintVar | undefined;
                        for (let event of track) {
                            if (event.action === "CALL") {
                                const match = /^([a-zA-Z_$]*)\.packageId/.exec(event.value ?? "");
                                if (match) {
                                    let moduleIdStr = match[1];
                                    let funcInfo = solver.globalState.functionInfos.get(requireFunctionCandidate)!;
                                    for (const id of [...funcInfo.freeVarsRead]) {
                                        if (id.name === moduleIdStr) {
                                            moduleVar = solver.varProducer.nodeVar(id);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        if (moduleVar) {
                            let moduleTokenCandidate;
                            try {
                                moduleTokenCandidate = getTokenFromVar(moduleVar, mainFragment);
                            } catch (e) {
                                logger.error(`[VerifyIsRequire] Token size of moduleVar ${moduleVar} = ∅`);
                                return false;
                            }
                            if (moduleTokenCandidate && (moduleTokenCandidate instanceof ObjectToken || moduleTokenCandidate instanceof ArrayToken)) {
                                modulesToken = moduleTokenCandidate;
                                requireFunction = requireFunctionCandidate;
                                modulesDict = buildModulesDict(modulesToken, objprops, mainFragment);
                                return true;
                            }
                        }
                        return false;
                    }
                    let success = false;
                    if (requireFunctionCandidate) {
                        success = verifyIsRequire(requireFunctionCandidate);
                    }
                    if (success)
                        requireFunctionPredictedBy = "Similarity";
                    if (!success && ML_PREDICT) {
                        requireFunctionCandidate = await findRequireFunctionByML(solver.globalState);
                        if (requireFunctionCandidate)
                            verifyIsRequire(requireFunctionCandidate);
                        if (success)
                            requireFunctionPredictedBy = "ML";
                    }
                }
            }
            if (!(modulesDict && modulesToken && requireFunction)) {
                logger.error("Cannot find modules map")
                failedFiles.push(file);
                continue;
            }
            let nameSpaceModulesDict = mapGetMap(namespace2modulesMap, namespace);
            modulesDict.forEach((v, k) => {
                nameSpaceModulesDict.set(k, v);
                idOrNode2file.set(k, file);
            })
            for (const [, func] of modulesDict) {
                if (func.fun.params.length === 3) {
                    solver.addTokenConstraint(mainFragment.a.canonicalizeToken(new FunctionToken(requireFunction)), mainFragment.varProducer.nodeVar(func.fun.params[2]));
                }
                if (func.fun.params.length >= 2) {
                    solver.addTokenConstraint(mainFragment.a.canonicalizeToken(dummyExportToken), mainFragment.varProducer.nodeVar(func.fun.params[1]));
                }
                if (func.fun.params.length >= 1) {
                    solver.addTokenConstraint(mainFragment.a.canonicalizeToken(dummyModuleToken), mainFragment.varProducer.nodeVar(func.fun.params[0]));
                }
            }
            await solver.propagate("main");

            let funcQueue: FunctionToken[] = [];
            /**
             * build dependence graph
             */
            let funcDepsGraph: Map<FunctionToken | string, Map<RepresentativeVar, FunctionToken | RepresentativeVar | number | string>> = mapGetMap(namespace2funcDependenceGraph, namespace); // function -> freeVar -> another function  a moduleNumber, or a var

            // collect require call site(main)
            let requireDcallsites: Map<Node, [NodeVar, Map<string, Array<NodeVar>>]> = new Map();
            let requireNcallsites: Map<Node, NodeVar> = new Map();
            let requireTcallsites: Map<Node, [NodeVar | ConstantVar, number]> = new Map();
            let requireCallSites: Map<Node, number | string> = new Map();
            let requireGraph: Map<number | string | Node, Set<number | string>> = mapGetMap(namespace2requireGraph, namespace);

            for (const func of solver.globalState.outmostFunctions) {
                if (!locationInLocation(func.loc!, modulesToken.allocSite.loc!))
                    funcQueue.push(solver.globalState.canonicalizeToken(new FunctionToken(func)));
            }

            for (let [node, {calleeVar, argVars, caller, baseVar}] of mainFragment.callSites) {

                // TODO: use token ∈ variable instead!
                if (node.type === "CallExpression" && node.callee.type === "ParenthesizedExpression"
                    && node.callee.expression.type === "SequenceExpression"
                    && node.callee.expression.expressions.length === 2
                    && node.callee.expression.expressions[0].type === "NumericLiteral"
                    && node.callee.expression.expressions[1].type === "MemberExpression"
                    && node.callee.expression.expressions[1].property.type === "Identifier"
                    && node.callee.expression.expressions[1].property.name === "jsx"
                ) {
                    let componentVar = argVars[0];
                    if (componentVar && componentVar instanceof NodeVar) {
                        for (const component of mainFragment.getTokens(mainFragment.getRepresentative(componentVar))) {
                            // TODO: consider class token maybe?
                            if (component instanceof FunctionToken) {
                                funcQueue.push(component);
                                let m = mapGetMap(funcDepsGraph, component.fun.loc?.filename);
                                m.set(mainFragment.getRepresentative(componentVar), component);
                            }
                        }
                    }
                }
                let requireToken = mainFragment.a.canonicalizeToken(new FunctionToken(requireFunction));
                if (caller
                    && (mainFragment.functionParameters.get(caller)?.has(calleeVar) || mainFragment.hasToken(mainFragment.getRepresentative(calleeVar), requireToken))
                    && argVars.length === 1
                    && argVars[0] instanceof ConstantVar && (argVars[0].type === "number" || argVars[0].type === "string")) { // TODO: now only consider static require
                    requireCallSites.set(node, argVars[0].value);
                    updateRequireGraph(requireGraph, node, modulesToken, modulesDict, argVars[0].value);
                    idOrNode2file.set(node, file);
                }

                /**
                 * collect export function `require.d(export, {})`
                 */
                // TODO: more strong pattern for export function ( at least for similarity
                if (baseVar
                    && mainFragment.hasToken(mainFragment.getRepresentative(baseVar), requireToken)
                    && (calleeVar instanceof NodeVar && calleeVar.node.type === "MemberExpression" && calleeVar.node.property.type === "Identifier" && calleeVar.node.property.name === "d")
                    && argVars.length === 2
                    // && locationInLocation(node.loc!, modulesToken.allocSite.loc!)
                ) {
                    let exportDict = getTokenFromVar(argVars[1]!, mainFragment);
                    assert(exportDict instanceof ObjectToken);
                    for (let [exportField, functionVars] of objprops.get(exportDict) ?? new Map()) {
                        for (let functionVar of functionVars) {
                            let getFunctions = getTokensFromVar(functionVar, mainFragment);
                            let values: NodeVar[] = []
                            for (let getFunction of getFunctions) {
                                if (getFunction instanceof FunctionToken) {
                                    let returnVar = mainFragment.varProducer.returnVar(getFunction.fun);
                                    let prev = Array.from(mainFragment.reverseSubsetEdges.get(mainFragment.getRepresentative(returnVar))!)[0];
                                    assert(prev instanceof NodeVar);
                                    values.push(prev);
                                }
                            }
                            if (argVars[0] && argVars[0] instanceof NodeVar) {
                                let map: [NodeVar, Map<string, Array<NodeVar>>] = getOrSet(requireDcallsites, node, () => [<NodeVar>argVars[0], new Map<string, Array<NodeVar>>()]);
                                map[1].set(exportField, values);
                            }

                            // model require.d(export, { field: ()=>F }), F ⊆ ⟦export.field⟧
                            let repExportObjVar = mainFragment.getRepresentative(argVars[0]!);
                            for (let token of mainFragment.getTokens(repExportObjVar)) {
                                if (isObjectPropertyVarObj(token)) {
                                    let propVar = mainFragment.varProducer.objPropVar(token, exportField);
                                    for (let getFunction of getFunctions) {
                                        if (getFunction instanceof FunctionToken) {
                                            let returnVar = mainFragment.varProducer.returnVar(getFunction.fun);
                                            let prev = Array.from(mainFragment.reverseSubsetEdges.get(mainFragment.getRepresentative(returnVar))!)[0];
                                            assert(prev instanceof NodeVar);
                                            solver.addSubsetConstraint(prev, propVar);
                                        }
                                    }
                                }
                            }
                        }

                    }
                }
                // TODO: more strong pattern like the require function is ...
                if (baseVar
                    && mainFragment.hasToken(mainFragment.getRepresentative(baseVar), requireToken)
                    && (calleeVar instanceof NodeVar && calleeVar.node.type === "MemberExpression" && calleeVar.node.property.type === "Identifier" && calleeVar.node.property.name === "n")
                    && argVars.length === 1
                    && argVars[0] instanceof NodeVar
                ) {
                    requireNcallsites.set(node, argVars[0]);
                }

                if (baseVar
                    && mainFragment.hasToken(mainFragment.getRepresentative(baseVar), requireToken)
                    && (calleeVar instanceof NodeVar && calleeVar.node.type === "MemberExpression" && calleeVar.node.property.type === "Identifier" && calleeVar.node.property.name === "t")
                    && argVars.length === 2
                    && (argVars[0] instanceof NodeVar || argVars[0] instanceof ConstantVar)
                    && argVars[1] instanceof ConstantVar && argVars[1].type === "number"
                ) {
                    requireTcallsites.set(node, [argVars[0], <number>argVars[1].value]);
                }
            }


            while (funcQueue.length > 0) {
                let func = funcQueue.pop()!;
                if (funcDepsGraph.has(func))
                    continue;
                let funcInfo = mainFragment.a.functionInfos.get(func.fun)!;
                funcDepsGraph.set(func, new Map<RepresentativeVar, FunctionToken | RepresentativeVar | number>());
                if (funcInfo.freeVarsReadThis || funcInfo.freeVarsReadArguments)
                    continue;
                for (const id of [...funcInfo.freeVarsRead, ...funcInfo.freeVarsWrite]) {
                    let freeVar = mainFragment.getRepresentative(mainFragment.varProducer.nodeVar(id));
                    let prevs1 = Array.from(mainFragment.reverseSubsetEdges.get(freeVar) ?? []);
                    if (prevs1.length === 0) {
                        /* if free variable has a token and it doesn't have any previous variable,
                         * it has been analyzed so make that function token as dependency.
                         * if it doesn't have a token, it must haven't been analyzed yet, so make itself as dependency.
                         */
                        let depFun = getFunctionTokenFromVar(freeVar, mainFragment);
                        if (depFun) {
                            funcQueue.push(depFun);
                            mapGetMap(funcDepsGraph, func).set(freeVar, depFun);
                        } else {
                            /* no previous variable been analyzed yet or multiple previous variables
                                let z = -2;
                                function x {z};
                             */
                            mapGetMap(funcDepsGraph, func).set(freeVar, freeVar); // don't need to care about
                        }
                    } else if (prevs1.length > 1) {
                        // multiple previous variables, make itself as dependency (not sure if it's correct and we will ignore that later)
                        mapGetMap(funcDepsGraph, func).set(freeVar, freeVar);
                    } else {
                        let prev1 = prevs1[0]
                        let prevs2 = mainFragment.reverseSubsetEdges.get(prev1);
                        if (!prevs2) {
                            let depFun = getFunctionTokenFromVar(prevs1[0], mainFragment)
                            if (depFun) {
                                funcQueue.push(depFun);
                                mapGetMap(funcDepsGraph, func).set(freeVar, depFun);
                            } else {
                                mapGetMap(funcDepsGraph, func).set(freeVar, prev1);
                            }
                        } else if (prevs2.size !== 1) {
                            mapGetMap(funcDepsGraph, func).set(freeVar, prev1);
                        } else {
                            let prev2 = Array.from(prevs2)[0];
                            if (prev2 instanceof FunctionReturnVar && prev2.fun === requireFunction && prev1 instanceof NodeVar) {
                                let requireNumber = mainFragment.callSites.get(prev1.node)!.argVars[0];
                                if (requireNumber instanceof ConstantVar) {
                                    mapGetMap(funcDepsGraph, func).set(freeVar, <number>requireNumber.value);
                                } else {
                                    mapGetMap(funcDepsGraph, func).set(freeVar, prev2);
                                }
                            } else {
                                mapGetMap(funcDepsGraph, func).set(freeVar, prev2);
                            }
                        }
                    }

                }
            }

            let jsxFiles: Map<string, FunctionToken> = new Map(); // filename -> varName, functionString, outputFileName
            // TODO: take top level call function as well
            let [visitedOrder,] = nuutila(Array.from(funcDepsGraph.keys()).filter(e => e instanceof FunctionToken),
                (f) => Array.from((funcDepsGraph.get(f) ?? new Map()).values()).filter(e => e instanceof FunctionToken));
            let handledFunction: Set<FunctionToken> = new Set();

            await solver.propagate("extra patching");

            /**
             *
             * @param knownFunctions
             * return success, originalfile, succeed files, failed files,
             */
            let separateMain = async (knownFunctions: Map<number | string | FunctionToken, FunctionPrototype>, ignoreModules: Set<string|number>): Promise<[boolean,string, string[]]> => {
                let succeedFiles: string[] = [];
                let success = true;
                try {
                    // separate modules by module dict
                    let res = await extractModulesFromModuleDict(modulesDict!, requireCallSites, requireDcallsites, requireNcallsites, requireTcallsites, folderPath, knownFunctions, mainFragment, failedFiles, succeedFiles, file, ignoreModules);
                    if (!res)
                        success = false;


                    let predictedFunctions: Map<FunctionToken, FunctionPrototype> = new Map();
                    // separate components in main files
                    // TODO: disable THAT?
                    if (SPLIT_FUNCTION_IN_MAIN) {
                        function canBeSeparated(funcToken: FunctionToken | "root"): boolean {
                            let funcDeps = funcDepsGraph.get(funcToken) ?? new Map<RepresentativeVar, FunctionToken | RepresentativeVar | number>();
                            // only care about the first level function for now
                            if (funcToken instanceof FunctionToken && mainFragment.a.functionInfos.has(funcToken.fun) && mainFragment.a.functionInfos.get(funcToken.fun)!.inTopImmediateFunction && funcToken.fun.type === "FunctionDeclaration") {
                                for (const funcDep of funcDeps.values()) {
                                    // FIXME: ???
                                    if (funcDep instanceof FunctionToken) {
                                        if (!handledFunction.has(funcDep)) {
                                            return false;
                                        }
                                    } else if (!isNumber(funcDep)) {
                                        return false;
                                    }
                                }
                                return true;
                            }
                            return false;
                        }
                        for (const funcToken of visitedOrder) {
                            // TODO: only consider function token in main scope
                            let knownFunction = knownFunctions.get(funcToken);
                            if (!SOUND_MODE && knownFunction) {
                                predictedFunctions.set(funcToken, knownFunction);
                                handledFunction.add(funcToken);
                                // only consider unknown jsx functions
                                continue;
                            }
                            if (!canBeSeparated(funcToken)) {
                                if (knownFunction)
                                    predictedFunctions.set(funcToken, knownFunction);
                                continue;
                            }
                            handledFunction.add(funcToken);
                            let componentLocation = getComponentTokenLocation(funcToken);
                            let bundleFileName = componentLocation.filename;
                            jsxFiles.set(bundleFileName, funcToken);
                            let funcCode = codeFromLocation(componentLocation, -1);
                            let rep = new ReplaceBlocker(funcCode);
                            let code = "";
                            for (const [reqV, val] of funcDepsGraph.get(funcToken) ?? new Map<RepresentativeVar, FunctionToken | RepresentativeVar | number>()) {
                                let requireCode;
                                if (val instanceof FunctionToken) {
                                    requireCode = `require('./${getDebundedFileName(val)}.js')`
                                } else if (typeof val === "string" || typeof val === "number") {
                                    requireCode = getRequireCodeFromId(val);
                                }
                                if (val instanceof FunctionToken || typeof val === "string" || typeof val === "number") {
                                    let knownFunction = knownFunctions.get(val);
                                    let knownFunctionCode;
                                    if (knownFunction) {
                                        if (SOUND_MODE) {
                                            knownFunctionCode = getRequireCodeFromPackage(knownFunction);
                                            requireCode += `||${knownFunctionCode}`;
                                        } else {
                                            requireCode = getRequireCodeFromPackage(knownFunction);
                                        }
                                    }
                                }
                                code += `var ${(<Identifier>(<NodeVar><unknown>reqV).node).name} = ${requireCode};`
                            }
                            replaceRequireCallSites(rep, componentLocation, requireCallSites, knownFunctions);
                            // TODO: handle require
                            code += `module.exports=` + rep.apply();
                            let [c, format] = transformCode(code);
                            code = format === "js" ? beautify.js(c, beautyOpt) : c;
                            let filename = `${folderPath}/${getDebundedFileName(funcToken)}.${format}`;
                            fs.writeFileSync(filename, code);
                            succeedFiles.push(filename);
                        }
                    }


                    // rest of the main
                    let requireFile = requireFunction?.loc!.filename!;
                    let requireFunctionCode = codeFromLocation(requireFunction?.loc, -1);
                    let moduleDictCode: string | undefined = modulesToken ? codeFromLocation(modulesToken.allocSite.loc, -1) : undefined;

                    let mainCode = "";
                    let fileContext = fs.readFileSync(file, 'utf-8');
                    let replacer = new ReplaceBlocker(fileContext);
                    // replace require function
                    replacer.replaceBlock(fileContext, requireFunctionCode);
                    // replace modules map
                    if (moduleDictCode)
                        replacer.replaceBlock(moduleDictCode, "{}");
                    // replace known functions
                    let deletedFunctions: Function[] = []
                    for (let [funcToken, predictFunction] of predictedFunctions) {
                        let funcCode = codeFromLocation(funcToken.fun.loc, -1);
                        let code: string;
                        if (funcToken.fun.type === "FunctionDeclaration") {
                            if (SOUND_MODE) {
                                code = `var ${funcToken.fun.id!.name} = ${funcCode} || ${getRequireCodeFromPackage(predictFunction)};`;
                            } else {
                                code = `var ${funcToken.fun.id!.name} = ${getRequireCodeFromPackage(predictFunction)};`;
                            }
                        } else {
                            if (SOUND_MODE) {
                                code = `${funcCode} || ${getRequireCodeFromPackage(predictFunction)}`;
                            } else {
                                code = getRequireCodeFromPackage(predictFunction);
                            }
                        }
                        deletedFunctions.push(funcToken.fun);
                        replacer.replaceBlock(funcCode, code);
                    }
                    // TODO: replace known function at callsite(
                    for (let [node, {calleeVar,}] of mainFragment.callSites) {
                        if (calleeVar instanceof NodeVar && !locationInLocation(node.loc!, modulesToken?.allocSite.loc!)) {
                            let inDeletedFunction = false;
                            for (const deletedFunction of deletedFunctions) {
                                if (locationInLocation(node.loc!, deletedFunction.loc!)) {
                                    inDeletedFunction = true;
                                    break;
                                }
                            }
                            if (inDeletedFunction)
                                continue;

                            let tokens = mainFragment.getTokens(mainFragment.getRepresentative(calleeVar));
                            let predictedFunctions = Array.from(tokens)
                                .filter(t => t instanceof FunctionToken)
                                .map(t => knownFunctions.get(t) ?? undefined)
                                .filter(t => t !== undefined)
                                .map(t => getRequireCodeFromPackage(t));

                            if (predictedFunctions.length > 0) {
                                let requireCode;
                                let callNodeLocation = {
                                    start: {line: node.loc!.start.line, column: node.loc!.start.column},
                                    end: {line: node.loc!.end.line, column: node.loc!.end.column},
                                    filename: node.loc!.filename,
                                    module: (<Location>node.loc!).module,
                                };
                                callNodeLocation.start.column = Math.max(callNodeLocation.start.column - 7, 0);
                                callNodeLocation.end.column = Math.min(callNodeLocation.end.column + 7, fileContext.length);
                                let calleeVarString = codeFromLocation(calleeVar.node.loc, -1);
                                let callNodeString = codeFromLocation(callNodeLocation, -1);
                                // TODO the replace has problem
                                if (SOUND_MODE)
                                    requireCode = callNodeString.replace(calleeVarString, `(${[predictedFunctions, calleeVarString].join("||")})`);
                                else
                                    requireCode = callNodeString.replace(calleeVarString, `(${predictedFunctions.join("||")})`);
                                replacer.replaceBlock(callNodeString, requireCode);
                            }
                        }
                    }

                    // replace components in module dict with require
                    let scope = {
                        start: {line: 0, column: 0, index: 0},
                        end: {line: 999999, column: 999999, index: Infinity},
                        filename: requireFile,
                        identifierName: undefined,
                    }
                    replaceRequireCallSites(replacer, scope, requireCallSites, knownFunctions);
                    replaceRequireDcallsites(replacer, scope, requireDcallsites, mainFragment);
                    replaceRequireNcallsites(replacer, scope, requireNcallsites);
                    replaceRequireTcallsites(replacer, scope, requireTcallsites);

                    // replace inlined components with require
                    if (SPLIT_FUNCTION_IN_MAIN)
                        for (let [, component] of jsxFiles) {
                            // replace with a map.get function
                            replacer.replaceBlock(codeFromLocation(component.fun.loc, -1), `var ${(<FunctionDeclaration>component.fun).id?.name} = require('./${getDebundedFileName(component)}.js')`);
                        }
                    replacer.replaceBlock(codeFromLocation(requireFunction?.loc, -1), isFunctionDeclaration(requireFunction)?`function ${requireFunction.id?.name??"unknown"}(){}/*Replace require function*/`:`()=>{}`)
                    mainCode += replacer.apply();
                    let [c, format] = transformCode(mainCode);
                    mainCode = format === "js" ? beautify.js(c, beautyOpt) : c;
                    let filename = `${folderPath}/main.${format}`;
                    if (verifyLegalAst(mainCode, filename)) {
                        fs.writeFileSync(filename, mainCode);
                        succeedFiles.push(filename);
                    } else {
                        // TODO: FIX too much ast parse error
                        if (!fs.existsSync(failedDir)) {
                            fs.mkdirSync(failedDir, { recursive: true });
                        }
                        fs.writeFileSync(`${failedDir}/main.${format}`, mainCode);
                        failedFiles.push(file);
                        success = false;
                    }
                } catch (e) {
                    failedFiles.push(file);
                    success = false;
                    logger.error(`Error in separateMain: ${e instanceof Error ? e.stack : e}`);
                }
                return [success, file, succeedFiles];
            }
            mapGetArray(namespace2separateFunctions, namespace).push(separateMain);
        } else {
            // process chunk
            let success = true;
            let chunkFragment = solver.fragmentState;
            let [, m] = file2ast.get(file)!;
            let funcMapNode = m.get("RETURN");
            assert(funcMapNode && !Array.isArray(funcMapNode), `Function map not found`)

            let objprops = getObjProps(chunkFragment);
            let modulesTokens = findModuleMap(chunkFragment, objprops);
            let modulesToken: ObjectToken | ArrayToken | undefined;
            let modulesMap: Map<number | string, FunctionToken> | undefined;
            for (let i in modulesTokens) {
                let t = modulesTokens[i];
                if (t.allocSite === funcMapNode) {
                    modulesToken = t;
                    break;
                }
            }
            assert(modulesToken, "module dict not found");
            modulesMap = buildModulesDict(modulesToken, objprops, chunkFragment);
            if (modulesToken === undefined) {
                let specialPattern = `
                /.*/.push([
                    /.*/,
                    Array(#NUMBER:[0-9]+#).concat($RETURN$),
                ])
                `
                let [matched, resMap] = isSubTree(specialPattern, <Node>m.get(MATCHED_NODE)!, 2);
                if (matched) {
                    let startIdx = (<NumericLiteral>resMap!.get("NUMBER")).value;
                    modulesMap = new Map();
                    let elements = (<ArrayExpression>resMap?.get("RETURN")).elements;
                    modulesToken = solver.globalState.canonicalizeToken(new ObjectToken(<ArrayExpression>resMap?.get("RETURN")))
                    for (let i = 0; i < elements.length; i++) {
                        let f = elements[i];
                        if (f?.type === "FunctionExpression")
                            modulesMap.set(startIdx + i, solver.globalState.canonicalizeToken(new FunctionToken(f)));
                    }
                }

            }
            assert(modulesToken && modulesMap, "module dict not found");

            let nameSpaceModulesMap = mapGetMap(namespace2modulesMap, namespace);
            modulesMap.forEach((v, k) => {
                nameSpaceModulesMap.set(k, v);
                idOrNode2file.set(k, file);
            })
            for (const [, func] of modulesMap) {
                if (func.fun.params.length === 3) {
                    solver.addTokenConstraint(dummyRequireFunction, chunkFragment.varProducer.nodeVar(func.fun.params[2]));
                }
                if (func.fun.params.length >= 2) {
                    solver.addTokenConstraint(chunkFragment.a.canonicalizeToken(dummyExportToken), chunkFragment.varProducer.nodeVar(func.fun.params[1]));
                }
                if (func.fun.params.length >= 1) {
                    solver.addTokenConstraint(chunkFragment.a.canonicalizeToken(dummyModuleToken), chunkFragment.varProducer.nodeVar(func.fun.params[0]));
                }
            }
            await solver.propagate("main");
            // collect require call site(chunk)
            let requireCallSites: Map<Node, number | string> = new Map();
            let exportCallSites: Map<Node, [NodeVar, Map<string, Array<NodeVar>>]> = new Map();
            let requireDefaultCallSites: Map<Node, NodeVar> = new Map();
            let requireTcallsites: Map<Node, [NodeVar | ConstantVar, number]> = new Map();
            let requireGraph = mapGetMap(namespace2requireGraph, namespace);
            for (let [node, {calleeVar, argVars, caller, baseVar}] of chunkFragment.callSites) {
                // TODO: use token ∈ variable instead!
                if (caller
                    && (chunkFragment.functionParameters.get(caller)?.has(calleeVar) || chunkFragment.hasToken(chunkFragment.getRepresentative(calleeVar), dummyRequireFunction))
                    && argVars.length === 1
                    && argVars[0] instanceof ConstantVar && (argVars[0].type === "number" || argVars[0].type === "string")) { // TODO: now only consider static require
                    requireCallSites.set(node, argVars[0].value);
                    updateRequireGraph(requireGraph, node, modulesToken, modulesMap, argVars[0].value);
                    idOrNode2file.set(node, file);
                }
                // `require.export(export, {exportField: ()=>exportId})` to `exportField = exportId`
                // Or `require.export(export, "field", (()=>exportId))` to `exportField = exportId`
                if (baseVar
                    && chunkFragment.hasToken(chunkFragment.getRepresentative(baseVar), dummyRequireFunction)
                    && (calleeVar instanceof NodeVar && calleeVar.node.type === "MemberExpression" && calleeVar.node.property.type === "Identifier" && calleeVar.node.property.name === "d")) {
                    if (argVars.length === 2) {
                        let exportDicts = getTokensFromVar(argVars[1]!, chunkFragment);
                        if (exportDicts.length === 1) {
                            let exportDict = exportDicts[0];
                            assert(exportDict instanceof ObjectToken);
                            for (let [exportField, functionVars] of objprops.get(exportDict) ?? new Map()) {
                                for (let functionVar of functionVars) {
                                    // TODO: reuse the mainChunk code
                                    let [values, getFuncs] = getFunctions(functionVar, chunkFragment);
                                    if (argVars[0] && argVars[0] instanceof NodeVar) {
                                        let map: [NodeVar, Map<string, Array<NodeVar>>] = getOrSet(exportCallSites, node, () => [<NodeVar>argVars[0], new Map<string, Array<NodeVar>>()]);
                                        map[1].set(exportField, values);
                                    }

                                    // model require.d(export, { field: ()=>F }), F ⊆ ⟦export.field⟧
                                    if (0) {
                                        let repExportObjVar = chunkFragment.getRepresentative(argVars[0]!);
                                        for (let token of chunkFragment.getTokens(repExportObjVar)) {
                                            if (isObjectPropertyVarObj(token)) {
                                                let propVar = chunkFragment.varProducer.objPropVar(token, exportField);
                                                for (let getFunction of getFuncs) {
                                                    if (getFunction instanceof FunctionToken) {
                                                        let returnVar = chunkFragment.varProducer.returnVar(getFunction.fun);
                                                        let prev = Array.from(chunkFragment.reverseSubsetEdges.get(chunkFragment.getRepresentative(returnVar))!)[0];
                                                        assert(prev instanceof NodeVar);
                                                        solver.addSubsetConstraint(prev, propVar);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else if (argVars.length === 3) {
                        let exportField = argVars[1];
                        let exportFunctionVar = argVars[2];
                        if (exportField instanceof ConstantVar && exportField.type === "string" && exportFunctionVar instanceof NodeVar) {
                            let map: [NodeVar, Map<string, Array<NodeVar>>] = getOrSet(exportCallSites, node, () => [<NodeVar>argVars[0], new Map<string, Array<NodeVar>>()]);
                            let [values,] = getFunctions(exportFunctionVar, chunkFragment);
                            map[1].set(exportField.value as string, values);
                        }
                    }
                    // TODO: if dict as more than one token, provide export function
                }

                // for `let module = require.default(m)` to `let module = m||m.default`
                if (baseVar
                    && chunkFragment.hasToken(chunkFragment.getRepresentative(baseVar), dummyRequireFunction)
                    && (calleeVar instanceof NodeVar && calleeVar.node.type === "MemberExpression" && calleeVar.node.property.type === "Identifier" && calleeVar.node.property.name === "n")
                    && argVars.length === 1
                    && argVars[0] instanceof NodeVar
                ) {
                    assert(argVars[0] && argVars[0] instanceof NodeVar);
                    requireDefaultCallSites.set(node, argVars[0]);
                }

                if (baseVar
                    && chunkFragment.hasToken(chunkFragment.getRepresentative(baseVar), dummyRequireFunction)
                    && (calleeVar instanceof NodeVar && calleeVar.node.type === "MemberExpression" && calleeVar.node.property.type === "Identifier" && calleeVar.node.property.name === "t")
                    && argVars.length === 2
                    && (argVars[0] instanceof NodeVar || argVars[0] instanceof ConstantVar)
                    && argVars[1] instanceof ConstantVar && argVars[1].type === "number"
                ) {
                    requireTcallsites.set(node, [argVars[0], <number>argVars[1].value]);
                }
            }

            let separateChunk = async (knownPackages: Map<number | string | FunctionToken, FunctionPrototype>, ignoreModules: Set<string|number>): Promise<[boolean, string, string[]]> => {
                let succeedFiles: string[] = [];
                try {
                    let res = await extractModulesFromModuleDict(modulesMap, requireCallSites, exportCallSites, requireDefaultCallSites, requireTcallsites, folderPath, knownPackages, chunkFragment, failedFiles, succeedFiles, file, ignoreModules);
                    if (!res)
                        success = false;
                } catch (e) {
                    failedFiles.push(file);
                    logger.error("Error:" + (e instanceof Error ? e.stack : e));
                    success = false;
                }
                return [success, file, succeedFiles];
            }
            mapGetArray(namespace2separateFunctions, namespace).push(separateChunk);
        }
    }

    // predict modules
    let errors: Array<Error> = [];
    let success: Array<number | string> = [];
    let recognizedWrappers: Set<string> = new Set();
    let recognizedFunctions: Set<string> = new Set();
    async function separateNameSpaces(namespace:string, predictValues:Map<number | string | FunctionToken, FunctionPrototype>, ignoreModule:Set<number|string>) {
        for (let separate of namespace2separateFunctions.get(namespace)!) {
            let [succ, file, succeedFiles] = await separate(predictValues, ignoreModule);
            if (!succ) {
                handleError(file, succeedFiles);
            } else {
                // fix problem https://github.com/github/codeql/issues/18651
                const webpackConfigJs = `${options.debundleDir}/${namespace}/webpack.config.js`;
                if (fs.existsSync(`${options.debundleDir}/${namespace}`) && !fs.existsSync(webpackConfigJs)) {
                    fs.writeFileSync(webpackConfigJs, `module.exports = {};`)
                }
            }
        }
    }

    for (let [namespace, requireGraph] of namespace2requireGraph) {
        const predictValues: Map<number | string | FunctionToken, FunctionPrototype> = new Map();
        let [modulesInOrder,] = nuutila(requireGraph.keys(), (u) => requireGraph.get(u) ?? []);
        let modulesMap = namespace2modulesMap.get(namespace)!;
        let modules2code: Record<string, string> = {};
        for (const [moduleId, func] of modulesMap) {
            modules2code[String(moduleId)] = codeFromLocation(func.fun.loc, -1);
        }
        let moduleString = moduleMapToString(modules2code);

        let haveTime:boolean = PREDICT;
        // predict module wrapper
        for (let moduleId of modulesInOrder) {
            if (globalTimer.checkCloseToTimeout()) {
                haveTime = false;
            }
            let file = idOrNode2file.get(moduleId)!;
            let solver = file2Solver.get(file)!;

            if ((typeof moduleId === "number" || typeof moduleId === "string") && modulesMap.has(<string | number>moduleId)) {
                // solve transitive dependency, `module.export = require('xxx');`
                let func = modulesMap.get(moduleId)!.fun;
                if (func.body && isBlockStatement(func.body) && (
                    func.body.body.length===1 ||
                    (func.body.body.length===2 && isDirectiveLiteral(func.body.body[0])) // `'use strict'\n m.export=require(xxx)`
                )) {
                    let requiredModule = m.capture(m.or(m.stringLiteral(),m.numericLiteral()));
                    let callee:string;
                    if (func.params.length===3 && func.params[2].type === "Identifier") {
                        callee = func.params[2].name;
                    } else {
                        callee = "require";
                    }
                    let matcher = m.expressionStatement(m.assignmentExpression('=',
                        m.memberExpression(m.identifier(), m.identifier('exports')),
                        m.callExpression(m.identifier(callee), [requiredModule]))) // not require anymore
                    let expression = func.body.body.length===1?func.body.body[0]:func.body.body[1];
                    let result = matcher.match(expression);
                    if (result) {
                        let value = requiredModule.current!.value;
                        if (predictValues.has(value)) {
                            predictValues.set(moduleId, predictValues.get(value)!);
                        } else if (typeof value === 'string'){
                            predictValues.set(moduleId, {
                                packageName: value,
                                packageVersion: "0.0.1",
                                functionFile: INDEX_JS,
                                functionName: callee === "require" ? MODULE_WRAPPER_FUNCTION:BUNDLE_FUNCTION
                            });
                        }
                    }
                }
                if (haveTime && !predictValues.has(moduleId)) {
                    let funcContext = prepareContext(solver.fragmentState, func);
                    let funcContextStr = contextToString(funcContext);
                    let code = codeFromLocation(func.loc, -1)
                    let codeStr = codeToFile(code);
                    logger.info("Predicting module " + moduleId);
                    // let [functionProto, error] = await predictModuleNaive(
                    //         codeFromLocation(func.loc, -1),
                    //         modules2code, prepareContext(solver.fragmentState, func));
                    let functionProto, error;
                    try {
                        // @ts-ignore
                        [functionProto, error] = predictModuleNaiveWrapper(
                            codeStr,
                            moduleString,
                            funcContextStr,
                        )
                    } catch (e) {
                        logger.error(`Error in predictModuleNaiveWrapper: ${e instanceof Error ? e.stack : e}`);
                        continue;
                    }
                    if (functionProto) {
                        predictValues.set(moduleId, functionProto);
                        logger.info(`Predicted module ${moduleId} is ${JSON.stringify(functionProto)}`);
                        success.push(moduleId);
                        recognizedWrappers.add(functionProto.packageName);
                    } else if (error) {
                        if (error instanceof Error)
                            errors.push(error);
                    } else if (ML_PREDICT){
                        [functionProto, error] = await predictFunctionPrototypeByML(
                            code,
                            codeStr,
                            modulesMap.get(moduleId)!.fun,
                            true,
                            modules2code,
                            moduleString,
                            funcContext,
                            funcContextStr,
                        )
                        // FIXME: merge?
                        if (functionProto) {
                            predictValues.set(moduleId, functionProto);
                            logger.info(`Predicted(ML) module ${moduleId} is ${JSON.stringify(functionProto)}`);
                            success.push(moduleId);
                            recognizedWrappers.add(functionProto.packageName);
                        } else if (error) {
                            if (error instanceof Error)
                                errors.push(error);
                        }
                    }
                }
            }
        }
        // predict function
        if (ML_PREDICT && haveTime) {
            let funcDependenceGraph = namespace2funcDependenceGraph.get(namespace);
            if (funcDependenceGraph) {
                let main = namespace2main.get(namespace)!;
                let solver = file2Solver.get(main)!;
                let [modulesInOrder2, /*modules2repModules*/] = nuutila(funcDependenceGraph.keys(), (u) => funcDependenceGraph.get(u)?.values() ?? <any>[]);
                for (let i = modulesInOrder2.length - 1; i >= 0; i--) {
                    if (globalTimer.checkCloseToTimeout()) {
                        haveTime = false;
                    }
                    // globalTimer.checkTimeout();
                    let fun = modulesInOrder2[i];
                    if (fun instanceof FunctionToken && haveTime) {
                        logger.info(`Predicting function ${fun}`);
                        let context = prepareContext(solver.fragmentState, fun.fun);
                        let [functionProto,] = await predictFunctionPrototypeByML(
                            codeFromLocation(fun.fun.loc, -1),
                            codeToFile(codeFromLocation(fun.fun.loc, -1)),
                            fun.fun,
                            false,
                            modules2code,
                            moduleString,
                            context,
                            contextToString(context),
                        );
                        if (functionProto) {
                            logger.info(`Predicted function ${fun} is ${JSON.stringify(functionProto)}`);
                            predictValues.set(fun, functionProto);
                            recognizedFunctions.add(`${functionProto.packageName}::${functionProto.functionName}`)
                        }
                    }
                }
            }
        }
        // reverse require graph
        let allModules = new Set<string | number>();
        let reversedRequireMap = new Map<string | number, Set<string | number>>();
        for (let [node, deps] of requireGraph) {
            if (typeof node === "number" || typeof node === "string") {
                allModules.add(node);
                for (let dep of deps) {
                    if (!reversedRequireMap.has(dep))
                        reversedRequireMap.set(dep, new Set());
                    reversedRequireMap.get(dep)!.add(node);
                    allModules.add(dep);
                }
            }
        }

        let ignoreModules = new Set<string | number>();

        await separateNameSpaces(namespace, predictValues, ignoreModules);
    }

    if (!fs.existsSync(failedDir)) {
        fs.mkdirSync(failedDir, { recursive: true });
    }
    for (let file of failedFiles) {
        if (files2raw.get(file) && files2raw.get(file) && fs.existsSync(files2raw.get(file)!))
            fs.renameSync(files2raw.get(file)!, `${failedDir}/${path.basename(file)}`);
    }

    return {mains, chunks, errors, success, wrappers: recognizedWrappers, functions: recognizedFunctions, requireFunctionPredictedBy, failedFiles};

    function handleError(file:string, succeedFiles: string[]) {
        if (!fs.existsSync(failedDir)) {
            fs.mkdirSync(failedDir, { recursive: true });
        }
        if (files2raw.get(file))
            fs.renameSync(files2raw.get(file)!, `${failedDir}/${path.basename(file)}`);
        for (let f of succeedFiles) {
            fs.unlinkSync(f);
        }
    }

}

function getTokenFromVar(v: ConstraintVar, f: FragmentState): Token {
    let t = Array.from(f.getTokens(f.getRepresentative(v))).filter(t=>t instanceof AllocationSiteToken);
    assert(t.length === 1, `${v} a single token, but ${t.length}`);
    return t[0];
}

function getTokensFromVar(v: ConstraintVar, f: FragmentState): Token[] {
    return Array.from(f.getTokens(f.getRepresentative(v)));
}

function verifyLegalAst(code:string, file: string) {
    const options: ParserOptions = {
        sourceFilename: file,
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowSuperOutsideMethod: true,
        allowUndeclaredExports: true,
        errorRecovery: true,
        attachComment: false,
        createParenthesizedExpressions: true,
        sourceType: "unambiguous",
        tokens: true, // required for locations of artificial initializers for static computed class properties
        plugins: [
            "typescript",
            "exportDefaultFrom", // https://github.com/leebyron/ecmascript-export-default-from
            ["decorators", { decoratorsBeforeExport: false }] // TODO: decorators?
        ]
    };
    try {
        try {
            parse(code, options);
            return true;
        } catch (e) { // 'jsx' conflicts with TypeScript legacy cast syntax, see https://babeljs.io/docs/en/babel-plugin-transform-typescript/
            options.plugins!.push("jsx");
            if (file.endsWith(".jsx") || file.endsWith(".js")) {
                options.plugins!.push("flow");
                options.plugins!.splice(options.plugins?.indexOf("typescript")!, 1); // 'flow' conflicts with 'typescript'
            }
            parse(code, options);
            return true;
        }
    } catch (e) {
        logger.error(`Invalid AST after separation: ${file}, ${e instanceof Error? e.stack??"unknown":"unknown"}`);
        return false;
    }
}
