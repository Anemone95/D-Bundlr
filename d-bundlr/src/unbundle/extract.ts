import {options} from "../options";
import Solver from "../analysis/solver";
import {analyzeFiles} from "../analysis/analyzer";
import {SourceMapConsumer} from "source-map";
import fs from "fs";
import path from "path";
import {Function, Identifier} from "@babel/types";
import {getOrSet, locationToStringWithFile, mapGetSet} from "../misc/util";
import {codeFromLocation} from "../misc/files";
import logger from "../misc/logger";
import {parseAndDesugar} from "../parsing/parser";
import {isCompiledByWebpack} from "./checkcompiledbywebpack";
import {analysisOneFile, buildModulesDict, findModuleMap, getObjProps} from "./unbundle";
import assert from "assert";
import {ArrayToken, FunctionToken, NativeObjectToken, ObjectToken, Token} from "../analysis/tokens";
import {MODULES_MAP} from "./webpackfingerprint";
import {
    FunctionPrototype, getRealContext,
    INDEX_JS,
    MODULE_WRAPPER_FUNCTION,
    prepareContext,
} from "./verifypackageis";
import {NodeVar} from "../analysis/constraintvars";
import traverse, {NodePath} from "@babel/traverse";
import {DummyClass} from "../blended/sandbox/dummyclass";
import {transformFunctionAst} from "./functionAstTransform";
import generate from "@babel/generator";
import {ModuleEvent} from "../blended/sandbox/moduleevent";
import {VM} from "../blended/sandbox/webpackbox";

function extractName(f: Function) {
    if ("id" in f) {
        if (f.id && "name" in <any>f.id) {
            return (<any>f.id).name;
        }
    }
    if (f.loc?.filename.includes("webpack/runtime") || f.loc?.filename.includes("webpack/bootstrap")) {
        let s = f.loc?.filename.split("/").pop();
        if (s)
            return "__" + s.replaceAll(" ", "_") + "__";
    }
    return "anonymous";
}

export async function decodeSourceMap(file: string): Promise<SourceMapConsumer | undefined> {
    let sourceMapping;
    if (fs.existsSync(file + ".map")) {
        sourceMapping = JSON.parse(fs.readFileSync(file + ".map").toString());
    } else {
        const lines = fs.readFileSync(file).toString().split('\n');
        let match;
        // sourceMappingURL does not always stay in the end of the file.
        for (let i = lines.length - 10 < 0 ? 0 : lines.length - 10; i < lines.length; i++) {
            match = lines[i].match(/^\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,(.*)$/);
            if (match)
                break;
        }
        if (!match)
            return undefined;
        const base64 = match[1];
        const json = Buffer.from(base64, 'base64').toString('utf8');
        sourceMapping = JSON.parse(json);
    }
    return await new SourceMapConsumer(sourceMapping);
}

function stringToBase64(str: string): string {
    return Buffer.from(str).toString('base64');
}

export function locationInScope(loc: { line: number, column: number }, scope: {
    start: { line: number, column: number },
    end: { line: number, column: number }
}): boolean {
    if (loc.line < scope.start.line || loc.line > scope.end.line) {
        return false;
    }
    if (loc.line === scope.start.line && loc.column+1 < scope.start.column+1) {
        return false;
    }
    if (loc.line === scope.end.line && loc.column+1 > scope.end.column) {
        return false;
    }
    return true;
}

function locationInFunction(loc: {
    line: number,
    column: number,
    file?: string
}, functions: Array<Function>): Function | undefined {
    for (const func of functions) {
        let funcLoc = func.loc!;
        if (loc.file && path.resolve(path.normalize(loc.file)) !== func.loc?.filename)
            continue;
        if (loc.line < funcLoc.start.line || loc.line > funcLoc.end.line) {
            continue;
        }
        // source map column is 0-based, babel column is 1-based
        // babel function.start.column is also 0-based
        if (loc.line === funcLoc.start.line && loc.column+1 < funcLoc.start.column+1) {
            continue;
        }
        if (loc.line === funcLoc.end.line && loc.column+1 > funcLoc.end.column) {
            continue;
        }
        return func;
    }
    return undefined;
}

/**
 * Recursively search for a file
 * @param basePath Base directory path
 * @param relativeFilePath Relative path to the file
 * @param root Absolute path to the root directory; stop searching if parent of the root is reached
 * @returns Path of the found file or null if not found
 */
