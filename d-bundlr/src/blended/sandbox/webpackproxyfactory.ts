import { mapGetSet } from "../../misc/util";
import {blackList} from "./blacklist";
import {Module, NAME, VM} from "./webpackbox";
import {DummyClass} from "./dummyclass";

export type WEBPACK_FIELDS =
    "moduleFactories"
    | "definePropertyGetters"
    | "hasOwnProperty"
    | "makeNamespaceObject"
    | "webpackGlobal"
    | "nodeModuleDecorator"
    | "compatGetDefaultExport"
    | "createFakeNamespaceObject"
    | "harmonyModuleDecorator";

let queue = [global];
const nativeObjToFields: Map<Object, Set<string | symbol>> = new Map();
while (queue.length>0) {
    let obj = queue.pop()!;
    if (nativeObjToFields.has(obj))
        continue;
    for (const [field, des] of Object.entries(Object.getOwnPropertyDescriptors(obj))) {
        mapGetSet(nativeObjToFields, obj).add(field);
        if (des.value) {
            queue.push(des.value);
        }
    }
}


/**
 * For each module, create a proxy to provide require function
 */
export class WebpackProxyFactory {
    private func2accessPath = new Map<any, string>();
    private readonly vm: VM;
    private readonly module: Module;

    constructor(module: Module, vm: VM) {
        this.vm = vm;
        this.module = module;
    }

    public makeGlobalProxy(): any {
        let id = "__global";
        let globalCache = this.vm.globalCache;
        if (globalCache.has(id)) {
            return globalCache.get(id);
        } else {
            this.func2accessPath.set(global, `global`);
            let proxyMod = new Proxy(global, this.globalHandler);
            globalCache.set(id, proxyMod);
            return proxyMod;
        }
    }

    private globalHandler: ProxyHandler<any> = {
        get: (target, prop, receiver) => {
            let accessPath = `${this.func2accessPath.get(target)}.${prop.toString()}`;
            this.vm.actionCallback({action: "GET", value: accessPath, module: this.module[NAME]})
            if (!["object", "function"].includes(typeof target[prop])) {
                return target[prop];
            }
            if ("symbol" === typeof prop) {
                return target[prop];
            }

            if (blackList.has(accessPath)) {
                // @ts-ignore
                return blackList.get(accessPath)!.value(this.vm, accessPath, this.module);
            }
            let desc = Object.getOwnPropertyDescriptor(target, prop);
            this.func2accessPath.set(target[prop], `${this.func2accessPath.get(target)}.${prop.toString()}`);
            if (desc && desc.writable == false && desc.configurable == false) {
                return target[prop];
            }
            if (WebpackProxyFactory.apIsPartOfBlackList(accessPath)) {
                return new Proxy(target[prop], this.globalHandler);
            } else if (nativeObjToFields.has(target) && nativeObjToFields.get(target)?.has(prop)){
                return new Proxy(target[prop], this.globalHandler);
            } else {
                return target[prop];
            }
        },
        apply: (target, thisArg, argumentsList) => {
            let accessPath = this.func2accessPath.get(target);
            this.vm.actionCallback({action: "CALL", value: accessPath, module: this.module[NAME]})
            if (!accessPath)
                return target.apply(thisArg, argumentsList);
            for (const blackAccessPath of blackList.keys()) {
                if (accessPath.startsWith(blackAccessPath)) {
                    return blackList.get(blackAccessPath)?.call.apply(thisArg, [...argumentsList, accessPath]);
                }
            }
            if (this.func2accessPath.get(target)?.includes(".toString")) {
                return eval(`${this.func2accessPath.get(target)}()`);
            }
            if (thisArg===undefined){
                thisArg=null;
            }
            try {
                return target.apply(thisArg, argumentsList);
            } catch (e) {
                return DummyClass.getInstance("dummy");
            }
        },
        construct: (target, args) => {
            let accessPath = this.func2accessPath.get(target);
            if (!accessPath) return new target(...args);
            this.vm.actionCallback({action: "NEW", value: accessPath, module: this.module[NAME]})
            for (const blackAccessPath of blackList.keys()) {
                if (accessPath.startsWith(blackAccessPath)) {
                    return blackList.get(blackAccessPath)!.call.apply(undefined, [...args, accessPath]);
                }
            }
            return new target(...args);
        },
        set: (target: any, p: string|symbol, value, receiver) => {
            const path = `${this.func2accessPath.get(target)??"global.?"}.${typeof p === "string" ? p : p.description}`.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
            this.vm.actionCallback({
                module: this.module[NAME], action: "SET",
                value: `${path}=${value}`
            });
            if (nativeObjToFields.has(target) && nativeObjToFields.get(target)?.has(p))
                return false;
            target[p] = value;
            return true;
        },
    };

