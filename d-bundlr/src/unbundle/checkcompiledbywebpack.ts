import {parseAndDesugar} from "../parsing/parser";
import logger from "../misc/logger";
import fs from "fs";
import {File} from "@babel/types";
import {webpackChunk, webpackOtherRuntime, webpackRequire} from "./webpackfingerprint";
import {isSubTree, MATCHED_NODE} from "./subASTSearch";
import {Node} from "@babel/core";

function checkFileIsMain(ast: Node): [true, Map<string, Node | Node[]>] | [false, undefined] {
    for (const version of Object.keys(webpackRequire)) {
        let [isMain, map] = isSubTree(webpackRequire[version], ast, 12);
        if (isMain) {
            return [true, map!];
        }
    }
    for (const version of Object.keys(webpackOtherRuntime)) {
        let [isMain, ] = isSubTree(webpackOtherRuntime[version], ast, 20);
        if (isMain) {
            return [true, new Map()];
        }
    }
    return [false, undefined];
}

function checkFileIsChunk(ast: Node): [true, Map<string, Node | Node[]>] | [false, undefined] {
    for (const version of Object.keys(webpackChunk)) {
        let [isChunk, map] = isSubTree(webpackChunk[version], ast, 4);
        if (isChunk) {
            return [true, map!];
        }
    }
    return [false, undefined];
}

export function isCompiledByWebpack(file: string):
    ["main" | "chunk", File, Map<string, Node | Node[]>] | [undefined, File|undefined, Map<string, Node | Node[]>]
{
    const str = fs.readFileSync(file, "utf8");
    logger.info(`Checking ${file} (${Math.ceil(str.length / 1024)}KB)...`);
    const ast = parseAndDesugar(str, file);
    if (!ast) {
        logger.error(`${file} failed to parse`);
        return [undefined, undefined, new Map()];
    }
    let [isChunk, map] = checkFileIsChunk(ast);
    if (isChunk && map) {
        let loc = (map.get(MATCHED_NODE)! as Node).loc;
        let startLine = loc?.start.line;
        if (!startLine || startLine-20>0)
            return [undefined, ast, new Map()];
        let endLine = loc?.end.line;
        let fileLines = ast.loc?.end.line;
        if (!fileLines || !endLine || fileLines-endLine>20)
            return [undefined, ast, new Map()];
        return ["chunk", ast, map!];
    }
    let [isMain, map2] = checkFileIsMain(ast);
    if (isMain)
        return ["main", ast, map2!];
    return [undefined, ast, new Map()];
}

if (require.main === module) {
    const myArgs = process.argv.slice(2);  // Remove the first two elements
    if (myArgs.length === 0) {
        logger.error("No file provided");
        process.exit(1);
    }
    const file = myArgs[0];
    const [res,,] = isCompiledByWebpack(file);
    if (res === "main") {
        logger.error(`${file} is a main file`);
    } else if (res === "chunk") {
        logger.error(`${file} is a chunk file`);
    } else {
        logger.error(`${file} is not compiled by webpack`);
    }
}
