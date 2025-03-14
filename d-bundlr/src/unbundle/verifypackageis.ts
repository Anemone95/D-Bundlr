import {preparePackageDir} from "./collectCodeMappingByCompile";
import fs from "fs";
import path from "path";
import {
    Function
} from "@babel/types";
import {VM} from "../blended/sandbox/webpackbox";
import {FragmentState} from "../analysis/fragmentstate";
import {DummyClass} from "../blended/sandbox/dummyclass";
import {ModuleEvent} from "../blended/sandbox/moduleevent";
import * as parser from "@babel/parser";
import generate from "@babel/generator";
import logger from "../misc/logger";
import {ParserOptions} from "@babel/parser";
import {PredictFunction, query} from "./predictpackage";
import {transformFunctionAst, transformModuleAst} from "./functionAstTransform";
import {assert} from "console";
import {strHash} from "../misc/util";
import {spawnSync} from 'child_process';
import {options} from "../options";

export const PACKAGE_DIR = "/tmp/jelly-predict"
export const MODULE_WRAPPER_FUNCTION = "MODULE_WRAPPER_FUNCTION";
export const BUNDLE_FUNCTION = "BUNDLE_FUNCTION";
export const LATEST_VERSION = "latest";
export const INDEX_JS = "index.js";
export interface FunctionPrototype {
    packageName: string;
    packageVersion: string;
    functionFile: string;
    functionName: string;
    isEsModule?: boolean;
}

// TODO use function prototype instead
let exportFeatures: Map<string, Set<string>> = new Map<string, Set<string>>([
    ["react", new Set(["Children", "Component", "Fragment", "Suspense", "useMemo", "useState", "useRef"])],
    ["react-dom", new Set(["createPortal", "createRoot", "render", "flushSync"])],
    ["scheduler", new Set(["unstable_wrapCallback", "unstable_shouldYield"])],
    ["react:cjs/react-jsx-runtime.production.min.js", new Set(["jsx", "createElement"])],
]);

interface FunctionFeature {
    input?: Array<any>,
    thiz?: any,
    sequence: Array<RegExp>,
    output?: (ret: any) => boolean,
    sequenceLength?: [number, number],
    bodyText?: RegExp,
}

