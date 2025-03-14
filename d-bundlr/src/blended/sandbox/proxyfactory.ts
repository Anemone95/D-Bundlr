import {blackList} from "./blacklist";
import {Module} from "module";
import fs from "fs";
import {VM} from "./sandbox";

export class ProxyFactory {
    private func2accessPath: Map<any, string>;
    private readonly moduleCache: Map<string, NodeJS.Module>;
    private readonly globalCache: Map<string, any>;
    private readonly originModule: NodeJS.Module;
    private readonly originRequire: NodeJS.Require;
    private readonly vm: VM;
    private proxyRequire: NodeJS.Require | undefined;

    constructor(originModule: NodeJS.Module, moduleCache: Map<string, NodeJS.Module>, vm: VM) {
        this.func2accessPath = new Map<any, string>();
        this.moduleCache = moduleCache;
        this.globalCache = vm.globalCache;
        this.originModule = originModule;
        this.originRequire = originModule.require.bind(this.originModule);
        this.originRequire.resolve = originModule.require.resolve.bind(originModule);
        this.vm = vm;
    }

    private static apIsPartOfBlackList(accessPath:string|undefined):boolean{
        if (!accessPath) return false;
        for (const blackAccessPath of blackList.keys()) {
            if (accessPath.startsWith(blackAccessPath) || blackAccessPath.startsWith(accessPath)) {
                return true;
            }
        }
        return false;
    }

    private requireModuleHandler: ProxyHandler<any> = {
        get: (target, prop, receiver) => {
            let accessPath = `${this.func2accessPath.get(target)}.${prop.toString()}`;
            this.vm.actionCallback({action: "GET", value: accessPath, module: this.originModule.filename})
            if (!["object", "function"].includes(typeof target[prop])) {
                return target[prop];
            }
            if ("symbol" === typeof prop) {
                return target[prop];
            }
            if (accessPath == "global.global") {
                return target;
            }
            if (blackList.has(accessPath)) {
                // @ts-ignore
                return blackList.get(accessPath)?.value();
            }
            let desc = Object.getOwnPropertyDescriptor(target, prop);
            if (desc && desc.writable == false && desc.configurable == false) {
                return target[prop];
            }
            this.func2accessPath.set(target[prop], `${this.func2accessPath.get(target)}.${prop.toString()}`);
            if (ProxyFactory.apIsPartOfBlackList(accessPath)) {
                return new Proxy(target[prop], this.requireModuleHandler);
            } else {
                return target[prop];
            }
        },
        apply: (target, thisArg, argumentsList) => {
            let accessPath = this.func2accessPath.get(target);
            this.vm.actionCallback({action: "CALL", value: accessPath, module: this.originModule.filename})
            if (this.func2accessPath.get(target) === "require(\"util\").types.isProxy") {
                return false;
            } else if (this.func2accessPath.get(target)?.startsWith("require(\"child_process\").")) {
                return "Invalid";
            }
            if (!accessPath)
                return target.apply(thisArg, argumentsList);
            // for (const blackAccessPath of blackList.keys()) {
            //     if (accessPath.startsWith(blackAccessPath)) {
            //         return blackList.get(blackAccessPath)?.apply(thisArg, [...argumentsList, accessPath]);
            //     }
            // }
            if (this.func2accessPath.get(target)?.includes(".toString")) {
                return eval(`${this.func2accessPath.get(target)}()`);
            }
            return target.apply(thisArg, argumentsList);
        },
        construct: (target, args) => {
            let accessPath = this.func2accessPath.get(target);
            if (!accessPath) return new target(...args);
            this.vm.actionCallback({action: "NEW", value: accessPath, module: this.originModule.filename})
            // for (const blackAccessPath of blackList.keys()) {
            //     if (accessPath.startsWith(blackAccessPath)) {
            //         return blackList.get(blackAccessPath)?.apply(undefined,[...args, accessPath]);
            //     }
            // }
            return new target(...args);
        }
    };

    private makeInternalModuleProxy(id: string) {
        if (this.moduleCache.has(id)) {
            return this.moduleCache.get(id);
        } else {
            let mod = this.originModule.require(id);
            this.func2accessPath.set(mod, `require('${id}')`);
            let proxyMod = new Proxy(mod, this.requireModuleHandler);
            this.moduleCache.set(id, proxyMod);
            return proxyMod;
        }
    }

    private requireHandler: ProxyHandler<any> = {
        get: (target, prop, receiver) => {
            this.vm.actionCallback({
                action: "GET",
                value: `require.${prop.toString()}`,
                module: this.originModule.filename
            })
            return target[prop];
        },
        apply: (target, thisArg, argumentsList) => {
            if (target === this.originRequire) {
                this.vm.actionCallback({
                    action: "REQUIRE",
                    value: `require('${argumentsList}')`,
                    module: this.originModule.filename
                })
                let id = argumentsList[0];
                if (id.startsWith("node:")) id = id.substring(5);
                for (const blackAccessPath of blackList.keys()) {
                    if (blackAccessPath.startsWith(`require('${argumentsList[0]}')`)) {
                        return this.makeInternalModuleProxy(argumentsList[0]);
                    }
                }
                if (!Module.builtinModules?.includes(id)) {
                    // @ts-ignore
                    let filepath = this.originRequire.resolve(...argumentsList);
                    if (filepath.endsWith(".js")) {
                        this.vm.actionCallback({
                            action: "REQUIRE",
                            value: `require('${filepath}')`,
                            module: this.originModule.filename
                        })
                        const content = fs.readFileSync(filepath, 'utf8');
                        return this.vm.runInternal(content, filepath);
                    }
                }
            }
            return target.apply(thisArg, argumentsList);
        }
    }

    public makeRequireProxy(): NodeJS.Require {
        if (this.proxyRequire) {
            return this.proxyRequire;
        } else {
            let req = new Proxy(this.originRequire, this.requireHandler);
            this.proxyRequire = req;
            return req;
        }
    }

    private moduleHandler: ProxyHandler<any> = {
        get: (target, prop, receiver) => {
            this.vm.actionCallback({
                action: "GET",
                value: `require('${this.originModule.filename}').${prop.toString()}`,
                module: this.originModule.filename
            })
            if (prop == "require") {
                return this.makeRequireProxy();
            }
            // return
            return target[prop];
        }
    }

    public makeModuleProxy(): NodeJS.Module {
        if (this.moduleCache.has(this.originModule.filename)) {
            // @ts-ignore
            return this.moduleCache.get(this.originModule.filename);
        } else {
            let req = new Proxy(this.originModule, this.moduleHandler);
            this.moduleCache.set(this.originModule.filename, req);
            return req;
        }
    }

    public makeGlobalProxy(): any {
        let id = "__global";
        if (this.globalCache.has(id)) {
            return this.globalCache.get(id);
        } else {
            this.func2accessPath.set(global, `global`);
            let proxyMod = new Proxy(global, this.requireModuleHandler);
            this.globalCache.set(id, proxyMod);
            return proxyMod;
        }
    }
}
