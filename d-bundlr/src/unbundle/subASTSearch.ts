import {Node} from "@babel/core";
import {parseAndDesugar} from "../parsing/parser";

import {VISITOR_KEYS} from "@babel/types";
import assert from "assert";
import logger from "../misc/logger";
import {codeFromLocation} from "../misc/files";

export const MATCHED_NODE="MATCHED_NODE";
/**
 * check programTree contains pattern
 * Marcos:
 *  $ID$: identifier
 * @param pattern
 * @param programTree
 * @param depth
 */
export function isSubTree(pattern: Node | string, programTree: Node | string, depth: number = 100): [true, Map<string, Node | Node[]>] | [false, undefined] {
    let regexMap = new Map<string, RegExp>();
    // let placeHolders = new Map<string, string>();
    let patternAst:Node;
    function setRegexMap(key: string, value: RegExp) {
        assert(key !== MATCHED_NODE, "MATCHED_NODE is a reserved key");
        regexMap.set(key, value);
    }
    if (typeof pattern === "string") {
        let PATTERN = "PATTERN";
        let i = 0;
        while (true) {
            if (!/\/(.*?)\//.test(pattern) && !/\$(.*?)\$/.test(pattern)  && !/#([A-Z]*?):(.*?)#/.test(pattern))
                break;
            if (/#(.*?)#/.test(pattern)) {
                let match: RegExpMatchArray = pattern.match(/#(.*?)#/)!;
                let [key, reg] = match[1].split(":");
                if (reg === "ID")
                    reg = "^[a-zA-Z_$][a-zA-Z0-9_$]*$";
                setRegexMap(key, new RegExp(reg));
                pattern = pattern.replace(`#${match[1]}#`, key);
            }
            if (/\/(.*?)\//.test(pattern)) {
                let match: RegExpMatchArray = pattern.match(/\/(.*?)\//)!;
                let placeholder = `${PATTERN}${i++}`;
                setRegexMap(placeholder, new RegExp(match[1]));
                pattern = pattern.replace(`/${match[1]}/`, placeholder);
            }
            if (/\$(.*?)\$/.test(pattern)) {
                let match: RegExpMatchArray = pattern.match(/\$(.*?)\$/)!;
                let placeholder = `${PATTERN}${i++}`;
                if (match[1] === "ID") {
                    setRegexMap(placeholder, /^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
                } else if (match[1]) {
                    placeholder = match[1];
                    setRegexMap(match[1], /.*$/);
                }
                pattern = pattern.replace(`$${match[1]}$`, placeholder);
            }
        }

        patternAst = parseAndDesugar(pattern, "pattern.js")?.program!.body[0]!;
        if(!patternAst)
            logger.info(pattern);
        assert(patternAst);
    } else {
        patternAst = pattern;
    }
    if (patternAst.type === "ExpressionStatement")
        patternAst = patternAst.expression;
    if (typeof programTree === "string") {
        programTree = parseAndDesugar(programTree, "pattern.js")!;
    }
    let queue:Array<[Node, number]> = [[programTree,0]];
    while (queue.length > 0) {
        let [node, d] = queue.pop()!;
        if (d>depth)
            continue;
        let [matched, matchedResult] = matchNode(node, patternAst, regexMap);
        if (matched) {
            matchedResult.set(MATCHED_NODE, node);
            return [true, matchedResult];
        }

        for (let key of VISITOR_KEYS[node.type]) {
            let subNode = (<any>node)[key];
            if (Array.isArray(subNode)) {
                for (let sub of subNode) {
                    if (sub) {
                        let keys = Object.keys(sub);
                        if (keys.includes("type"))
                            queue.push([sub, d+1]);
                    }
                }
            } else if (subNode){
                let keys = Object.keys(subNode);
                if (keys.includes("type"))
                    queue.push([subNode, d+1]);
            }
        }
    }

    return [false, undefined];
}

const typeMap = new Map<string, string>([
    ["FunctionExpression", "FunctionDeclaration"],
]);

function matchNode(node: Node|Node[], pattern: Node, regexMap: Map<string, RegExp>, matchedResult: Map<string, Node|Node[]>=new Map()): [boolean, Map<string, Node|Node[]>] {
    let regexPattern;
    let patternName;
    if (pattern.type === "Identifier" && regexMap.has(pattern.name)) {
        regexPattern = regexMap.get(pattern.name);
        patternName = pattern.name;
    }
    if (pattern.type==="ObjectProperty" && pattern.key.type==="Identifier" && regexMap.has(pattern.key.name)) {
        regexPattern = regexMap.get(pattern.key.name);
        patternName = pattern.key.name;
    }
    if (regexPattern && patternName) {
        if (regexPattern && regexPattern.toString() === /.*/.toString()) {
            matchedResult.set(patternName, node);
            return [true, matchedResult];
        } else if (regexPattern && !Array.isArray(node) && regexPattern.test(node.type === "Identifier" ? node.name : node.type === "StringLiteral" ? node.value : codeFromLocation(node.loc!))) {
            matchedResult.set(patternName, node);
            return [true, matchedResult];
        } else
            return [false, matchedResult];
    }
    if (Array.isArray(node))
        return [false, matchedResult];
    else if (typeMap.get(node.type)??node.type === pattern.type) {
        if (pattern.type==="Identifier"||pattern.type==="StringLiteral") {
            let patternName = pattern.type === "Identifier" ? pattern.name : pattern.value;
            let regexPattern = regexMap.get(patternName);
            if (regexPattern) {
                if (regexPattern.toString() === /.*/.toString()) {
                    matchedResult.set(patternName, node);
                    return [true, matchedResult];
                } else if (node.type===pattern.type) {
                    let nodeName = node.type === "Identifier" ? node.name : node.value;
                    if (regexPattern.test(nodeName)) {
                        matchedResult.set(patternName, node);
                        return [true, matchedResult];
                    }
                }
                return [false, matchedResult];
            } else {
                if (node.type===pattern.type) {
                    let nodeName = node.type === "Identifier" ? node.name : node.value;
                    return [patternName === nodeName, matchedResult];
                } else {
                    return [false, matchedResult];
                }
            }
        }

        let patternFields = VISITOR_KEYS[pattern.type];
        let nodeFields = VISITOR_KEYS[node.type];
        if (patternFields.length!==nodeFields.length) {
            return [false, matchedResult];
        }
        for (let idx in patternFields) {
            let patternField = (<any>pattern)[patternFields[idx]];
            let nodeField = (<any>node)[nodeFields[idx]];
            if (Array.isArray(patternField)) {
                if (patternField.length === nodeField.length)
                    for (let i in patternField) {
                        if (!matchNode(nodeField[i], patternField[i], regexMap, matchedResult)[0]) {
                            return [false, matchedResult];
                        }
                    }
                else if (patternField.length === 1) {
                    return [matchNode(nodeField, patternField[0], regexMap, matchedResult)[0] || (nodeField.length===1 && matchNode(nodeField[0], patternField[0], regexMap, matchedResult)[0]), matchedResult];
                } else
                    return [false, matchedResult];
            } else if (patternField && nodeField) {
                if (!matchNode(nodeField, patternField, regexMap, matchedResult)[0]) {
                    matchNode(nodeField, patternField, regexMap, matchedResult);
                    return [false, matchedResult];
                }
            }
        }
        return [true, matchedResult];
    }
    return [false, matchedResult];
}


if (require.main === module) {
    let p = `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/;
        return (#MODULES_MAP:ID#[$ID$].call(/.*/), /.*/, $ID$.exports);
    }
    `
        // , /.*/, i.exports
    let program = `
    function o(e) {
        var t = r[e];
        if (void 0 !== t) return t.exports;
        var s = (r[e] = { id: e, loaded: !1, exports: {} });
        return (
            n[e].call(s.exports, s, s.exports, o), (s.loaded = !0), s.exports
        );
    }
    `;
    let res = isSubTree(p,program,12);
    console.log(res);
}
