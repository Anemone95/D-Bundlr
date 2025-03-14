import vm from 'vm';
import {DummyClass} from "./dummyclass";
import {ModuleEvent} from "./moduleevent";
import {JSDOM} from "jsdom";
import {WebpackProxyFactory} from "./webpackproxyfactory";

export const NAME = Symbol("NAME");
export interface Module {
    exports: any;
    [NAME]: string|number;
}

export class VM {
    public readonly moduleCache: Record<string, any>=[];
    public actionCallback: (event: ModuleEvent) => void;
    private readonly actionCallbackBackup: (event: ModuleEvent) => void;
    private readonly moduleLoadTimeout: number;
    private jsdom: JSDOM;
    public readonly codeMap = new Map<string, string>();
    readonly globalCache: Map<string, any>=new Map();
    private freeVars: Map<string, any>;


    constructor(codeMap: Record<string, string>, freeVars: Map<string, any>=new Map(), actionCallback?: (event: ModuleEvent) => void, moduleLoadTimeout = 500000) {
        for (const [k,v] of Object.entries(codeMap)) {
            this.codeMap.set(k, v);
        }
        this.jsdom = new JSDOM(`<!DOCTYPE html><p>Hello world</p>`);
        this.moduleCache = new Map<string, Module>();
        this.freeVars = freeVars;
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
        DummyClass.CACHE.clear();
    }

    mute() {
        this.actionCallback = (event) => {};
    }

    unMute() {
        this.actionCallback = this.actionCallbackBackup;
    }

    /**
     * For each module, create a context
     * @param moduleName
     */
    newContext(moduleName: string | number) {
        let module = {exports: {}, [NAME]: moduleName};
        let proxy = new WebpackProxyFactory(module, this);
        let proxyRequire = proxy.makeRequireProxy();
        this.mute();
        let document = DummyClass.getInstance("document", this.jsdom.window.document);
        let window = DummyClass.getInstance("window", this.jsdom.window);

        // TODO proxied document
        let _context: any = {
            print: console.log,
            window: window,
            document: document,
            globalThis: window,
            global: window,
            this: window,
            module: module,
            exports: module.exports,
            require: proxyRequire,
            VM_INTERNAL:{}, //record called location->true
            DummyClass: DummyClass,
            Error: Error,
        };
        for (const [k,v] of this.freeVars) {
            if (_context[k] === undefined)
                _context[k] = v;
        }
        let proxyGlobal = proxy.makeGlobalProxy();
        for (const each of Object.entries(Object.getOwnPropertyDescriptors(global))) {
            if (each[0] === "globalThis" || each[0] === "global") {
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
        this.unMute();
        return _context;
    }

    /**
     *
     * @param code (module, exports, __require__)=>{}
     * @param filename id
     */
    run(code: string, filename: string|number = "unknown.js"): any {
        if (this.moduleCache[filename]) {
            return this.moduleCache[filename].exports;
        } else {
            let context = this.newContext(filename);
            // let listener = (err: Error) => {
            //     console.error('UncaughtError in VM:', err.toString());
            // }
            // process.on('uncaughtException', listener);
            // process.on('unhandledRejection', listener);
            let res = vm.runInNewContext(code, context, {timeout: this.moduleLoadTimeout,
                filename: typeof filename === "number" ? String(filename) : filename
            }); // FIXME: NODE_OPTIONS='--require ts-node/register'
            // if (context.module.exports && Object.keys(context.module.exports).length === 0 && Object.keys(context.exports).length !== 0) {
            //     Object.assign(context.module.exports, context.exports);
            // }
            // process.removeListener('uncaughtException', listener);
            // process.removeListener('unhandledRejection', listener);
            this.moduleCache[filename] = context.module;
            return res;
        }
    }
}


if (require.main === module) { // TODO: remove?
    // let vm = new VM(new Map([['b', "(m,e)=>{m.exports={a:1,c:2}}"]]), new Map([["x", DummyClass.getInstance("x")]]), (event) => {
    //     console.log(`[SANDBOX] ${event.action}: ${event.value}, at: ${event.module}`);
    // });
    // console.log(111,Promise.resolve);
    // let r = vm.run("Promise.resolve=undefined");
    // console.log(222,Promise.resolve, r);


}
