import {parse} from "@babel/parser";
import sequence from "./minify/sequence";
import generate from "@babel/generator";
import traverse, {TraverseOptions, visitors} from "@babel/traverse";
import {Transform, TransformState} from "./minify/misc";
import {Node} from "@babel/types";
import createElementTrans from "./minify/createElement";
import jsx from "./minify/jsx";
import splitvariabledecl from "./minify/splitvariabledecl";
import removeBlockStatement from "./minify/removeBlockStatement";

type Format= 'jsx' | 'js';
export function transformCode(input: string): [string, Format] {
    try {
        let [ast, state] = applyTransforms(input, [sequence, splitvariabledecl, createElementTrans, jsx, removeBlockStatement]);
        return [generate(ast, {}).code, state.isJSX? 'jsx': 'js'];
    } catch (e) {
        return [input, 'js'];
    }
}

export function applyTransform(input: string, transform: Transform): [Node, TransformState] {
    const ast = parse(input, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
    });

    const state: TransformState = {changes: 0, isJSX: false};
    transform.run?.(ast, state);
    const visitor = transform.visitor() as TraverseOptions<TransformState>
    visitor.noScope = !transform.scope;
    traverse(ast, visitor, undefined, state);
    // @ts-ignore
    state.isJSX = state.isJSX||visitor.jsx;
    return [ast, state];
}

export function applyTransforms(input: string, transforms: Transform[]): [Node, TransformState] {
    let ast = parse(input, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
    });

    const state: TransformState = {changes: 0, isJSX: false};
    for (const transform of transforms) {
        transform.run?.(ast, state);
    }

    const traverseOptions = transforms.flatMap((t) => t.visitor?.() ?? []);
    if (traverseOptions.length > 0) {
        const visitor: TraverseOptions<TransformState> =
            visitors.merge(traverseOptions);
        visitor.noScope = transforms.every((t) => !t.scope);
        traverse(ast, visitor, undefined, state);
        // @ts-ignore
        state.isJSX = state.isJSX || visitor.jsx;
    }

    return [ast, state];
}

if (require.main === module) {
    // let input = "let r = require('react');\n" +
    //     "\n" +
    //     "function Greeting({ name }) {\n" +
    //     "  return r.createElement(\n" +
    //     "    'h1',\n" +
    //     "    { className: 'greeting' },\n" +
    //     "    'Hello'\n" +
    //     "  );\n" +
    //     "}"
    // let [ast, state] = applyTransform(input, createElementTrans);
    // console.log(generate(ast).code);
    //
    let input = "{\n  \"use strict\";\n  c.r(t);\n  var n = require('react'),\n    r = n || n.default,\n    a = require('react-dom'),\n    i = a || a.default,\n    s = (require('./30.js'), require('./3.js')),\n    j = require('./2.js'),\n    o = require('react');\n}"
    let [ast, ] = applyTransform(input, sequence);
    console.log(generate(ast).code);
    // input = `
    //     u = function() {
    //       return Object(o.jsx)("div", {
    //         children: Object(o.jsx)("h3", {
    //           children: "Login"
    //         })
    //       });
    //     };
    // `
    // [ast, state] = applyTransform(input, jsx);
    // console.log(generate(ast).code);
}