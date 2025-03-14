import {getCallStack} from "../stacktrace";
import {ModuleEvent} from "./moduleevent";

// function isNative(fn: Function) {
//     return (/\{\s*\[native code\]\s*\}/).test('' + fn.toString());
// }

// TODO: separate the dummy class with the membrane class is better?
export class DummyClass {

    static CACHE: Map<string, any> = new Map();
    static IS_PROXIED: symbol = Symbol("isProxied"); // object is proxied
    static IS_DUMMY: symbol = Symbol("isDummy"); // isDummy is true if the object is a dummy object
    static PRIMITIVE_TYPE: symbol = Symbol("PRIMITIVE_TYPE"); // proxied object is a primitive type
    static PATH: symbol = Symbol("path");

    // position->count, if count>500 then return null, if count>1000 then throw exception
    static callCount: Map<string, number> = new Map();

    static actionCallback: (event: ModuleEvent) => void = (event) => {
        console.log(`[VM] ${event.action}: ${event.value}, at: ${event.module}`)
    }

    static proxyHandler: ProxyHandler<any> = {
        apply: (target: any, thisArg: any, argArray: any[]): any => {
            let args;
            if (argArray.length == 0) {
                args = "";
            } else {
                args = argArray.map((value: any) => {
                    if (value) {
                        if (value[DummyClass.IS_PROXIED])
                            return value[DummyClass.PATH];
                        if (value.toString===undefined) //Object.create(null)
                            return "null";
                        return value.toString();
                    } else
                        return "undefined";
                }).join("','");
            }
            const path = `${target[DummyClass.PATH]}('${args}')`.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
            DummyClass.actionCallback({
                module: getCallStack().toString(), action: "CALL",
                value: path,
            });
            if (typeof target === 'function' && target[DummyClass.IS_DUMMY] !== true ) {
                return target.apply(thisArg, argArray);
            }
            for (const arg of argArray) {
                if (arg && arg[DummyClass.IS_DUMMY]===true){
                    DummyClass.actionCallback({
                        module: getCallStack().toString(), action: "CALL",
                        value: `${arg.toString()}()`
                    });
                }
            }
            return DummyClass.getInstance(`${target.toString()}('${args}')`);
        },
        get: (target: any, p, receiver) => {
            if (p === DummyClass.PATH) {
                return target[DummyClass.PATH];
            } else if (p === DummyClass.IS_PROXIED) {
                return true;
            } else if (p === DummyClass.IS_DUMMY) {
                return target[DummyClass.IS_DUMMY];
            } else if (p === DummyClass.PRIMITIVE_TYPE) {
                return target[DummyClass.PRIMITIVE_TYPE];
            }
            const path = `${target[DummyClass.PATH]}.${typeof p === "string" ? p : p.description}`.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
            let desc = Object.getOwnPropertyDescriptor(target, p);
            if (target[DummyClass.IS_DUMMY]===true) {
                // target is a completely dummy object
                if (typeof p === "string" && p === "toString") {
                    return target.toString;
                } else if (typeof p==="string" && p === "length") {
                    // TODO: distinguish between array and arguments
                    return 1;
                } else if (p===Symbol.toPrimitive) {
                    return function(hint: "number" | "string" | "default"): number | string {
                        switch (hint) {
                            case "number":
                                return target[DummyClass.PRIMITIVE_TYPE] ? target.value : 0;
                            case "string":
                                return target[DummyClass.PRIMITIVE_TYPE] ? target.value : target[DummyClass.PATH];
                            case "default":
                                return target[DummyClass.PRIMITIVE_TYPE] ? target.value : "0"; // TODO: appropriate value?
                        }
                    };
                } else if (p===Symbol.iterator) {
                    return function() {
                        let index = 0;
                        return {
                            next: () => {
                                if (index++ < 10)
                                    return {value: DummyClass.getInstance(path+index), done: false};
                                else
                                    return {value: undefined, done: true};
                            }
                        };
                    };
                } else if (p===Symbol.toStringTag) {
                    return path;
                }

                DummyClass.actionCallback({
                    module: getCallStack().toString(), action: "GET",
                    value: path,
                });
                return DummyClass.getInstance(path);
            } else if (target[DummyClass.PRIMITIVE_TYPE]) {
                DummyClass.actionCallback({
                    module: getCallStack().toString(), action: "GET",
                    value: path,
                });
                const prim = Reflect.get(target, 'value');
                const value = prim[p];
                return typeof value === 'function' ? value.bind(prim) : value;
            } else {
                // target is a true object but wrapped by proxy
                DummyClass.actionCallback({
                    module: getCallStack().toString(), action: "GET",
                    value: path,
                });
                if (desc && desc.value) {
                    if (desc.value[DummyClass.IS_PROXIED] !== true && desc.writable && desc.configurable) {
                        return DummyClass.getInstance(path, target[p]);
                    } else {
                        return target[p];
                    }
                } else if (target[p] && target[p][DummyClass.IS_PROXIED] !== true) {
                    return DummyClass.getInstance(path, target[p]);
                } else {
                    return target[p];
                }
            }
        },
        set: (target: any, p, value, receiver) => {
            const path = `${target[DummyClass.PATH]}.${typeof p === "string" ? p : p.description}`.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
            DummyClass.actionCallback({
                module: getCallStack().toString(), action: "SET",
                value: `${path}=${String(value)}`
            });
            target[p] = value;
            return true;
        },
        construct: (target: any, argArray: any[], newTarget: Function): object => {
            DummyClass.actionCallback({
                module: getCallStack()[1].toString(), action: "NEW",
                value: target.toString()
            });
            if (typeof target === 'function' && target[DummyClass.IS_DUMMY] !== true ) {
                return new target(argArray);
            }

            for (const arg of argArray) {
                if (typeof arg == "function" && arg.toString() !== "dummyArg") {
                    let p = DummyClass.getInstance(`dArg`)
                    let funcArgs = Array(10).fill(p);
                    try {
                        arg(...funcArgs);
                    } catch {
                    }
                }
            }
            return DummyClass.getInstance(`${target.toString()}`);
        }
        // TODO implement other traps?
    }

    static getInstance(str: string, obj?: any): any {
        if (!obj) {
            if (DummyClass.CACHE.has(str))
                return DummyClass.CACHE.get(str);
            obj = function () {}
            obj[DummyClass.IS_DUMMY] = true;
            obj.toString = () => {
                return str;
            }
        } else {
            if (typeof obj === 'object' || typeof obj === 'function')
                obj[DummyClass.IS_DUMMY] = false;
            else if (typeof obj === 'string' || typeof obj === 'number') {
                obj = {[DummyClass.PRIMITIVE_TYPE]: typeof obj, value: obj};
            } else {
                return obj;
            }
        }
        //@ts-ignore
        obj[DummyClass.PATH] = str;
        let p = new Proxy(obj, DummyClass.proxyHandler);
        if(obj[DummyClass.IS_DUMMY] === true)
            DummyClass.CACHE.set(str, p);
        return p;
    }
}

if (require.main === module) { // TODO: remove?
    // FIXME
    console.log(URL.createObjectURL(DummyClass.getInstance("x","")));
}