async function findFileRecursive(basePath: string, relativeFilePath: string, root: string): Promise<string | null> {
    let fullPath = path.join(basePath, relativeFilePath);
    let guess_dirs = ["dist", "lib", "build", "out", "bin", "target", "release"];
    for (let dir of guess_dirs) {
        if (basePath.includes(dir)) {
            let guess = fullPath.replace(dir, "src");
            if (fs.existsSync(guess)) {
                return guess;
            }
        }
    }

    // Check if the file exists at the given basePath and relativeFilePath
    if (fs.existsSync(fullPath)) {
        return fullPath;
    }

    // Get the parent directory of basePath
    const parentDir = path.dirname(basePath);

    // If the search has reached or exceeded the specified root directory or cannot go up further, return null
    if (parentDir === basePath || parentDir === path.dirname(root) || path.relative(root, parentDir).startsWith('..')) {
        return null;
    }

    fullPath = path.join(parentDir, relativeFilePath);
    if (fs.existsSync(fullPath)) {
        return fullPath;
    }

    // Read all subdirectories of the parent directory
    const subDirs = fs.readdirSync(parentDir, {withFileTypes: true})
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

    // Loop through each subdirectory to check for the file
    for (let dir of subDirs) {
        const subDirPath = path.join(parentDir, dir);
        const potentialPath = path.join(subDirPath, relativeFilePath);
        if (fs.existsSync(potentialPath)) {
            return potentialPath;
        }
    }

    // If the file is not found in any of the subdirectories, return null
    return findFileRecursive(parentDir, relativeFilePath, root);
}

export function ensureDirectoryExistence(filePath: string) {
    let dirname: string;
    try {
        dirname = path.dirname(filePath);
    } catch (e) {
        return;
    }
    if (fs.existsSync(dirname)) {
        return;
    }
    ensureDirectoryExistence(dirname);

    try {
        fs.mkdirSync(dirname);
    } catch (e) {
        return;
    }
}

function createFileInTmp(tmpDir: string, filepath: string, filecontent: string): string {
    const fullFilePath = path.join(tmpDir, filepath.replaceAll("../", "").replaceAll("\x00", ""));
    ensureDirectoryExistence(fullFilePath);

    fs.writeFileSync(fullFilePath, filecontent, 'utf8');
    return fullFilePath;
}

/**
 * Convert unix path to @package/file format
 * @param file
 */
function fileToPackageFile(file: string, root: string): string {
    let parentDir = file;

    function extractNameFromPath(pDir: string): string {
        let s = pDir.split('/');
        for (let i = 0; i < s.length; i++) {
            if (s[i].includes("#")) {
                return s[i].replace("#", "/") + "#private";
            }
        }
        return s[s.length - 1] + "#private";
    }

    while (true) {
        parentDir = path.dirname(parentDir);
        let packageJson = path.join(parentDir, "package.json");
        if (fs.existsSync(packageJson)) {
            let packageJsonContent = JSON.parse(fs.readFileSync(packageJson).toString());
            let packageName = packageJsonContent.name;
            let packageVersion = packageJsonContent.version;
            let relativePath = path.relative(parentDir, file);
            if (packageName === undefined) {
                return `${extractNameFromPath(parentDir)}!!!${relativePath}`;
            }
            return `${packageName}#${packageVersion}!!!${relativePath}`;
        }
        if (parentDir === root) {
            let relativePath = path.relative(parentDir, file);
            return `${extractNameFromPath(parentDir)}!!!${relativePath}`;
        }
    }
}

function functionToPrototype(func: Function, file: string, root: string): FunctionPrototype | undefined {
    let parentDir = file;
    while (true) {
        parentDir = path.dirname(parentDir);
        let packageJson = path.join(parentDir, "package.json");
        if (fs.existsSync(packageJson)) {
            let packageJsonContent = JSON.parse(fs.readFileSync(packageJson).toString());
            let packageName = packageJsonContent.name;
            let packageVersion = packageJsonContent.version;
            let relativePath = path.relative(parentDir, file);
            if (packageName === undefined) {
                return undefined;
            }
            if (relativePath === "index.js" || relativePath === "index.mjs") {
                relativePath = INDEX_JS;
            } else if (packageJsonContent.main && packageJsonContent.main.endsWith(relativePath))
                // TODO add more field to make as INDEX_JS
                relativePath = INDEX_JS;
            return {
                packageName,
                packageVersion,
                functionFile: relativePath,
                isEsModule: false,
                functionName: extractName(func)
            };
        }
        if (parentDir === root) {
            return undefined;
        }
    }
}