let executeSequencesFeatures: Map<string, FunctionFeature> = new Map<string, FunctionFeature>([
    ["react-router-dom::useLocation", {sequence: [/.*\.useContext(.*)\.location/]}], // TODO: need stronger sequence
    ["react-router-dom::useNavigate", {sequence: [/.*\.useContext/, /.*\.useContext/, /.*\.useCallback/]}],
    ["query-string::parse", {
        input: ["?foo=bar"], sequence: [
            /arg0\.trim/,
            /.*\('foo=bar','='\)/,
            /.*\('.*\('foo=bar','='\)\.Symbol\.iterator2','.*'\)/,
            /.*\('foo=bar','='\)\.Symbol\.iterator2\(\)/,
        ], output: (ret: any) => {
            if (ret && typeof ret === "object") {
                let key = Object.keys(ret)[0];
                let val = ret[key].toString();
                return /.*\('foo=bar','='\)\.Symbol\.iterator1','.*'\)/.test(key) && /.*\('.*\('foo=bar','='\)\.Symbol\.iterator2',.*,.*\)/.test(val)
            }
            return false;
        }
    }],
    ["query-string::extract", {
        input: ["https://foo.bar?foo=bar"], sequence: [
            /.*\('arg0'\)\.indexOf\('\?'\)/,
            /.*\('arg0'\)\.slice\('01'\)/,
        ], output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg0'\)\.slice\('01'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["query-string::parseUrl", {
        input: ["https://foo.bar?foo=bar"], sequence: [
            /.*\('arg0','#'\)$/,
            /.*\('arg0','#'\)\.Symbol\.iterator1\.split\('\?'\)\.0$/,
            /.*\('arg0'\)$/,
            /.*\('.*\('arg0'\)','\[object Object]'\)$/,
        ], output: (ret: any) => {
            if (ret && typeof ret === "object") {
                let keys = Object.keys(ret);
                return keys.includes("url") && keys.includes("query");
            }
            return false;
        }
    }],
    ["query-string::pick", {
        input: ["https://foo.bar?foo=bar", ['foo']], sequence: [
            /.*\('arg0','\[object Object]'\)\.url$/,
            /.*\('arg0','\[object Object]'\)\.query$/,
            /.*\('arg0','\[object Object]'\)\.fragmentIdentifier$/,
            /.*\('.*\('arg0','\[object Object]'\)\.query','arg1'\)$/,
            /.*\('arg0','\[object Object]'\)\.query\(\)/,
        ], output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /^.*\('\[object Object]','\[object Object]'\)$/.test(ret.toString());
            }
            return false;
        }
    }],
    ["query-string::exclude", {
        input: ["https://foo.bar?foo=bar", ['foo']], sequence: [
            /.*\('arg0',.*=>.*\.includes\(.*\).*\)\)','undefined'\)$/,
        ], output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg0',.*=>.*\.includes\(.*\).*\)\)','undefined'\)$/.test(ret.toString());
            }
            return false;
        }
    }],
    ["throttle-debounce::throttle", {
        input: [8, (a: any) => a, {}],
        sequence: [
            /arg2\.noTrailing/,
            /arg2\.noLeading/,
            /arg2\.debounceMode/,
        ],
        output: (ret: any) => {
            return typeof ret === "function";
        }
    }],
    ["throttle-debounce::debounce", {
        input: [8, (a: any) => a, {}],
        sequence: [
            /.*\('arg0','arg1','\[object Object]'\)$/,
        ],
        sequenceLength: [1, 2],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg0','arg1','\[object Object]'\)$/.test(ret.toString());
            }
            return true;
        }
    }],
    ["react-final-form::Form", {
        sequence: [
            /arg0\.decorators/,
            /arg0\.destroyOnUnregister/,
            /arg0\.form/,
            /arg0\.initialValues/,
            /arg0\.initialValuesEqual/,
            /arg0\.keepDirtyOnReinitialize/,
            /arg0\.mutators/,
            /arg0\.onSubmit/,
            /arg0\.subscription/,
            /arg0\.validate/,
            /arg0\.validateOnBlur/,
            /.*.useState\(/,
            /.*.useEffect\(/,
            /arg0\.onSubmit\(\)/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\.createElement\('.*\.Provider',/.test(ret.toString());
            }
            return false;
        }
    }],
    ["mustache::render", {
        input: ["rend"],
        sequence: [
            /.*\.render\('arg0','undefined','undefined','undefined'\)/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\.render\('arg0','undefined','undefined','undefined'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b2a::btoa", {
        input: ["b/c+d&e:f;g?h@i#j$k,m%n"],
        sequence: [
            /.*\('b\/cString\.fromCharCode\("0x".*\)dString\.fromCharCode\("0x".*\)eString\.fromCharCode\("0x".*\)fString\.fromCharCode\("0x".*\)gString\.fromCharCode\("0x".*\)hString\.fromCharCode\("0x".*\)iString\.fromCharCode\("0x".*\)jString\.fromCharCode\("0x".*\)kString\.fromCharCode\("0x".*\)mString\.fromCharCode\("0x".*\)n'\)/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('b\/cString\.fromCharCode\("0x".*\)dString\.fromCharCode\("0x".*\)eString\.fromCharCode\("0x".*\)fString\.fromCharCode\("0x".*\)gString\.fromCharCode\("0x".*\)hString\.fromCharCode\("0x".*\)iString\.fromCharCode\("0x".*\)jString\.fromCharCode\("0x".*\)kString\.fromCharCode\("0x".*\)mString\.fromCharCode\("0x".*\)n'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b2a::atob", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /.*\('arg0'\)\.split\('undefined'\).map\('.*'\)\.join/,
            /global.decodeURIComponent\(/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /decodeURIComponent\(.*\('arg0'\)\.split\(.*\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b64-lite::atob", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [],
        output: (ret: any) => {
            return ret === "Hello world";
        }
    }],
    ["b64-lite::btoa", {
        input: ["hello world"],
        sequence: [],
        output: (ret: any) => {
            return "aGVsbG8gd29ybGQ=" === ret;
        }
    }],
    ["b64u::encode", {
        input: ["hello world"],
        sequence: [
            /global\.Buffer\.from\(hello world\)/,
            /.*\('aGVsbG8gd29ybGQ='\)/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('aGVsbG8gd29ybGQ='\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b64u::decode", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /global\.Buffer\.from\(.*\('arg0'\)\)/,
        ],
        output: (ret: any) => {
            if (typeof ret === 'string') {
                return /.*\('arg0'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b64u::toBase64", {
        input: ["SGVsbG8gd29ybGQ"],
        sequence: [
            /global.Buffer.alloc/,
        ],
        output: (ret: any) => {
            if (typeof ret === 'string') {
                return ret === "SGVsbG8gd29ybGQ=";
            }
            return false;
        }
    }],
    ["b64u::fromBase64", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /\.replace/,
        ],
        output: (ret: any) => {
            return "SGVsbG8gd29ybGQ" === ret;
        }
    }],
    ["b64u-lite::toBase64Url", {
        input: ["hi there?"],
        sequence: [],
        output: (ret: any) => {
            return "aGkgdGhlcmU_" === ret;
        }
    }],
    ["b64u-lite::toBinaryString", {
        input: ['aGkgdGhlcmU='],
        sequence: [],
        output: (ret: any) => {
            return ret === "hi there";
        }
    }],
    ["b64u-lite::fromBase64Url", {
        input: ["aGkgdGhlcmU="],
        sequence: [],
        output: (ret: any) => {
            return "hi there" === ret;
        }
    }],
    ["b64u-lite::fromBinaryString", {
        input: ["hi there? "],
        sequence: [],
        output: (ret: any) => {
            return "aGkgdGhlcmU_IA" === ret;
        }
    }],
    ["b64url::encode", {
        input: ["hello world"],
        sequence: [
            /global\.Buffer\.from\(hello world\)/,
            /.*\('aGVsbG8gd29ybGQ='\)/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('aGVsbG8gd29ybGQ='\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b64url::decode", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /global\.Buffer\.from\(.*\('arg0'\)\)/,
        ],
        output: (ret: any) => {
            if (typeof ret === 'string') {
                return /.*\('arg0'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["b64url::toBase64", {
        input: ["SGVsbG8gd29ybGQ"],
        sequence: [
            /global.Buffer.alloc/,
        ],
        output: (ret: any) => {
            if (typeof ret === 'string') {
                return ret === "SGVsbG8gd29ybGQ=";
            }
            return false;
        }
    }],
    ["b64url::fromBase64", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /\.replace/,
        ],
        output: (ret: any) => {
            return "SGVsbG8gd29ybGQ" === ret;
        }
    }],
    ["js-base64::encode", {
        input: ["arg", 1],
        sequence: [
            /.*\('.*\('arg0'\)'\)/
        ],
        sequenceLength: [2, 4],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('.*\('arg0'\)'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["js-base64::encodeURI", {
        input: ["arg"],
        sequence: [
            /.*\('arg0','true'\)/
        ],
        sequenceLength: [1, 1],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg0','true'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["js-base64::decode", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /.*\('.*\('arg0'\)'\)/
        ],
        sequenceLength: [2, 4],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('.*\('arg0'\)'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["react-native-base64::encode", {
        input: ["hello world"],
        sequence: [
            /arg0\.charCodeAt/
        ],
        output: (ret: any) => {
            return ret === "0000";
        }
    }],
    ["react-native-base64::decode", {
        input: ["SGVsbG8gd29ybGQ="],
        sequence: [
            /arg0\.replace/
        ],
        bodyText: /invalid base64 characters/,
        output: (ret: any) => {
            return typeof ret === "string";
        }
    }],
    ["react-native-base64::encodeFromByteArray", {
        input: [new Uint8Array([1, 2, 3])],
        sequence: [
            /arg0\.0\.valueOf/,
            /arg0\.1\.valueOf/,
            /arg0\.2\.valueOf/,
        ],
        output: (ret: any) => {
            return ret === "0000";
        }
    }],
    ["entities::encodeXML", {
        input: ["&#38;"],
        sequence: [
            /.*\.exec\('arg0'\)\.index/,
            /arg0\.charCodeAt/,
            /arg0\.substring/,
            /arg0\.substr/,
        ],
        output: (ret: any) => {
            return ret === "0#38;";
        }
    }],
    ["entities::encodeHTML", {
        input: ["&#38;"],
        sequence: [
            /.*\(.*,'arg0'\)/,
            /.*\(\)/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('.*','arg0'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["preact::Component", {
        input: ["a0", "a1"],
        thiz: DummyClass.getInstance("This"),
        sequence: [
            /arg0\.props=a0/,
            /arg0\.context=a1/,
        ],
        sequenceLength: [11, 13],
        output: (ret: any) => {
            return ret === undefined;
        }
    }],
    ["react-redux::connect", {
        sequence: [
            /.*\('arg1'\)/,
            /arg1\(\)/,
            /.*\('arg2'\)/,
            /arg2\(\)/,
            /.*\('3'.*\)/,
        ],
        output: (ret: any) => {
            // TODO: call that function and check?
            return typeof ret === 'function';
        }
    }],
    ["printj::sprintf", {
        input: ["hello %s!", "world"],
        sequence: [
            /.*\('arg1'\)/,
            /.*\('.*\('arg1'\)',','\)/,
            /.*\('arg1'\)\(\)/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('.*\('arg1'\)',','\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["printj::vsprintf", {
        input: ["hello %s!", ["world"]],
        sequence: [
            /.*\('arg1'\)/,
            /.*\('.*\('arg1'\)',','\)/,
            /.*\('arg1'\)\(\)/,
        ],
        output: (ret: any) => {
            // TODO: call that function and check?
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('.*\('arg1'\)',','\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["change-case::camelCase", {
        input: ["TWO_WORDS"],
        sequence: [
            /.*\('arg1','undefined'\)/,
            /.*\('.*\('undefined'\)','.*\('undefined'\)'\)/,
            /.*\('arg1','undefined'\)\.Symbol\.iterator2\.map\(.*\)\.join\('undefined'\)/,
        ],
        output: (ret: any) => {
            return ret === "000";
        }
    }],
    ["change-case::capitalCase", {
        input: ["TWO_WORDS"],
        sequence: [
            /.*\('arg1','undefined'\)/,
            /.*\('.*\('undefined'\)','.*\('undefined'\)'\)/,
            /.*\('arg1','undefined'\)\.Symbol\.iterator2\.map\(.*\)\.join\('\s'\)/,
        ],
        output: (ret: any) => {
            return ret === "000";
        }
    }],
    ["change-case::sentenceCase", {
        input: ["TWO_WORDS"],
        sequence: [
            /.*\('arg1','undefined'\)/,
            /.*\('.*\('undefined'\)','.*\('undefined'\)'\)/,
            /.*\('arg1','undefined'\)\.Symbol\.iterator2\.map\(.*\)\.join\('\s'\)/,
        ],
        output: (ret: any) => {
            return ret === "000";
        }
    }],
    ["change-case::snakeCase", {
        input: ["TWO_WORDS"],
        sequence: [
            /.*\('arg1','\[object Object]'\)/,
            /arg1\(\)/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg1','\[object Object]'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["change-case::trainCase", {
        input: ["TWO_WORDS"],
        sequence: [
            /.*\('arg1','\[object Object]'\)/,
            /arg1\(\)/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg1','\[object Object]'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["es-cookie::set", {
        input: ["key", "value"],
        sequence: [
            /document.cookie=.*\('arg0','arg1','arg2'\)/,
        ],
        output: (ret: any) => {
            return ret===undefined;
        }
    }],
    ["es-cookie::get", {
        input: ["keyyyyy", "value"],
        sequence: [
            /.*\(''\)\.keyyyyy/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\(''\)\.keyyyyy/.test(ret.toString());
            }
            return false;
        }
    }],
    ["es-cookie::parse", {
        input: ["c=v; name=value"],
        sequence: [
            /arg0\.split/,
            /o\.slice\(1\)\.join\("="\)\.0/,
        ],
        output: (ret: any) => {
            if (ret && typeof ret === 'object') {
                return ret['c'] && ret['c']==='v';
            }
            return false;
        }
    }],
    ["es-cookie::encode", {
        input: ["c", "v", {secure: true}],
        sequence: [
            /.*\('Expires','undefined'\)/,
            /.*\('Domain','undefined'\)/,
            /.*\('Path','undefined'\)/,
            /.*\('Secure','true'\)/,
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*=v000000/.test(ret.toString());
            }
            return false;
        }
    }],
    ["socket.io-client::io", {
        input: ["http://google.com"],
        sequence: [
            /.*\('arg0'\)\.port/,
            /.*\('arg0'\)\.path/,
            /.*\('arg0'\)\.host\.indexOf\(':'\)/,
            /.*\('arg0'\)\.href=0:\/\/\[0]:0/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\.socket\('.*\('arg0'\)\.path','arg1'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["socket.io-client::connect", {
        input: ["http://google.com"],
        sequence: [
            /.*\('arg0'\)\.port/,
            /.*\('arg0'\)\.path/,
            /.*\('arg0'\)\.host\.indexOf\(':'\)/,
            /.*\('arg0'\)\.href=0:\/\/\[0]:0/
        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\.socket\('.*\('arg0'\)\.path','arg1'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["query-string::extract", {
        input: ["?foo=bar"],
        sequence: [
            /.*\('arg0'\)\.indexOf\('\?'\)/,

        ],
        output: (ret: any) => {
            if (ret[DummyClass.IS_DUMMY]) {
                return /.*\('arg0'\)\.slice\('01'\)/.test(ret.toString());
            }
            return false;
        }
    }],
    ["query-string::parse", {
        input: ["?foo=bar"],
        sequence: [
            /.*\('foo=bar','='\)\.Symbol\.iterator1\(\)/
        ],
        output: (ret: any) => {
            if (ret && typeof ret === 'object') {
                let retKeys = Object.keys(ret);
                return retKeys.length > 0 && retKeys[0].endsWith("'foo=bar','=').Symbol.iterator1','arg1')");
            }
            return false;
        }
    }],
]);

const parseOptions: ParserOptions = {
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
        "exportDefaultFrom", // https://github.com/leebyron/ecmascript-export-default-from
        ["decorators", {decoratorsBeforeExport: false}] // TODO: decorators?
    ]
};
let blackListPackage: Set<string>= new Set();

export function prepareContext2(fragmentState: FragmentState, func: Function): Map<string, any> {
    let context: Map<string, any> = new Map();
    let funcInfo = fragmentState.a.functionInfos.get(func)!;
    if(!funcInfo) {
        // FIXME: why no function info???
        return context;
    }
    for (const id of [...funcInfo.freeVarsRead, ...funcInfo.freeVarsWrite]) {
        context.set(id.name, DummyClass.getInstance(id.name));
    }
    return context;
}

export function prepareContext(fragmentState: FragmentState, func: Function): Record<string, string> {
    let context: Record<string, string> = {};
    let funcInfo = fragmentState.a.functionInfos.get(func)!;
    if(!funcInfo) {
        // FIXME: why no function info???
        return context;
    }
    for (const id of [...funcInfo.freeVarsRead, ...funcInfo.freeVarsWrite]) {
        context[id.name]= id.name;
    }
    return context;
}

function matchedSeq(seq: Array<RegExp>, track: Array<ModuleEvent>): boolean {
    let curTrack = 0;
    let curSeq = 0;
    while (true) {
        if (curTrack >= track.length || curSeq >= seq.length)
            break;
        let trackValue = track[curTrack].value;
        let seqPattern = seq[curSeq];
        if (trackValue && seqPattern.test(trackValue)) {
            curSeq++;
        }
        curTrack++;
    }
    return curSeq === seq.length
}

export async function predictFunctionPrototypeByML(code:string, codeStr:string, func: Function, isModuleWrap: boolean, moduleMap: Record<string | number, string>, moduleMapString: ModuleMapString, context: Record<string, string>, contextString: ContextString): Promise<[FunctionPrototype | undefined, Error | unknown | undefined]> {
    if (isModuleWrap) {
        let mlPreds: Array<PredictFunction>;
        try {
            mlPreds = await query(code, 3);
        } catch (e) {
            mlPreds = []
        }
        let error = undefined;
        for (const [index, pred] of mlPreds.entries()) {
            const pkg = pred["function"];
            if ( pred["confidence"]>0.6 && pkg["functionName"] === MODULE_WRAPPER_FUNCTION && !blackListPackage.has(pkg["packageName"])) {
                let res, actual, exp;
                try {
                    // [res, actual, exp] = verifyCodeIsPackage(code, moduleMap, context, pkg["packageName"]);
                    [res, actual, exp] = verifyCodeIsPackageWrapper(codeStr, moduleMapString, contextString, pkg["packageName"]);
                } catch (e) {
                    error = e;
                    blackListPackage.add(pkg.packageName)
                    continue;
                }
                if (res >= 0.8 ) {
                    logger.info(`[PREDICT] Predicted package: ${pkg["packageName"]}, because actual fields are ${Array.from(actual).join(",")} and expected fields are ${Array.from(exp).join(",")}, confidence: ${res}, index: ${index}`);
                    return [{
                        packageName: pkg["packageName"],
                        packageVersion: LATEST_VERSION,
                        functionFile: pkg["functionFile"],
                        functionName: pkg["functionName"]
                    }, undefined];
                }
            }
        }
        return [undefined, error];
    } else {
        // let code = codeFromLocation(func.loc, -1);
        if (code.startsWith("class"))
            return [undefined, undefined];
        let mlPreds: Array<PredictFunction>;
        try {
            mlPreds = await query(code, 5);
        } catch (e) {
            mlPreds = []
        }
        let args = []
        for (let pid in func.params) {
            let p = func.params[pid];
            let pName = p.type === "Identifier" ? p.name : `arg${pid}`;
            args.push(pName);
        }

        for (const pred of mlPreds) {
            let predFunc = pred["function"];
            if (predFunc["functionName"] !== MODULE_WRAPPER_FUNCTION) {
                try {
                    // let isFunction = await verifyCodeIsFunction(code, moduleMap, context, args, predFunc);
                    let isFunction = verifyCodeIsFunctionWrapper(codeStr, moduleMapString, contextString, args, predFunc);
                    if (isFunction) {
                        logger.info(`[PREDICT] Predicted function(ML): ${JSON.stringify(predFunc)}`);
                        return [{
                            packageName: predFunc["packageName"],
                            packageVersion: LATEST_VERSION,
                            functionFile: INDEX_JS,
                            functionName: predFunc["functionName"]
                        }, undefined];
                    }
                } catch (e) {
                    return [undefined, e];
                }
            }
        }
    }
    return [undefined, undefined];
}


/**
 * deprecated, use predictFunctionPrototypeByML instead
 * @param funcStr
 */
export function predictModuleNaive(funcStr: string, moduleMap: Record<string, string>, context: Record<string, string>): [FunctionPrototype | undefined, string | unknown | undefined] {
    let realContext = getRealContext(context);
    let vm = new VM(moduleMap, realContext, () => {
    });
    let exportObject;
    try {
        let codeAst = parser.parse(`(${funcStr})(module, module.exports, require), module.exports`);
        let codeAst2 = transformModuleAst(codeAst);
        let genCode = generate(codeAst2, {}).code;
        exportObject = vm.run(genCode, "index.js");
    } catch (e) {
        console.error(e instanceof Error?e.stack:e);
        // FIXME: debug
        return [undefined, e instanceof Error?e.stack:e];
    }
    if (!exportObject) {
        return [undefined, "No export object"];
    }
    let fields: Set<string> = new Set(Object.keys(exportObject));
    for (let [pkg, features] of exportFeatures) {
        if (fields.intersection(features).size > 0) {
            let [pkgName, file] = pkg.split(":");
            return [{
                packageName: pkgName,
                packageVersion: LATEST_VERSION,
                functionFile: file ?? INDEX_JS,
                functionName: MODULE_WRAPPER_FUNCTION
            }, undefined];
        }
    }
    return [undefined, undefined];
}

export function verifyCodeIsPackage(code: string, moduleMap: Record<string | number, string>, context: Record<string, string>, name: string, version?: string): [number,Array<string>,Array<string>] {
    let vm = new VM(moduleMap, getRealContext(context), () => {
    });
    let exportObject = undefined;
    let codeAst = parser.parse(`(${code})(module, module.exports, require), module.exports`);
    let codeAst2 = transformModuleAst(codeAst);
    let genCode = generate(codeAst2, {}).code;
    exportObject = vm.run(genCode, "index.js");
    if (!exportObject) {
        return [0, [], []];
    }
    let actualExports: Set<string> = new Set();
    let queue: Array<[any, number]> = [[exportObject,0]];

    // collectCodeMappingByCompile.ts, getMainCode
    let visitedObjects = new Set();
    while (queue.length > 0) {
        let [obj, level] = queue.shift()!;
        if (visitedObjects.has(obj))
            continue;
        visitedObjects.add(obj);
        if (obj && (typeof obj === "object" || typeof obj === "function")) {
            for (let k of Object.keys(obj)) {
                if ((k === "default"|| k.includes("esModule")) && level === 0) {
                    queue.push([obj[k], level+1]);
                } else {
                    if (level===0 && Object.keys(obj).length === 1) {
                        queue.push([obj[k], level+1]);
                    }
                    if (level === 0 && obj[k].prototype) {
                        queue.push([obj[k].prototype, level+1]);
                    }
                    actualExports.add(k);
                }
            }
        }
    }

    // true package return
    const packageDir = preparePackageDir(name, version || "latest", PACKAGE_DIR);
    const bundlePath = path.join(packageDir, 'dist', 'bundle.js');

    let mod = {exportField: undefined}
    let vm2 = new VM({}, new Map([["_MODULE", mod]]), () => {
    });
    vm2.run(`${fs.readFileSync(bundlePath)};`, bundlePath);
    const modulesExports = <Set<string>><unknown>mod.exportField;
    assert(modulesExports);
    // FIXME: use subset instead
    return [(actualExports.intersection(modulesExports).size + 0.0) / actualExports.size, Array.from(actualExports), Array.from(modulesExports)];
}

export function getRealContext(context: Record<string, string>):Map<string, any> {
    let realContext = new Map<string, any>();
    for (const [k,v] of Object.entries(context)) {
        realContext.set(k, DummyClass.getInstance(v));
    }
    return realContext;
}


export function verifyCodeIsFunction(code: string, moduleMap: Record<string | number, string>, context: Record<string, string>, funcParams: string[],  predFunc: PredictFunction["function"]): boolean {
    const predFuncKey = predFunc["functionFile"] === INDEX_JS ? `${predFunc.packageName}::${predFunc.functionName}` : `${predFunc.packageName}::${predFunc.functionFile}::${predFunc.functionName}`;
    const feature = executeSequencesFeatures.get(predFuncKey);
    const realContext = getRealContext(context);
    // if we don't have feature, we can't check, return 0
    if (!feature)
        return false;
    if (code.startsWith("class"))
        return false;
    let args = [];
    args.push("thiz");
    if (feature.thiz) {
        realContext.set("thiz", feature.thiz);
    } else {
        realContext.set("thiz", null);
    }
    if (feature.input) {
        for (let pid = 0; pid < Math.max(funcParams.length, feature.input.length); pid++) {
            let pName = funcParams[pid];
            realContext.set(pName, DummyClass.getInstance(`arg${pid}`, feature.input[pid]));
            args.push(pName);
        }
    } else {
        for (let pName in funcParams) {
            realContext.set(pName, DummyClass.getInstance(pName));
            args.push(pName);
        }
    }
    let codeAST;
    codeAST = parser.parse(`(${code})`, parseOptions);
    // TODO: move this part into webpackbox?
    codeAST = transformFunctionAst(codeAST);
    if (feature.bodyText && !feature.bodyText.test(code)) {
        return false;
    }
    let genCode = generate(codeAST, {}).code;
    let track: Array<ModuleEvent> = [];
    let vm = new VM(moduleMap, realContext, (event) => {
        track.push(event);
    });
    // run the code with dummy class (Object)
    let returnValue;
    returnValue = vm.run(`${genCode.replace(/;$/, '')}.call(${args.join(",")})`, "function.js");
    if (feature.sequenceLength && !(feature.sequenceLength[0] <= track.length && track.length <= feature.sequenceLength[1])) {
        return false;
    }
    let secMatched = matchedSeq(feature.sequence, track);
    if (!secMatched)
        return false;
    let matchedOutput = true;
    if (feature.output)
        matchedOutput = feature.output(returnValue);
    return matchedOutput;
}

type CodeFile = string;
type ModuleMapString = string;
type ContextString = string;

export function codeToFile(code: string): CodeFile {
    if (code.length>512) {
        let hash = strHash(code);
        const codeFile = `${options.debundleDir}/tmp/${hash}._js`;
        let parent = path.dirname(codeFile);
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, {recursive: true});
        }
        fs.writeFileSync(codeFile, code);
        return codeFile;
    } else {
        return code;
    }
}

export function moduleMapToString(moduleMap: Record<string, string>): ModuleMapString {
    let moduleMapArg: ModuleMapString;
    if(Object.keys(moduleMap).length === 0) {
        moduleMapArg = "{}";
    } else {
        let json = JSON.stringify(moduleMap);
        moduleMapArg = `${options.debundleDir}/tmp/${strHash(json)}_moduleMap.json`;
        let parent = path.dirname(moduleMapArg);
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, {recursive: true});
        }
        fs.writeFileSync(moduleMapArg, json);
    }
    return moduleMapArg;
}

export function contextToString(context: Record<string, string>): ContextString {
    let contextArg: string;
    let contextJson = JSON.stringify(context);
    if(contextJson.length < 512) {
        contextArg = contextJson;
    } else {
        contextArg = `${options.debundleDir}/tmp/${strHash(contextJson)}_context.json`;
        let parent = path.dirname(contextArg);
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, {recursive: true});
        }
        fs.writeFileSync(contextArg, contextJson);
    }
    return contextArg;
}

function createWrapper<
    R extends any[],
    F extends (code: string, moduleMap: Record<string, string>, context: Record<string, string>, ...rest: R) => any
>(func: F): (code: CodeFile, moduleMap: ModuleMapString, context: ContextString, ...rest: R) => ReturnType<F> {
    return (code: CodeFile, moduleMap: ModuleMapString, context: ContextString, ...rest: R): ReturnType<F> => {
        const funcName = func.name;

        if (funcName === "verifyCodeIsFunction") {
            let params = rest[0] as string[];
            if (params.length<1000) {
                rest[0] = JSON.stringify(params);
            } else {
                let paramJson = JSON.stringify(params)
                let param = `${options.debundleDir}/tmp/${strHash(paramJson)}_param.json`;
                fs.writeFileSync(param, paramJson);
                rest[0] = param;
            }
            let predFunc = rest[1] as PredictFunction["function"];
            rest[1] = JSON.stringify(predFunc);
        }
        // run command
        const node = 'node';
        let dirName = __filename.endsWith(".js")? __dirname : `${__dirname}/../../lib/unbundle`;
        let result = spawnSync(node, [`${dirName}/verifypackageis.js`, funcName, code, moduleMap, context, ...rest], {encoding: 'utf-8', timeout: 5000});
        if (result.error) {
            throw new Error(`Error: ${result.error.message}`);
        }
        if (result.stderr) {
            logger.error(`Error: ${result.stderr}`);
        }
        return JSON.parse(result.stdout);
    };
}

export const verifyCodeIsFunctionWrapper = createWrapper(verifyCodeIsFunction);
export const verifyCodeIsPackageWrapper = createWrapper(verifyCodeIsPackage);
export const predictModuleNaiveWrapper = createWrapper(predictModuleNaive);

if (require.main === module) {
    const args = process.argv.slice(2);
    let command = args[0];
    let result;
    let code = args[1].endsWith("._js")?fs.readFileSync(args[1], 'utf8'):args[1];
    let moduleMap = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    let context = JSON.parse(args[3].endsWith(".json") ? fs.readFileSync(args[3], 'utf8') : args[3]);
    switch (command) {
        case "verifyCodeIsFunction": {
            let funcParams = JSON.parse(args[4].endsWith(".json") ? fs.readFileSync(args[4], 'utf8') : args[4]);
            let predFunc = JSON.parse(args[5]);
            result = verifyCodeIsFunction(code, moduleMap, context, funcParams, predFunc);
            break;
        }
        case "verifyCodeIsPackage": {
            let name = args[4];
            let version = args[5];
            result = verifyCodeIsPackage(code, moduleMap, context, name, version);
            break;
        }
        case "predictModuleNaive": {
            result = predictModuleNaive(code, moduleMap, context);
            break;
        }
    }
    console.log(JSON.stringify(result));
}