import logger from "../../misc/logger";
import fs, {existsSync} from "fs";
import path from "path";

interface SourceMap {
    version: number;
    file: string;
    sourceRoot: string;
    sources: string[];
    sourcesContent: (string | null)[];
    names: string[];
    mappings: string;
    ignoreList?: number[];
    sections?: any[]
}
interface RichSources {
    name: string;
    content: string;
    data: Int32Array;
    dataLength: 0
}


const vlqTable = new Uint8Array(128);
const vlqChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (let i = 0; i < vlqTable.length; i++) vlqTable[i] = 0xFF;
for (let i = 0; i < vlqChars.length; i++) vlqTable[vlqChars.charCodeAt(i)] = i;


function decodeMappings(mappings: any, sourcesCount: any, namesCount: any) {
    const n = mappings.length;
    let data = new Int32Array(1024);
    let dataLength = 0;
    let generatedLine = 0;
    let generatedLineStart = 0;
    let generatedColumn = 0;
    let originalSource = 0;
    let originalLine = 0;
    let originalColumn = 0;
    let originalName = 0;
    let needToSortGeneratedColumns = false;
    let i = 0;

    function decodeError(text: string) {
        const error = `Invalid VLQ data at index ${i}: ${text}`;
        logger.error(`The "mappings" field of the imported source map contains invalid data. ${error}.`);
        throw new Error(error);
    }

    function decodeVLQ() {
        let shift = 0;
        let vlq = 0;

        // Scan over the input
        while (true) {
            // Read a byte
            if (i >= mappings.length) decodeError('Unexpected early end of mapping data');
            const c = mappings.charCodeAt(i);
            if ((c & 0x7F) !== c) decodeError(`Invalid mapping character: ${JSON.stringify(String.fromCharCode(c))}`);
            const index = vlqTable[c & 0x7F];
            if (index === 0xFF) decodeError(`Invalid mapping character: ${JSON.stringify(String.fromCharCode(c))}`);
            i++;

            // Decode the byte
            vlq |= (index & 31) << shift;
            shift += 5;

            // Stop if there's no continuation bit
            if ((index & 32) === 0) break;
        }

        // Recover the signed value
        return vlq & 1 ? -(vlq >> 1) : vlq >> 1;
    }

    while (i < n) {
        let c = mappings.charCodeAt(i);

        // Handle a line break
        if (c === 59 /* ; */) {
            // The generated columns are very rarely out of order. In that case,
            // sort them with insertion since they are very likely almost ordered.
            if (needToSortGeneratedColumns) {
                for (let j = generatedLineStart + 6; j < dataLength; j += 6) {
                    const genL = data[j];
                    const genC = data[j + 1];
                    const origS = data[j + 2];
                    const origL = data[j + 3];
                    const origC = data[j + 4];
                    const origN = data[j + 5];
                    let k = j - 6;
                    for (; k >= generatedLineStart && data[k + 1] > genC; k -= 6) {
                        data[k + 6] = data[k];
                        data[k + 7] = data[k + 1];
                        data[k + 8] = data[k + 2];
                        data[k + 9] = data[k + 3];
                        data[k + 10] = data[k + 4];
                        data[k + 11] = data[k + 5];
                    }
                    data[k + 6] = genL;
                    data[k + 7] = genC;
                    data[k + 8] = origS;
                    data[k + 9] = origL;
                    data[k + 10] = origC;
                    data[k + 11] = origN;
                }
            }

            generatedLine++;
            generatedColumn = 0;
            generatedLineStart = dataLength;
            needToSortGeneratedColumns = false;
            i++;
            continue;
        }

        // Ignore stray commas
        if (c === 44 /* , */) {
            i++;
            continue;
        }

        // Read the generated column
        const generatedColumnDelta = decodeVLQ();
        if (generatedColumnDelta < 0) needToSortGeneratedColumns = true;
        generatedColumn += generatedColumnDelta;
        if (generatedColumn < 0) decodeError(`Invalid generated column: ${generatedColumn}`);

        // It's valid for a mapping to have 1, 4, or 5 variable-length fields
        let isOriginalSourceMissing = true;
        let isOriginalNameMissing = true;
        if (i < n) {
            c = mappings.charCodeAt(i);
            if (c === 44 /* , */) {
                i++;
            } else if (c !== 59 /* ; */) {
                isOriginalSourceMissing = false;

                // Read the original source
                const originalSourceDelta = decodeVLQ();
                originalSource += originalSourceDelta;
                if (originalSource < 0 || originalSource >= sourcesCount) decodeError(`Original source index ${originalSource} is invalid (there are ${sourcesCount} sources)`);

                // Read the original line
                const originalLineDelta = decodeVLQ();
                originalLine += originalLineDelta;
                if (originalLine < 0) decodeError(`Invalid original line: ${originalLine}`);

                // Read the original column
                const originalColumnDelta = decodeVLQ();
                originalColumn += originalColumnDelta;
                if (originalColumn < 0) decodeError(`Invalid original column: ${originalColumn}`);

                // Check for the optional name index
                if (i < n) {
                    c = mappings.charCodeAt(i);
                    if (c === 44 /* , */) {
                        i++;
                    } else if (c !== 59 /* ; */) {
                        isOriginalNameMissing = false;

                        // Read the optional name index
                        const originalNameDelta = decodeVLQ();
                        originalName += originalNameDelta;
                        if (originalName < 0 || originalName >= namesCount) decodeError(`Original name index ${originalName} is invalid (there are ${namesCount} names)`);

                        // Handle the next character
                        if (i < n) {
                            c = mappings.charCodeAt(i);
                            if (c === 44 /* , */) {
                                i++;
                            } else if (c !== 59 /* ; */) {
                                decodeError(`Invalid character after mapping: ${JSON.stringify(String.fromCharCode(c))}`);
                            }
                        }
                    }
                }
            }
        }

        // Append the mapping to the typed array
        if (dataLength + 6 > data.length) {
            const newData = new Int32Array(data.length << 1);
            newData.set(data);
            data = newData;
        }
        data[dataLength] = generatedLine;
        data[dataLength + 1] = generatedColumn;
        if (isOriginalSourceMissing) {
            data[dataLength + 2] = -1;
            data[dataLength + 3] = -1;
            data[dataLength + 4] = -1;
        } else {
            data[dataLength + 2] = originalSource;
            data[dataLength + 3] = originalLine;
            data[dataLength + 4] = originalColumn;
        }
        data[dataLength + 5] = isOriginalNameMissing ? -1 : originalName;
        dataLength += 6;
    }

    return data.subarray(0, dataLength);
}

