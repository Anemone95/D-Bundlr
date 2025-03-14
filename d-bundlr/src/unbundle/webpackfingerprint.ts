export const MODULES_MAP="MODULES_MAP";
export const webpackRequire: Record<string, string> = {
    GITHUB: `
    function $ID$($ID$) {
        if (/.*/) return /.*/;
        var $ID$ = $ID$[$ID$] = {
            /.*/
        };
        return #${MODULES_MAP}:ID#[$ID$].call($ID$.exports, $ID$, $ID$.exports, $ID$), /.*/, /.*/
    }
    `,
    WEBPACK_REQUIRE_GEIWOHUO: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) {
            return $ID$.$ID$;
        }
        var $ID$ = $ID$[$ID$] = {/.*/};
        #${MODULES_MAP}:ID#[$ID$].call($ID$.$ID$, $ID$, $ID$.$ID$, $ID$);
        $ID$.$ID$ = /.*/;
        return $ID$.$ID$;
    }`,
    WEBPACK_REQUIRE_GEIWOHUO_COMPILED: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = $ID$[$ID$] = {/.*/};
        return #${MODULES_MAP}:ID#[$ID$].call(/.*/), $ID$.exports
    }`,
    // TODO: unwrap (exp) to exp ?
    WEBPACK_REQUIRE_GEIWOHUO_COMPILED2: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/;
        return (#${MODULES_MAP}:ID#[$ID$].call(/.*/), /.*/, $ID$.exports);
    }
    `,
    WEBPACK_REQUIRE_GEIWOHUO_COMPILED3: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/;
        return #${MODULES_MAP}:ID#[$ID$].call(/.*/), /.*/, $ID$.exports;
    }
    `,
    WEBPACK_REQUIRE_THEGOLFFACTORY: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/;
        return #${MODULES_MAP}:ID#[$ID$](/.*/), /.*/, $ID$.exports;
    }
    `,
    Webpack4RequireOriginal: `
    function $ID$($ID$) {
        if ($ID$[$ID$]) return $ID$[$ID$].exports;
        var $ID$ = $ID$[$ID$] = {
            $ID$: $ID$,
            $ID$: !1,
            exports: {}
        };
        return #${MODULES_MAP}:ID#[$ID$].call($ID$.exports, $ID$, $ID$.exports, $ID$), $ID$.$ID$ = !0, $ID$.exports
    }`,
    Webpack5RequireOriginal: `function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/,
            $ID$ = !0;
        try {
            #${MODULES_MAP}:ID#[$ID$](/.*/), $ID$ = !1
        } finally {
            $ID$ && delete $ID$[$ID$]
        }
        return $ID$.exports
    }`,
    gmarket: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/,
            $ID$ = !0;
        try {
            #${MODULES_MAP}:ID#[$ID$].call(/.*/), /.*/
        } finally {
            $ID$ && delete $ID$[$ID$]
        }
        return $ID$.exports
    }
    `,
    ecommerce:`
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/,
            $ID$ = !0;
        try {
            #${MODULES_MAP}:ID#[$ID$].call(/.*/), /.*/;
        } finally {
            $ID$ && delete $ID$[$ID$]
        }
        return /.*/, $ID$.exports;
    }
    `,
    statoprono:
    `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        return (
            void /.*/ ||
                (($ID$ = $ID$[$ID$] = { exports: {} }), $ID$[$ID$]($ID$, $ID$.exports, $ID$)),
            $ID$.exports
        );
    }
    `,
    React16RequireOriginal: `function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/) return $ID$.exports;
        var $ID$ = /.*/;
        return #${MODULES_MAP}:ID#[$ID$]($ID$, $ID$.exports, $ID$), $ID$.exports
    }`,
    CJSRequireFunction_Minified: `
    function $ID$($ID$) {
        var $ID$ = $ID$[$ID$];
        if (/.*/ !== /.*/) return $ID$.exports;
        var $ID$ = /.*/;
        return #${MODULES_MAP}:ID#[$ID$]($ID$, $ID$.exports, $ID$), $ID$.exports
    }`,
};
export const webpackOtherRuntime: Record<string, string> = {
    RequirePartial: `$ID[$ID].call($ID.exports, $ID, $ID.exports, $ID)`,
    RequirePartial2: `$ID[$ID].call($ID.exports, $ID, $ID.exports)`,
    RequireRuntimeGlobal_Minified: `
    $ID$.$ID$ = function () {
        if (/.*/) return globalThis;
        try {
          return this || new Function("return this")()
        } catch ($ID$) {
          if ("object" == typeof window) return window
        }
    }()`,

    ES6RuntimeDefine: `
(() => {
    __webpack_require__.$ID$ = (exports, definition) => {
        for(var key in definition) {
            if(__webpack_require__.$ID$(definition, key) && !__webpack_require__.$ID$(exports, key)) {
                Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
            }
        }
    };
    })();
`,

    ES6RuntimeDefine_Minified: `
for (var $ID$ in $ID$) $ID$.$ID$($ID$, $ID$) && !$ID$.$ID$($ID$, $ID$) && Object.defineProperty($ID$, $ID$, {
    enumerable: !0,
    get: $ID$[$ID$]
})
`,

    ES6RuntimeMake: `
    (() => {
        __webpack_require__.$ID$ = (exports) => {
                if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
                    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
                }
                Object.defineProperty(exports, '__esModule', { value: true });
        };
    })();`,

    ES6RuntimeFullMinified: `
    {
        $ID$: ($ID$, $ID$) => {
            for (var $ID$ in $ID$) $ID$.$ID$($ID$, $ID$) && !$ID$.$ID$($ID$, $ID$) && Object.defineProperty($ID$, $ID$, {
                enumerable: !0,
                get: $ID$[$ID$]
            })
        };
        $ID$: ($ID$, $ID$) => Object.prototype.hasOwnProperty.call($ID$, $ID$);
        $ID$: $ID$ => {
            "undefined" != typeof Symbol && Symbol.toStringTag && Object.defineProperty($ID$, Symbol.toStringTag, {
                value: "Module"
            }), Object.defineProperty($ID$, "__esModule", {
                value: !0
            })
        }
    }
`,
    EXPORTS: `$ID$[$ID$].exports`,
    EXPORTS2: `$ID$[$ID$]($ID$, $ID$.exports, $ID$)`
};

