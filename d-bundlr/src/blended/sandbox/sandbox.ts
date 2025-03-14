import vm from 'vm';

import * as path from "path";
import {Module} from "module";
import {DummyClass} from "./dummyclass";
import {ProxyFactory} from "./proxyfactory";
import {ModuleEvent} from "./moduleevent";

export class VM {
    private readonly moduleCache: Map<string, NodeJS.Module>;
    public readonly globalCache: Map<string, any>;
    private mainModule: NodeJS.Module | undefined;
    public actionCallback: (event: ModuleEvent) => void;
    private readonly actionCallbackBackup: (event: ModuleEvent) => void;
    private readonly moduleLoadTimeout: number;

    constructor(actionCallback?: (event: ModuleEvent) => void, moduleLoadTimeout = 5000) {
        this.moduleCache = new Map<string, NodeJS.Module>();
        this.globalCache = new Map<string, any>();
        if (actionCallback) {
            this.actionCallback = actionCallback;
        } else {
            this.actionCallback = (event) => {
                console.log(`[VM] ${event.action}: ${event.value}, at: ${event.module}`)
            }
        }
        DummyClass.actionCallback = this.actionCallback;
        this.actionCallbackBackup = this.actionCallback;
        this.moduleLoadTimeout = moduleLoadTimeout;
    }

    mute() {
        this.actionCallback = (event) => {};
    }

    unMute() {
        this.actionCallback = this.actionCallbackBackup;
    }

    newContext(filename: string) {
        let filepath = path.isAbsolute(filename) ? filename : path.resolve(__dirname, filename);
        let m = new Module(filename);
        m.filename = filepath;
        m.paths = [];
        let parentDir = filepath;
        while (true) {
            let parentParentDir = path.dirname(parentDir);
            if (parentDir === parentParentDir) {
                break;
            }
            m.paths.push(`${parentDir}${path.sep}node_modules`);
            parentDir = parentParentDir;
        }
        let _resolve = function (request: string, options?: any) {
            // @ts-ignore
            return Module._resolveFilename(request, this, false, this.paths);
        }
        // @ts-ignore
        m.require.resolve = _resolve.bind(m);
        m.loaded = true;
        let proxy = new ProxyFactory(m, this.moduleCache, this);
        let proxyRequire = proxy.makeRequireProxy();
        let proxyModule = proxy.makeModuleProxy();
        if (this.mainModule) {
            m.require.main = this.mainModule;
        } else {
            m.require.main = proxyModule;
            this.mainModule = proxyModule;
        }
        let _context: any = {
            require: proxyRequire,
            print: console.log,
            exports: m.exports,
            module: proxyModule,
            __filename: filepath,
            __dirname: path.basename(filepath),
        };
        this.mute();
        let proxyGlobal = proxy.makeGlobalProxy();
        for (const each of Object.entries(Object.getOwnPropertyDescriptors(global))) {
            if (each[0] === "globalThis" || each[0] === "global") {
                _context[each[0]] = proxyGlobal;
                continue;
            }
            if (each[0] === "__functionLocation__") {
                // @ts-ignore
                _context[each[0]] = global[each[0]];
                continue;
            }
            if (_context[each[0]] === undefined) {
                _context[each[0]] = proxyGlobal[each[0]];
            }
        }
        // stimulate window and document for browser
        const window = DummyClass.getInstance("window");
        _context["window"] = window;
        _context["window"]["global"] = _context["global"]
        const document = DummyClass.getInstance("document");
        _context["document"] = document;
        _context["document"]["global"] = _context["global"]
        this.unMute();
        return _context;
    }

    run(code: string, filename: string = "./blend.js") {
        return this.runInternal(code, filename);
    }

    runInternal(code: string, filename: string = "./blend.js"): any {
        let filepath = path.isAbsolute(filename) ? filename : path.resolve(__dirname, filename);
        if (this.moduleCache.has(filepath)) {
            return this.moduleCache.get(filepath)?.exports;
        } else {
            let context = this.newContext(filename);
            vm.runInNewContext(code, context, {timeout: this.moduleLoadTimeout, filename: filename}); // FIXME: NODE_OPTIONS='--require ts-node/register'
            if (context.module.exports && Object.keys(context.module.exports).length === 0 && Object.keys(context.exports).length !== 0) {
                Object.assign(context.module.exports, context.exports);
            }
            let module = context.module;
            this.moduleCache.set(filepath, module);

            return module.exports;
        }
    }
}

if (require.main === module) { // TODO: remove?
    // @ts-ignore
    let vm = new VM((event) => {
        console.log(`[SANDBOX] ${event.action}: ${event.value}, at: ${event.module}`);
    },200);
    vm.run(`
    let s=Symbol('x');
    let a={
        [s]: "V",
    };
    a[s]="SS";
    console.log(a[s]);
    `)
}
