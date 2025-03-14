import type {Node, Visitor} from "@babel/traverse";
import type { GeneratorOptions } from '@babel/generator';
import babelGenerate from '@babel/generator';
import type * as t from '@babel/types';
import type { Scope } from '@babel/traverse';
import { toIdentifier } from '@babel/types';
import * as m from '@codemod/matchers';


export type Tag = 'safe' | 'unsafe';

export interface Transform<TOptions = unknown> {
    name: string;
    tags: Tag[];
    scope?: boolean;
    run?: (ast: Node, state: TransformState, options?: TOptions) => void;
    visitor: (options?: TOptions) => Visitor<TransformState>;
}
export interface TransformState {
    changes: number;
    isJSX: boolean;
}

const defaultOptions: GeneratorOptions = { jsescOption: { minimal: true } };
export function generate(
    ast: t.Node,
    options: GeneratorOptions = defaultOptions,
): string {
    return babelGenerate(ast, options).code;
}

export function codePreview(node: t.Node): string {
    const code = generate(node, {
        minified: true,
        shouldPrintComment: () => false,
        ...defaultOptions,
    });
    if (code.length > 100) {
        return code.slice(0, 70) + ' … ' + code.slice(-30);
    }
    return code;
}

/**
 * Like scope.generateUid from babel, but without the underscore prefix and name filters
 */
export function generateUid(scope: Scope, name: string = 'temp'): string {
    let uid = '';
    let i = 1;
    do {
        uid = toIdentifier(i > 1 ? `${name}${i}` : name);
        i++;
    } while (
        scope.hasLabel(uid) ||
        scope.hasBinding(uid) ||
        scope.hasGlobal(uid) ||
        scope.hasReference(uid)
        );

    const program = scope.getProgramParent();
    program.references[uid] = true;
    program.uids[uid] = true;
    return uid;
}

/**
 * Matches both identifier properties and string literal computed properties
 */
export function constMemberExpression(
    object: string | m.Matcher<t.Expression>,
    property?: string | m.Matcher<string>,
): m.Matcher<t.MemberExpression> {
    if (typeof object === 'string') object = m.identifier(object);
    return m.or(
        m.memberExpression(object, m.identifier(property), false),
        m.memberExpression(object, m.stringLiteral(property), true),
    );
}

export function memberExpressionWithProperty(
    property: string | m.Matcher<string>,
): m.Matcher<t.Expression> {
    let object = m.anyExpression();
    let exp = m.or(
        m.memberExpression(object, m.identifier(property), false),
        m.memberExpression(object, m.stringLiteral(property), true),
    );
    return m.or(exp, m.sequenceExpression([m.numericLiteral(0), exp]), m.identifier(property), m.callExpression(m.identifier("Object"), [exp]));
}
