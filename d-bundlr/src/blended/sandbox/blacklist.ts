import {VM} from "./webpackbox";
import {DummyClass} from "./dummyclass";

export const blackList:Map<string,
    { call: Function, value: (vm: VM, accessPath: string, module: any) => Function }> = new Map([
    ["global.queueMicrotask", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.queueMicrotask")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.Error", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.Error")!.call;
        },
        call: () => global.Error
    }],
    ["global.process.dlopen", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.process.dlopen")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.process.exit", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.process.exit")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.process.next", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.process.next")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.process.nextTick", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.process.nextTick")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.process.on", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.process.on")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.setTimeout", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.setTimeout")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["global.setInterval", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.setInterval")!.call;
        },
        call: (...args: any) => {
            if (args.length > 1 && args[0]) args[0]();
            return DummyClass.getInstance("setInterval");
        }
    }],
    ["require('http').METHODS", {
        value: (vm: VM, accessPath: string, module: any) => {
            return require('http').METHODS;
        },
        call: () => require('http').METHODS
    }],
    ["require('http').STATUS_CODES", {
        value: (vm: VM, accessPath: string, module: any) => {
            return require('http').STATUS_CODES;
        },
        call: () => require('http').STATUS_CODES
    }],
    ["require('dns').", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('dns').")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('http').", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('http').")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('https').", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('https').")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('http2').", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('http2').")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('net').", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('net').")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('util').types.isProxy", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('util').types.isProxy")!.call;
        },
        call: () => {
            return false;
        }
    }],
    ["require('module').runMain", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('module').runMain")!.call;
        },
        call: () => DummyClass.getInstance("require('module').runMain")
    }],
    ["require('child_process').", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('child_process').")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('fs').rm", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('fs').rm")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["require('fs').rename", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("require('fs').rename")!.call;
        },
        call: (...args: any) => {
            return DummyClass.getInstance(args[args.length - 1]);
        }
    }],
    ["global.decodeURIComponent", {
        value: (vm: VM, accessPath: string, module: any) => {
            return (s: string) => {
                vm.actionCallback({ action: "CALL", value: `${accessPath}(${s})`, module: module })
                try {
                    return decodeURIComponent(s.toString());
                } catch (e) {
                    return DummyClass.getInstance(`decodeURIComponent(${s})`);
                }
            }
        },
        call: (s: string) => {
            try {
                return decodeURIComponent(s.toString());
            } catch (e) {
                return DummyClass.getInstance(`decodeURIComponent(${s})`);
            }
        }
    }],
    ["global.Buffer.from", {
        value: (vm: VM, accessPath: string, module: any) => {
            return (s: string) => {
                vm.actionCallback({ action: "CALL", value: `${accessPath}(${s})`, module: module })
                try {
                    return Buffer.from(s.toString());
                } catch (e) {
                    return DummyClass.getInstance(`decodeURIComponent(${s})`);
                }
            }
        },
        call:(s: string) => {
            try {
                return Buffer.from(s.toString());
            } catch (e) {
                return DummyClass.getInstance(`decodeURIComponent(${s})`);
            }
        }
    }],
    ["global.URL.createObjectURL", {
        value: (vm: VM, accessPath: string, module: any) => {
            return blackList.get("global.URL.createObjectURL")!.call;
        },
        call:(s: any) => {
            if (s[DummyClass.IS_PROXIED]) {
                return DummyClass.getInstance(`URL.createObjectURL(${s})`);
            } else {
                return URL.createObjectURL(s);
            }
        }
    }]
]);