function parseSourceMap(jsonStr: string): { richSources: RichSources[], names: string[], data: Int32Array } {
    let json: SourceMap;
    try {
        json = JSON.parse(jsonStr) as SourceMap;
    } catch (e) {
        logger.error(`The imported source map contains invalid JSON data: ${e}`);
        throw e;
    }

    if (json.version !== 3) {
        logger.error(`The imported source map is invalid. Expected the "version" field to contain the number 3.`);
        throw new Error('Invalid source map');
    }

    if (json.sections instanceof Array) {
        const sections = json.sections;
        const decodedSections = [];
        let totalDataLength = 0;

        for (let i = 0; i < sections.length; i++) {
            const { offset: { line, column }, map } = sections[i];
            if (typeof line !== 'number' || typeof column !== 'number') {
                logger.info(`The imported source map is invalid. Expected the "offset" field for section ${i} to have a line and column.`);
                throw new Error('Invalid source map');
            }

            if (!map) {
                logger.info(`The imported source map is unsupported. Section ${i} does not contain a "map" field.`);
                throw new Error('Invalid source map');
            }

            if (map.version !== 3) {
                logger.info(`The imported source map is invalid. Expected the "version" field for section ${i} to contain the number 3.`);
                throw new Error('Invalid source map');
            }

            if (!(map.sources instanceof Array) || map.sources.some((x: any) => typeof x !== 'string')) {
                logger.info(`The imported source map is invalid. Expected the "sources" field for section ${i} to be an array of strings.`);
                throw new Error('Invalid source map');
            }

            if (typeof map.mappings !== 'string') {
                logger.info(`The imported source map is invalid. Expected the "mappings" field for section ${i} to be a string.`);
                throw new Error('Invalid source map');
            }

            const { sources, sourcesContent, names, mappings } = map;
            const emptyData = new Int32Array(0);
            for (let i = 0; i < sources.length; i++) {
                sources[i] = {
                    name: sources[i],
                    content: sourcesContent && sourcesContent[i] || '',
                    data: emptyData,
                    dataLength: 0,
                };
            }

            const data = decodeMappings(mappings, sources.length, names ? names.length : 0);
            decodedSections.push({ offset: { line, column }, sources, names, data });
            totalDataLength += data.length;
        }

        decodedSections.sort((a, b) => {
            if (a.offset.line < b.offset.line) return -1;
            if (a.offset.line > b.offset.line) return 1;
            if (a.offset.column < b.offset.column) return -1;
            if (a.offset.column > b.offset.column) return 1;
            return 0;
        });

        const mergedData = new Int32Array(totalDataLength);
        const mergedSources = [];
        const mergedNames = [];
        let dataOffset = 0;

        for (const { offset: { line, column }, sources, names, data } of decodedSections) {
            const sourcesOffset = mergedSources.length;
            const nameOffset = mergedNames.length;

            for (let i = 0, n = data.length; i < n; i += 6) {
                if (data[i] === 0) data[i + 1] += column;
                data[i] += line;
                if (data[i + 2] !== -1) data[i + 2] += sourcesOffset;
                if (data[i + 5] !== -1) data[i + 5] += nameOffset;
            }

            mergedData.set(data, dataOffset);
            for (const source of sources) mergedSources.push(source);
            if (names) for (const name of names) mergedNames.push(name);
            dataOffset += data.length;
        }

        return {
            richSources: mergedSources,
            names: mergedNames,
            data: mergedData,
        };
    }

    if (!(json.sources instanceof Array) || json.sources.some(x => typeof x !== 'string')) {
        logger.info(`The imported source map is invalid. Expected the "sources" field to be an array of strings.`);
        throw new Error('Invalid source map');
    }

    if (typeof json.mappings !== 'string') {
        logger.info(`The imported source map is invalid. Expected the "mappings" field to be a string.`);
        throw new Error('Invalid source map');
    }

    let richSources: RichSources[] = [];
    const { sources, sourcesContent, names, mappings } = json;
    const emptyData = new Int32Array(0);
    for (let i = 0; i < sources.length; i++) {
        richSources[i] = {
            name: sources[i],
            content: sourcesContent && sourcesContent[i] || '',
            data: emptyData,
            dataLength: 0,
        };
    }
    const data = decodeMappings(mappings, sources.length, names ? names.length : 0);
    return { richSources, names, data };
}

