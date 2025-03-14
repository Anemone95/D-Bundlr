import {Debugger, Runtime, Session} from 'inspector';
import {promisify} from 'util';
import {ILocation} from "./funcloc";

const PREFIX = '__functionLocation__';

export interface ILocateOptions {
    sourceMap?: boolean;
}

export class SessionManager {
    private fnCache: Map<Function, ILocation | null> = new Map<Function, ILocation | null>();
    private session: Session | undefined;
    private post$: (method: any, params?: {}) => Promise<any> = (method) => {
        return Promise.resolve(`Undefined method: ${method}`)
    };
    private scripts: {
        [scriptId: string]: Debugger.ScriptParsedEventDataType;
    } = {};

    public async clean(): Promise<boolean> { // FIXME: never called? (therefore session.disconnect never called)
        if (!this.session) {
            return true;
        }

        await this.post$('Runtime.releaseObjectGroup', {
            objectGroup: PREFIX,
        });

        this.session.disconnect();
        // @ts-ignore
        delete global[PREFIX];
        this.session = undefined;
        this.fnCache.clear();

        return true;
    }

    public async locate(fn: (...args: any) => any): Promise<ILocation | undefined> {
        if (typeof fn !== 'function') {
            throw new Error('You are allowed only to reference functions.');
        }

        // TODO
        // Look from the function inside the cache array and return it if it does exist.
        let id = Date.now();
        const fromCache = this.fnCache.get(fn);
        // const isMap = opts && opts.sourceMap;

        if (fromCache) {
            return fromCache;
        }

        // Create a function location object to put referencies into it
        // So that we can easilly access to them
        // @ts-ignore
        if (typeof global[PREFIX] === 'undefined') {
            // @ts-ignore
            global[PREFIX] = {};
        }

        // Create a reference of the function inside the global object
        // @ts-ignore
        global[PREFIX][id] = fn;

        // Create an inspector session an enable the debugger inside it
        if (!this.session) {
            this.session = new Session();
            this.post$ = promisify(this.session.post).bind(this.session);
            this.session.connect();
            this.session.on('Debugger.scriptParsed', (res) => {
                this.scripts[res.params.scriptId] = res.params;
            });
            await this.post$('Debugger.enable');
        }

        // Evaluate the expression
        const evaluated = await this.post$('Runtime.evaluate', {
            expression: `global['${PREFIX}']['${id}']`,
            objectGroup: PREFIX,
        });
        let remoteObj = evaluated.result;
        let properties: Runtime.GetPropertiesReturnType;
        while (remoteObj.subtype === "proxy") {
            // Get the function properties
            properties = await this.post$('Runtime.getProperties', {
                objectId: remoteObj.objectId,
            });
            remoteObj = properties.internalProperties?.find((prop) => prop.name === '[[Target]]')?.value;
        }

        properties = await this.post$('Runtime.getProperties', {
            objectId: remoteObj.objectId,
        });
        const location = properties.internalProperties?.find((prop) => prop.name === '[[FunctionLocation]]')?.value?.value;
        // const script = this.scripts[location?.value?.value.scriptId];
        // let source = script.url;
        // const sourceMapUrl = script.sourceMapURL;

        // // Normalize the source uri to ensure consistent result
        // if (!source.startsWith('file://')) {
        //     source = `file://${source}`;
        // }
        //
        // Construct the result object
        if (!location) {
            return undefined;
        }
        if (!this.scripts[location.scriptId]) {
            return undefined;
        }
        let result: ILocation = {
            scriptName: this.scripts[location.scriptId].url,
            column: location.columnNumber,
            line: location.lineNumber,
            // source,
        };

        // if (isMap) {
        //     try {
        //         const res = await SourceMapper.map(result, sourceMapUrl);
        //         if (res) {
        //             result = res;
        //         }
        //     } catch (e) {
        //         // Do nothing
        //     }
        // }
        this.fnCache.set(fn, result);

        // return the result
        return result;
    }
}
