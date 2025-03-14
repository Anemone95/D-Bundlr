function e(exp, field, func) {
    exp[field]=func;
}

let a={};
let b="b";
a[b] = function () {};
let c={b:a[b]};
e(exports, "b", c[b]);

let p = new Proxy(() => {}, {
    get: function(target, prop, receiver) {
        if (prop==="__secret__") {
            return "SSS"
        }
        if (prop==="__ACCESSPATH__") {
            return "p"
        }
        return Reflect.get(...arguments);
    }
});
p(exports);