export async function extractSingle(compiledFile: string,
                                    originalRoot: string,
                                    outputDir: string,
                                    packageName: string,
                                    collectingFunctions?: Record<string, Array<any>>) {
    // TODO: collect all index file or require path

    // test if package is ESM
    let packageJson = fs.readFileSync(path.join(originalRoot, "node_modules", packageName, "package.json"), 'utf8');
    let packageJsonContent = JSON.parse(packageJson);
    let isESM: boolean = false;
    let _exports:Map<RegExp, string> = new Map();
    if (packageJsonContent.type && packageJsonContent.type === "module") {
        isESM = true;
    } else if (packageJsonContent.module) {
        isESM = true;
        _exports.set(new RegExp(`^${packageJsonContent.module}$`), ".");
    } else if (packageJsonContent.main) {
        if (packageJsonContent.main.endsWith(".mjs")) {
            isESM = true;
        }
        _exports.set(new RegExp(`^${packageJsonContent.main}$`), ".");
    }
    if (packageJsonContent.exports) {
        // This documentation is better than the NodeJS documentation: https://webpack.js.org/guides/package-exports/
        // TODO: negative patterns, e.g., {"./test/*": null}
        const queue: Array<[any, string]> = [[packageJsonContent.exports, "."]];
        while (queue.length > 0) {
            const [exp, p] = queue.pop()!;
            // TODO: consider * mark like: {"./lib/*", "./lib/*.js"}
            if (typeof exp === "string") {
                if (exp.startsWith("./")) {
                    let expPath =  new RegExp(exp !== "./" && exp.endsWith("/") ? `^${exp}` : `^${exp}$`);
                    _exports.set(expPath, p);
                }
                if (exp.endsWith(".mjs"))
                    isESM = true;
            } else if (Array.isArray(exp))
                for (let e of exp)
                    queue.push([e, p]);
            else if (exp === null)
                logger.warn("Warning: unsupported negative exports pattern found in package.json");
            else if (typeof exp === "object")
                for (let [k, v] of Object.entries(exp)){
                    queue.push([v, k]);
                }
            else {
                logger.warn(`Invalid export (${exp}) found in package.json`);
            }
        }
    }
    if (!isESM && packageJsonContent.main) {
        let content = fs.readFileSync(path.join(originalRoot, "node_modules", packageName, packageJsonContent.main), 'utf8');
        if (content.includes("export ")) {
            isESM = true;
        }
    }

    options.maxIndirections = 0; // 1 is enough
    options.maxWaves = 0; // 4 is enough
    options.cycleElimination = false;
    options.patchEscaping = false;
    const [, ast, matchedResult] = isCompiledByWebpack(compiledFile);
    assert(ast);
    let compiledSolver = await analysisOneFile(compiledFile, ast);
    let compiledFragment = compiledSolver.fragmentState;
    let objprops = getObjProps(compiledFragment);
    let possibleModulesMap: Array<Token> = [];
    let modulesMapVar: NodeVar | undefined = undefined;
    let modulesMapNode = matchedResult.get(MODULES_MAP);
    traverse(ast, {
        Identifier(path: NodePath<Identifier>) {
            if (path.node === modulesMapNode) {
                const binding = path.scope.getBinding(path.node.name);
                modulesMapVar = compiledFragment.varProducer.nodeVar(binding?.identifier!);
            }
        }
    });

    if (modulesMapVar)
        for (let t of compiledFragment.getTokens(modulesMapVar)) {
            possibleModulesMap.push(t);
        }
    let modulesDict: Map<string | number, FunctionToken> | undefined = undefined;
    let modulesToken: ObjectToken | ArrayToken | undefined = undefined;
    if (possibleModulesMap.length > 1) {
        let modulesTokens = findModuleMap(compiledFragment, objprops);
        for (let i = 0; i < modulesTokens.length; i++) {
            let m = modulesTokens[i];
            if (possibleModulesMap.includes(m)) {
                modulesToken = modulesTokens[i];
            }
        }
        modulesDict = buildModulesDict(modulesToken!, objprops, compiledFragment);
    } else if (possibleModulesMap.length === 1) {
        modulesToken = <ObjectToken | ArrayToken>possibleModulesMap.pop()!;
        modulesDict = buildModulesDict(modulesToken!, objprops, compiledFragment);
    } else {
        logger.info("Cannot find modules map(pointer & pattern matching phase)")
    }

    let compiledFunctionList = Array.from(compiledSolver.globalState.functionInfos.keys()).sort((a, b) => (a.loc!.end.index - a.loc!.start.index) - (b.loc!.end.index - b.loc!.start.index));
    let sourcemapFile2tmpFilepath: Map<string, string> = new Map<string, string>(); //webpackdir -> tmpdir/file
    let tmpFileToOriginal: Map<string, string> = new Map<string, string>(); // tmpdir/file -> originaldir/file
    let mapConsumer = await decodeSourceMap(compiledFile);
    const tmpDir = fs.mkdtempSync(path.join(outputDir, 'tmp-'));
    if ("sources" in <any>mapConsumer && "sourcesContent" in <any>mapConsumer) {
        let sourcesFiles: Array<string> = (<any>mapConsumer).sources;
        let sourcesContents: Array<string> = (<any>mapConsumer).sourcesContent;
        for (let i = 0; i < Math.min(sourcesFiles.length, sourcesContents.length); i++) {
            let oriFilename = sourcesFiles[i];
            let filename = oriFilename;
            if (filename.startsWith("webpack://")) {
                filename = filename.replace(/webpack:\/\/.*?\//, "");
            }
            let fileContent = sourcesContents[i];
            let filepath = createFileInTmp(tmpDir, filename, fileContent);
            sourcemapFile2tmpFilepath.set(oriFilename, filepath);
            tmpFileToOriginal.set(path.resolve(filepath), await findFileRecursive(path.dirname(compiledFile), filename, originalRoot) ?? `${originalRoot}/${filename}`);
        }
    } else {
        mapConsumer?.eachMapping(async (e) => {
            let originalFile = await findFileRecursive(compiledFile, e.source, originalRoot);
            if (originalFile && fs.existsSync(originalFile))
                sourcemapFile2tmpFilepath.set(e.source, originalFile);
            else
                logger.error(`${e.source} does not exist`);
        });
    }

    const originSolver = new Solver();
    await analyzeFiles(Array.from(sourcemapFile2tmpFilepath.values()), originSolver);
    let originalFunctionList = Array.from(originSolver.globalState.functionInfos.keys()).sort((a, b) => (a.loc!.end.index - a.loc!.start.index) - (b.loc!.end.index - b.loc!.start.index));
    // map: compiledFunction -> originalFunction*
    let compiledToOriginal: Map<Function, Set<Function>> = new Map();
    let original2Compiled: Map<string, Function> = new Map();
    let wrapperFunctions: Set<Function> = new Set();
    mapConsumer?.eachMapping((e) => {
        let source = e.source;
        if (!sourcemapFile2tmpFilepath.get(source))
            return;
        let originalFunction = locationInFunction({
            line: e.originalLine!,
            column: e.originalColumn!,
            file: sourcemapFile2tmpFilepath.get(source)
        }, originalFunctionList);
        let compiledLocation = {line: e.generatedLine!, column: e.generatedColumn!};
        if (modulesToken && originalFunction && locationInScope(compiledLocation, modulesToken.allocSite.loc!)) {
            // if it is a module wrapper function, find the function(func) that contains the location from modules dict, and add func -> original to the Map
            for (let [, func] of modulesDict??[]) {
                if (locationInScope(compiledLocation, func.fun.loc!)) {
                    mapGetSet(compiledToOriginal, func.fun).add(originalFunction);
                    wrapperFunctions.add(func.fun);
                    break;
                }
            }
        } else {
            let compiledFunction = locationInFunction({
                line: e.generatedLine!,
                column: e.generatedColumn!,
                file: compiledFile
            }, compiledFunctionList);
            if (originalFunction !== undefined && compiledFunction !== undefined) {
                mapGetSet(compiledToOriginal, compiledFunction).add(originalFunction!);
                let originalCode = codeFromLocation(originalFunction.loc!, -1);
                if (collectingFunctions) {
                    original2Compiled.set(originalCode, compiledFunction);
                }
            }
        }
    });

    let compiledFunctions = new Set();
    if (modulesDict)
        for (let e of modulesDict.values()) {
            compiledFunctions.add(e.fun);
        }
    // filter impossible mapping
    for (const [compiled, origins] of compiledToOriginal) {
        if (wrapperFunctions.has(compiled))
            continue;
        if (origins.size > 1) {
            if (compiledFunctions.has(compiled)) {
                let packages2num: Map<string, number> = new Map();
                for (const f of origins) {
                    let _package = fileToPackageFile(tmpFileToOriginal.get(f.loc!.filename)!, originalRoot);
                    let num = getOrSet(packages2num, _package, () => 0);
                    packages2num.set(_package, num + 1);
                }
                let maxKey: string | undefined = undefined;
                let maxValue: number = -Infinity;
                for (const [key, value] of packages2num) {
                    if (value > maxValue) {
                        maxValue = value;
                        maxKey = key;
                    }
                }
                for (const f of origins) {
                    if (fileToPackageFile(tmpFileToOriginal.get(f.loc!.filename)!, originalRoot) !== maxKey) {
                        origins.delete(f);
                        // original2Compiled.delete(codeFromLocation(f.loc!, -1));
                    }
                }
            } else {
                let compiledCode = codeFromLocation(compiled.loc!, -1);
                let compiledLen = compiledCode.length;
                for (const f of origins) {
                    let originCode = codeFromLocation(f.loc!, -1);
                    let originLen = originCode.length;
                    if (!(compiledLen * 0.2 < originLen && originLen < compiledLen * 10)) {
                        origins.delete(f);
                        original2Compiled.delete(originCode);
                    }
                }
                if (origins.size === 0) {
                    compiledToOriginal.delete(compiled);
                }
            }
        }
    }

    // consider re-export function: export * import "module"
    options.maxIndirections = 1; // 1 is enough
    options.maxWaves = 10; // 6 is enough
    options.library = true;
    options.basedir = originalRoot;
    const originSolver2 = new Solver();
    await analyzeFiles([`${originalRoot}/main.js`], originSolver2);
    let g = originSolver2.globalState;
    let f = originSolver2.fragmentState;
    let vp = f.varProducer;

    let oriObjprops = getObjProps(f);
    let funcStr2functionProto: Map<string, FunctionPrototype> = new Map();
    let exportField2Function = new Map<string, FunctionToken>();
    // must collect export functions
    // TODO collect class also?
    for (const [, m] of g.moduleInfos) {
        if (m.packageInfo.name === packageName) {
            let exportVar = f.getRepresentative(vp.objPropVar(g.canonicalizeToken(new NativeObjectToken("module", m)), "exports"))
            let defaultVar = f.getRepresentative(vp.objPropVar(g.canonicalizeToken(new NativeObjectToken("exports", m)), "default"))
            let tokens1 = f.getTokens(exportVar);
            let tokens2 = f.getTokens(defaultVar);
            for (const t of [...tokens1, ...tokens2]) {
                for (const [field, funcVars] of oriObjprops.get(t) ?? []) {
                    for (let funcVar of funcVars) {
                        let funcs = f.getTokens(funcVar);
                        for (const func of funcs) {
                            if (func instanceof FunctionToken) {
                                funcStr2functionProto.set(codeFromLocation(func.fun.loc, -1), {
                                    packageName: m.packageInfo.name,
                                    packageVersion: m.packageInfo.version ?? "latest",
                                    functionFile: INDEX_JS,
                                    // FIXME: read json to get that field
                                    isEsModule: isESM,
                                    functionName: field
                                });
                                if (collectingFunctions) {
                                    exportField2Function.set(field, func);
                                }
                            }
                        }
                    }
                }
            }
            break;
        }
    }

    const filePath: string = path.join(outputDir, path.basename(compiledFile) + ".csv");
    const writeStream: fs.WriteStream = fs.createWriteStream(filePath, {flags: 'w'});
    const jsonlPath: string = path.join(outputDir, path.basename(compiledFile) + ".jsonl");
    const jsonlStream: fs.WriteStream = fs.createWriteStream(jsonlPath, {flags: 'w'});
    let package2num: Map<string, number> = new Map();
    for (const [compiled, origins] of compiledToOriginal) {
        let originArr;
        if (!wrapperFunctions.has(compiled))
            originArr = Array.from(origins).filter(f => extractName(f) !== "anonymous");
        else
            originArr = Array.from(origins);
        let funcProtos: Array<[string, FunctionPrototype | undefined]> = originArr
            .map((f): [string, FunctionPrototype | undefined] =>
                [codeFromLocation(f.loc, -1), functionToPrototype(f, tmpFileToOriginal.get(f.loc!.filename)!, originalRoot)]
            )
            .filter(f => f[1] !== undefined)
            .map(f => {
                f[1]!["isEsModule"] = isESM;
                return f;
            });
        // TODO order the function into call order
        let record;
        let reexportProto;
        if (funcProtos.length > 0) {
            // TODO: use then outside function?
            let firstFunction = funcProtos[0][0];
            // if function belongs to inner but be import and export by the surface package, use that package information
            reexportProto = funcStr2functionProto.get(firstFunction);
        }
        if (wrapperFunctions.has(compiled)) {
            record = {
                code: codeFromLocation(compiled.loc!, -1),
                label: {
                    packageName: funcProtos[0][1]!.packageName,
                    packageVersion: funcProtos[0][1]!.packageVersion,
                    functionFile: INDEX_JS,
                    functionName: MODULE_WRAPPER_FUNCTION,
                    isEsModule: isESM,
                }
            }
        } else if (funcProtos.length === 1) {
            record = {
                code: codeFromLocation(compiled.loc!, -1),
                label: reexportProto ?? funcProtos[0][1]!
            }
        } else {
            let packages = new Set(funcProtos.map((f) => f[1]!.packageName));
            if (packages.size === 1) {
                record = {
                    code: codeFromLocation(compiled.loc!, -1),
                    label: reexportProto ?? funcProtos[0][1]!
                }
            }
        }

        if (record && record.label.functionName !== "anonymous" && record.code.length > 20) {
            jsonlStream.write(JSON.stringify(record) + "\n");
            writeStream.write(`${stringToBase64(record.code)},` +
                `ORIGINAL_CODE,` +
                `ORIGINAL_LOCATION,` +
                `${record.label.functionName},` +
                `${record.label.packageName}#${record.label.packageVersion}!!!${record.label.functionFile},` +
                `COMPILED_LOCATION\n`
            )
        }

        // collect original function
        for (let [funCode, label] of funcProtos) {
            let reexportProto = funcStr2functionProto.get(funCode);
            if (reexportProto) {
                label = reexportProto;
                if (!collectingFunctions)
                    funcStr2functionProto.delete(funCode);
            }
            let record = {
                code: funCode,
                label: label!
            };
            jsonlStream.write(JSON.stringify(record) + "\n");
            writeStream.write(`${stringToBase64(record.code)},` +
                `ORIGINAL_CODE,` +
                `ORIGINAL_LOCATION,` +
                `${record.label.functionName},` +
                `${record.label.packageName}#${record.label.packageVersion}!!!${record.label.functionFile},` +
                `COMPILED_LOCATION\n`
            )
        }

        // if exported function doesn't be recorded, record here (But why?)
        for (let [funCode, label] of funcStr2functionProto) {
            let record = {
                code: funCode,
                label: label!
            }
            jsonlStream.write(JSON.stringify(record) + "\n");
            writeStream.write(`${stringToBase64(record.code)},` +
                `ORIGINAL_CODE,` +
                `ORIGINAL_LOCATION,` +
                `${record.label.functionName},` +
                `${record.label.packageName}#${record.label.packageVersion}!!!${record.label.functionFile},` +
                `COMPILED_LOCATION\n`
            )
        }

        for (const f of originArr) {
            let _package = fileToPackageFile(tmpFileToOriginal.get(f.loc!.filename)!, originalRoot);
            let packageName = _package.split("/")[0];
            let num = getOrSet(package2num, packageName, () => 0);
            package2num.set(packageName, num + 1);
        }
    }

    // for making features of functions
    if (collectingFunctions) {
        if (!isESM) {
            logger.error("Not ESM package, forget about that");
            return;
        }
        for (const [field, func] of exportField2Function) {
            logger.info(`==== Collecting ${packageName}::${field} ====`)
            let funcAst = func.fun;
            let context = getRealContext(prepareContext(originSolver2.fragmentState, funcAst));

            // prepare arguments
            let args = [];
            if (collectingFunctions[field]) {
                for (let pid = 0; pid < Math.max(funcAst.params.length, collectingFunctions[field].length); pid++) {
                    let p = funcAst.params[pid];
                    let pName = p?p.type === "Identifier" ? p.name : String(pid): `arg${pid}`;
                    context.set(pName, DummyClass.getInstance(`arg${pid}`, collectingFunctions[field][pid]));
                    args.push(pName);
                }
            } else {
                for (let pid in funcAst.params) {
                    let p = funcAst.params[pid];
                    let pName = p.type === "Identifier" ? p.name : pid;
                    context.set(pName, DummyClass.getInstance(`arg${pid}`));
                    args.push(pName);
                }
            }
            let funcCode = codeFromLocation(funcAst.loc!, -1);
            if (funcCode.startsWith("get ") || funcCode.startsWith("set ")) {
                continue;
            }
            // let compiledFunc = original2Compiled.get(funcCode);
            let ast = parseAndDesugar(`(${funcCode})`, funcAst.loc!.filename);
            let codeAST = transformFunctionAst(ast!);
            let genCode = generate(codeAST, {}).code;
            let track: Array<ModuleEvent> = [];
            let vm = new VM({}, context, (event) => {
                track.push(event);
            });

            let returnValue;
            try {
                returnValue = vm.run(`${genCode.replace(/;$/,'')}.call(${args.join(",")})`, "function.js");
            } catch (e) {
                logger.error(`${field} throws an error: ${e}`);
            }
            logger.error("Track:");
            for (let s of track) {
                logger.error(`${s.value}`);
            }
            if (returnValue) {
                try {
                    logger.error(`Function ${field} returns a value: ${returnValue}`);
                } catch (e) {
                    logger.error(`Function ${field} returns a unformatable value`);
                }
            } else {
                logger.error("Function does not return a value");
            }
            logger.info(`==== Collected ${packageName}::${field} ====`)

            logger.info(`==== Verify function ${packageName}::${field} ====`)
            // FIXME
            // if (compiledFunc) {
            //     logger.info(`Compiled Code: ${codeFromLocation(compiledFunc.loc!, -1)}`)
            //     let context = prepareContext(compiledSolver.fragmentState, compiledFunc);
            //     let res = await verifyCodeIsFunction(codeFromLocation(compiledFunc.loc!, -1), compiledFunc, new Map(), context, {
            //             packageName: packageName,
            //             functionFile: INDEX_JS,
            //             functionName: field
            //         },
            //         true);
            //     if (collectingFunctions[field]) {
            //         if (res) {
            //             console.log("Verify result: ", res);
            //         } else {
            //             assert(false, `Verify failed at ${field}`);
            //         }
            //     } else
            //         console.log("Verify result(No specified input): ", res);
            // } else {
            //     logger.warn(`Cannot find compiled function for ${packageName}::${field}`);
            // }
            logger.info(`==== Verified function ${packageName}::${field} ====\n\n`)
        }
    }

    if (package2num && packageName === "react*") {
        let maxKey: string | undefined = undefined;
        let maxValue: number = -Infinity;

        for (const [key, value] of package2num) {
            if (value > maxValue) {
                maxValue = value;
                maxKey = key;
            }
        }

        const str = fs.readFileSync(compiledFile, "utf8"); // TODO: OK to assume utf8? (ECMAScript says utf16??)
        const ast = parseAndDesugar(str, compiledFile)!;

        let src = str;
        let srcAst = ast;

        if (compiledFile.includes(".production.")) {
            src = fs.readFileSync(compiledFile.replace(".production.", ".development."), "utf8"); // TODO: OK to assume utf8? (ECMAScript says utf16??)
            srcAst = parseAndDesugar(src, compiledFile)!;
        }

        writeStream.write(`${stringToBase64(`(export, module,require)=>{ ${str} }`)},` +
            ` ${stringToBase64(`${src}`)},` +
            ` ${locationToStringWithFile(srcAst.loc)},` +
            ` main,` +
            ` ${maxKey}:MAIN.js, ` +
            ` ${locationToStringWithFile(ast.loc)}\n`);
    }

    writeStream.end();
    fs.rmSync(tmpDir, {recursive: true, force: true});
}