import {Function, isFunctionDeclaration} from "@babel/types";
import {codeFromLocation} from "../misc/files";
import {GlobalState} from "../analysis/globalstate";
import {locationToString} from "../misc/util";
import {Node} from "@babel/core";
import {query} from "./predictpackage";
import { parse, ParserPlugin } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {randomUUID} from "node:crypto";


export function levenshteinDistance(s1: string[], s2: string[]) {
    const len1 = s1.length;
    const len2 = s2.length;
    const dp = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(null));

    for (let i = 0; i <= len1; i += 1) dp[i][0] = i;
    for (let j = 0; j <= len2; j += 1) dp[0][j] = j;

    for (let i = 1; i <= len1; i += 1) {
        for (let j = 1; j <= len2; j += 1) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }

    return dp[len1][len2];
}

function lcsLength(s1: string[], s2: string[]): number {
    const m = s1.length;
    const n = s2.length;

    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    return dp[m][n];
}


/**
 * Formats JavaScript code into a custom tokenized string stream, using AST traversal for precision.
 *
 * @param code - A valid JavaScript code string.
 * @param options - Options for tokenization.
 * @returns A formatted token stream as a string.
 */
export function tokenize(
    code: string,
    options: { sourceType?: 'script' | 'module'; plugins?: ParserPlugin[] } = {}
): string[] {
    interface BabelToken {
        type: { label: string };
        value?: string;
    }
    const tokens: string[] = [];
    try {
        const ast = parse(code, {
            sourceType: options.sourceType || 'module',
            plugins: options.plugins || ['jsx', 'typescript'],
            tokens: true,
        });

        const tokenMap: Set<string> = new Set();
        // Traverse the AST to identify variables
        traverse(ast, {
            // Variables declared in `const`, `let`, `var`
            VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
                if (t.isIdentifier(path.node.id)) {
                    tokenMap.add(path.node.id.name); // Add variable names to the map
                }
            },

            // Function parameters
            FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
                path.node.params.forEach(param => {
                    if (t.isIdentifier(param)) {
                        tokenMap.add(param.name);
                    }
                });
            },

            // Function expressions and arrow functions
            FunctionExpression(path: NodePath<t.FunctionExpression> | NodePath<t.ArrowFunctionExpression>) {
                path.node.params.forEach(param => {
                    if (t.isIdentifier(param)) {
                        tokenMap.add(param.name);
                    }
                });
            },
        });

        // Transform tokens into formatted string stream
        (ast.tokens ?? []).forEach((token: BabelToken) => {
            if (token.type.label === 'name' && token.value && tokenMap.has(token.value)) {
                // Mark variables as `Var:<name>`
                tokens.push(`Var:${token.value}`);
            } else if (token.type.label === 'string' || token.type.label === 'numeric') {
                // Handle literals
                tokens.push(`const:${token.value}`);
            } else {
                // Other tokens (keywords, punctuators, operators)
                tokens.push(token.value || token.type.label);
            }
        });
    } catch (error) {
        tokens.push("Unknown"+randomUUID())
    }
    return tokens;
}

export function similarity(code1: string[], code2: string[]) {
    const distance = lcsLength(code1, code2);
    const maxLen = Math.max(code1.length, code2.length);
    return (distance / maxLen);
}

let requireFunctionTokens = tokenize("function n(r) {var l = t[r];if (void 0 !== l) return l.exports;var a = t[r] = {exports: {}};return e[r](a, a.exports, n), a.exports}");

export function findRequireFunctionBySimilarity(a: GlobalState) {
    let requireFunction: Function | undefined = undefined;
    let bestSim = 0;
    for (const [func,funcInfo] of a.functionInfos) {
        if (!isFunctionDeclaration(func))
            continue;
        if (!funcInfo.inTopImmediateFunction)
            continue
        let funString = codeFromLocation(func.loc, -1);
        if (!funString.includes(".exports")) {
            continue;
        }
        let sim = similarity(tokenize(funString), requireFunctionTokens);
        if (func.params.length <= 2 && sim > bestSim) {
            bestSim = sim;
            requireFunction = func;
        }
    }
    return requireFunction;
}

export async function findRequireFunctionByML(a: GlobalState) {
    let requireFunction: Function | undefined = undefined;
    let bestSim = 0;
    for (const [func,] of a.functionInfos) {
        if (!isFunctionDeclaration(func))
            continue;
        let funString = codeFromLocation(func.loc, -1);
        if (!funString.includes(".exports")) {
            continue;
        }
        try {
            let sim = (await query(funString,1))[0].confidence;
            if (func.params.length <= 2 && sim > bestSim) {
                bestSim = sim;
                requireFunction = func;
            }
        } catch (e) {
            continue;
        }
    }
    return requireFunction;
}

export function findRequireFunctionByPatternMatching(a: GlobalState, funcNode: Node) {
    for (const [func,] of a.functionInfos) {
        if(locationToString(func.loc)===locationToString(funcNode.loc)) {
            return func;
        }
    }
    return undefined;
}
