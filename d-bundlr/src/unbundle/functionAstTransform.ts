import {isBlockStatement, Statement} from "@babel/types";
import * as t from "@babel/types";
import traverse from "@babel/traverse";
import * as m from '@codemod/matchers';

export function transformFunctionAst(ast: t.Node): t.Node {
    let replacedNode = new Set();
    const callMatcher = m.callExpression(m.Import())
    traverse(ast, {
        ForStatement(path) {
            let stmts: Array<Statement> = [];
            if (path.node.init) {
                if (t.isVariableDeclaration(path.node.init)) {
                    stmts.push(path.node.init);
                } else {
                    stmts.push(t.expressionStatement(path.node.init));
                }
            }
            if (path.node.test) {
                stmts.push(t.ifStatement(path.node.test, t.blockStatement([])));
            }
            if (path.node.update) {
                stmts.push(t.expressionStatement(path.node.update));
            }
            if (isBlockStatement(path.node.body)) {
                stmts.push(...path.node.body.body);
            } else {
                stmts.push(path.node.body);
            }
            path.replaceWith(t.ifStatement(t.booleanLiteral(true), t.blockStatement(stmts)));
        },
        BreakStatement(path) {
            path.replaceWith(t.emptyStatement());
        },
        ContinueStatement(path) {
            path.replaceWith(t.emptyStatement());
        },
        CallExpression(path) {
            /**
             * if(!VM_INTERNAL["loc"]){
             *   VM_INTERNAL["loc"]=true;
             *   call();
             * } else {
             *   DummyClass.getInstance('call()');
             * }
             */
            if (!replacedNode.has(path.node)) {
                replacedNode.add(path.node);
                if (!path.node.loc) {
                    return;
                }

                if (callMatcher.match(path.node)) {
                    path.replaceWith(t.callExpression(t.identifier("require"), path.node.arguments))
                }
                let locStr = `${path.node.loc!.start.line}:${path.node.loc!.start.column}:${path.node.loc!.end.line}:${path.node.loc!.end.column}`;
                let dummyCallExpression = t.callExpression(t.memberExpression(t.identifier("DummyClass"), t.identifier("getInstance")), [t.stringLiteral(path.toString())]);
                replacedNode.add(dummyCallExpression);
                path.replaceWith(t.ifStatement(
                    t.unaryExpression("!", t.memberExpression(t.identifier("VM_INTERNAL"), t.stringLiteral(locStr), true)),
                    t.blockStatement([
                        t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("VM_INTERNAL"), t.stringLiteral(locStr), true), t.booleanLiteral(true))),
                        t.expressionStatement(path.node)]),
                    t.expressionStatement(dummyCallExpression))
                );
            }
        },
        DoWhileStatement(path) {
            let stmts: Array<Statement> = [];
            if (isBlockStatement(path.node.body)) {
                stmts.push(...path.node.body.body);
            } else {
                stmts.push(path.node.body);
            }
            if (path.node.test) {
                stmts.push(t.ifStatement(path.node.test, t.blockStatement([])));
            }
            path.replaceWith(t.ifStatement(t.booleanLiteral(true), t.blockStatement(stmts)));
        },
        WhileStatement(path) {
            let stmts: Array<Statement> = [];
            if (path.node.test) {
                stmts.push(t.ifStatement(path.node.test, t.blockStatement([])));
            }
            if (isBlockStatement(path.node.body)) {
                stmts.push(...path.node.body.body);
            } else {
                stmts.push(path.node.body);
            }
            path.replaceWith(t.ifStatement(t.booleanLiteral(true), t.blockStatement(stmts)));
        },
        UnaryExpression(path) {
            /**
             * typeof x => if (x && x[DummyClass.IS_PROXIED] && x[DummyClass.PRIMITIVE_TYPE]) return x[DummyClass.PRIMITIVE_TYPE] else typeof x;
             */
            if (path.node.operator === "typeof" && !replacedNode.has(path.node)) {
                replacedNode.add(path.node);
                let dummyClassIsProxied = t.memberExpression(path.node.argument, t.memberExpression(t.identifier("DummyClass"), t.identifier("IS_PROXIED")), true);
                let dummyClassPrimitiveType = t.memberExpression(path.node.argument, t.memberExpression(t.identifier("DummyClass"), t.identifier("PRIMITIVE_TYPE")), true);
                path.replaceWith(t.conditionalExpression(t.logicalExpression("&&", path.node.argument, t.logicalExpression("&&", dummyClassIsProxied, dummyClassPrimitiveType)), dummyClassPrimitiveType, path.node));
            }
        },
    });
    return ast;
}
export function transformModuleAst(ast: t.Node): t.Node {
    let replacedNode = new Set();
    const callMatcher = m.callExpression(m.Import())
    traverse(ast, {
        CallExpression(path) {
            if (!replacedNode.has(path.node)) {
                replacedNode.add(path.node);
                if (!path.node.loc) {
                    return;
                }
                if (callMatcher.match(path.node)) {
                    path.replaceWith(t.callExpression(t.identifier("require"), path.node.arguments))
                }
            }
        },
    });
    return ast;
}