    public makeRequireProxy(): any {
        // TODO: any performance improvement? now we create many require instance
        let __webpack_require__: { [key: string]: any } = (moduleId: string|number): any => {
            moduleId = String(moduleId)
            if (this.vm.codeMap.get(moduleId)) {
                // Execute the module function
                let wrapper = `(${this.vm.codeMap.get(moduleId)})(module, module.exports, require)`;
                this.vm.run(wrapper, moduleId);
                return this.vm.moduleCache[moduleId].exports;
            } else {
                // TODO wrapper with a object proxy
                return DummyClass.getInstance(String(moduleId));
            }
        }
        let moduleFactories = this.vm.moduleCache;
        let definePropertyGetters = (exports: any, ...args: any[]) => {
            if (args.length === 1) {
                let definition: Record<string, any> = args[0];
                for(let key in definition) {
                    if(Object.prototype.hasOwnProperty.call(definition, key) && !Object.prototype.hasOwnProperty.call(exports, key)) {
                        Object.defineProperty(exports, key, {enumerable: true, get: definition[key]});
                    }
                }
            } else if (args.length === 2) {
                let key = args[0];
                Object.defineProperty(exports, key, {enumerable: true, get: args[1]});
            }
        };

        let hasOwnProperty = (obj:any, prop: any) => (Object.prototype.hasOwnProperty.call(obj, prop));

        let webpackGlobal = global;

        let makeNamespaceObject = (exports: any) => {
            if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
                Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
            }
            Object.defineProperty(exports, '__esModule', { value: true });
        };

        let nodeModuleDecorator = (module: any) => {
            module.paths = [];
            if (!module.children) module.children = [];
            return module;
        };

        let compatGetDefaultExport = (module: any) => {
            // FIXME: why we have module.u, how https:sso.geiwohuo.com/sheinsz.ltwebstatic.com/she_dist/libs/geetest/www/js/fullpage.1.1.9.js made this?
            let getter = module && (module.__esModule||module.u) ? function () {
                return module["default"]
            } : function () {
                return module
            };
            definePropertyGetters(getter(), {a: getter})
            return getter;
        }

        let createFakeNamespaceObject = function (value: any, mode: number) {
            // mode & 1: value is a module id, require it
            if (mode & 1)
                // @ts-ignore
                value = __webpack_require__(value);
            if (mode & 8)
                return value;
            if (typeof value === "object" && value) {
                if ((mode & 4) && value.__esModule)
                    return value;
                if ((mode & 16) && typeof value.then === "function")
                    return value;
            }
            let ns = Object.create(null);
            makeNamespaceObject(ns);
            let def:Record<string, any> = {};
            let leafPrototypes;
            leafPrototypes = leafPrototypes || [null, Object.getPrototypeOf({}), Object.getPrototypeOf([]), Object.getPrototypeOf(Object.getPrototypeOf)];
            for(let current = (mode & 2) && value; typeof current == 'object' && !~leafPrototypes.indexOf(current); current = Object.getPrototypeOf(current)) {
                Object.getOwnPropertyNames(current).forEach( (key => {
                    def[key] = () => value[key]
                }));
            }
            def.default = () => value;
            definePropertyGetters(ns, def);
            // module.export => {default: module.export}
            return ns;
        }

        let harmonyModuleDecorator = function (module: any) {
            module = Object.create(module);
            if (!module.children) module.children = [];
            Object.defineProperty(module, 'exports', {
                enumerable: true,
                set: function () {
                    throw new Error('ES Modules may not assign module.exports or exports.*, Use ESM export syntax, instead: ' + module.id);
                }
            });
            return module;
        };

        let fieldFunctions:Record<WEBPACK_FIELDS, any> = {
            moduleFactories,
            definePropertyGetters,
            hasOwnProperty,
            webpackGlobal,
            makeNamespaceObject,
            nodeModuleDecorator,
            compatGetDefaultExport,
            createFakeNamespaceObject,
            harmonyModuleDecorator,
        }
        // TODO: dynamic map
        // https://github.com/webpack/webpack/blob/main/lib/RuntimeGlobals.js
        let fieldMap:Map<string, WEBPACK_FIELDS> = new Map<string, any>([
            ["m", "moduleFactories"],
            ["d", "definePropertyGetters"],
            ["o", "hasOwnProperty"],
            ["g", "webpackGlobal"],
            ["r", "makeNamespaceObject"],
            ["nmd", "nodeModuleDecorator"],
            ["n", "compatGetDefaultExport"],
            ["t", "createFakeNamespaceObject"],
            ["hmd", 'harmonyModuleDecorator'],
        ]);
        for (const [shortField, fields] of fieldMap) {
            __webpack_require__[shortField] = fieldFunctions[fields];
        }
        // TODO: return a proxy instead
        return __webpack_require__;
    }

    private static apIsPartOfBlackList(accessPath: string | undefined): boolean {
        if (!accessPath) return false;
        for (const blackAccessPath of blackList.keys()) {
            if (accessPath.startsWith(blackAccessPath) || blackAccessPath.startsWith(accessPath)) {
                return true;
            }
        }
        return false;
    }
}