export function unpackFile(file: string, outputRoot: string): boolean {
    let mapFile = file+".map";
    if (!existsSync(mapFile))
        return false;
    const str = fs.readFileSync(mapFile, "utf8");
    const {richSources} = parseSourceMap(str);
    for (let {name, content} of richSources) {
        if (name.startsWith("webpack://"))
            name = name.replace("webpack://","");
        if (!(name.endsWith("js")||name.endsWith("jsx")||name.endsWith("ts")||name.endsWith("tsx")))
            name+=".js";
        let filePath = path.join(outputRoot, path.resolve('/',name));
        if (!fs.existsSync(path.dirname(filePath))) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
        }
        fs.writeFileSync(filePath, content);
    }
    return true;
}
function findNodeModulesSubdirs(rootDir: string): string[] {
    let result: string[] = [];

    /**
     * Recursively traverses directories.
     * @param dir The current directory being checked.
     */
    function traverse(dir: string): void {
        // if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;

        // Read the directory contents
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        let s = dir.split(path.sep);
        // Check if the current directory is `node_modules`
        if (s[s.length-2] === 'node_modules' || (dir.split(path.sep)[s.length-3]==="node_modules" && dir.split(path.sep)[s.length-2].startsWith("@"))) {
            result.push(dir);
        }

        // Recursively traverse subdirectories (excluding `node_modules` itself)
        for (const entry of entries) {
            if (entry.isDirectory()) {
                traverse(path.join(dir, entry.name));
            }
        }
    }

    traverse(rootDir);
    return result;
}

export function unpackFiles(srcFiles: string[], outputRoot: string, base:string): void {
    for (let file of srcFiles) {
        if (!path.isAbsolute(file))
             file = path.resolve(base, file);
        let hasSourceMap = unpackFile(file, outputRoot);
        if (hasSourceMap) {
            const relPath = path.relative(base, file);
            const finalOutputPath = path.join(outputRoot+'-bundle', relPath);
            if (!fs.existsSync(path.dirname(finalOutputPath))) {
                fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true });
            }
            fs.copyFileSync(file, finalOutputPath);
            fs.copyFileSync(file+".map", finalOutputPath+".map");
        }
    }
    // fix packages.json
    let libraries = findNodeModulesSubdirs(outputRoot)
    for (let lib of libraries) {
        console.log(lib);
        let files = fs.readdirSync(lib, { withFileTypes: true });
        let jsFiles = files.filter(f => f.isFile() && (f.name.endsWith(".js")||f.name.endsWith(".ts")) ).map(f => f.name);
        let indexMap: Array<string> = [];
        if (jsFiles.includes("index.js")) {
            indexMap.push("index.js");
        } else if (jsFiles.includes("index.ts")) {
            indexMap.push("index.ts");
        } else if (jsFiles.includes("main.ts")) {
            indexMap.push("main.ts");
        } else if (jsFiles.includes("main.js")) {
            indexMap.push("main.js");
        } else {
            indexMap = jsFiles;
        }
        if (indexMap.length>0) {
            let _exports = [];
            for (let f of indexMap) {
                _exports.push(`".": "./${f}"`);
            }
            let packageJsonContent = `{\n"exports": {\n ${_exports.join(",\n")} \n}}`
            fs.writeFileSync(path.join(lib, "package.json"), packageJsonContent);
        }
    }
}