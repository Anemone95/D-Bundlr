import {SessionManager} from './sessions';

const s = new SessionManager();

export interface ILocation {
    // scriptId: string;
    scriptName: string;
    line: number;
    column: number;
}

/**
 * return function location, if native function then return null
 */
export async function locate(fn: (...args: any[]) => any): Promise<ILocation | undefined> {
    return await s.locate(fn);
}
