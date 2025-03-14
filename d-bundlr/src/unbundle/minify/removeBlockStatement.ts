import {Transform} from "./misc";
import {isBlockStatement} from "@babel/types";
export default {
    name: 'removeBlockStatement',
    tags: ['safe'],
    visitor: () => ({
        Program: {
            exit(path) {
                if (path.node.body.length===1 && isBlockStatement(path.node.body[0])) {
                    path.node.body=path.node.body[0].body;
                }
            },
        },
    }),
} satisfies Transform;