export const webpackChunk: Record<string, string> = {
    chunk1: `(/(self|this)/.#NAMESPACE:webpack.*# = /(self|this)/./webpack.*/ || []).push([/.*/,$RETURN$])`,
    chunk2: `(/(self|this)/.#NAMESPACE:webpack.*# = /(self|this)/./webpack.*/ || []).push([/.*/,$RETURN$,/.*/])`,
    chunk3: `(/(self|this)/["#NAMESPACE:webpack.*#"] = /(self|this)/["/webpack.*/"] || []).push([/.*/,$RETURN$])`,
    chunk4: `(/(self|this)/["#NAMESPACE:webpack.*#"] = /(self|this)/["/webpack.*/"] || []).push([/.*/,$RETURN$,/.*/])`,
    chunk5: `(/(globalThis|window)/.#NAMESPACE:.*# = /(globalThis|window)/./.*/ || []).push([/.*/,$RETURN$])`,
    chunk7: `(/(globalThis|window)/["#NAMESPACE:.*#"] = /(globalThis|window)/["/.*/"] || []).push([/.*/,$RETURN$])`,
    chunk6: `(/(globalThis|window)/.#NAMESPACE:.*# = /(globalThis|window)/./.*/ || []).push([/.*/,$RETURN$,/.*/])`,
    chunk8: `(/(globalThis|window)/["#NAMESPACE:.*#"] = /(globalThis|window)/["/.*/"] || []).push([/.*/,$RETURN$,/.*/])`,
    chunk999: `#NAMESPACE:webpack[a-zA-Z]*#(/.*/,$RETURN$)`,
}
