import path from "path";
import { extractSingle } from "./unbundle/extract";
import * as fs from 'fs';

function searchJSFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);

    files.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            searchJSFiles(fullPath, fileList);
        } else if (stat.isFile() && path.extname(fullPath) === '.js') {
            fileList.push(fullPath);
        }
    });

    return fileList;
}

async function main() {
    let buildDir = "/home/c01wexu/bundle/react/build.snapshot"
    const files = searchJSFiles(buildDir);
    for (const file of files) {
        const compiledFile = file;
        const originalRoot = "/home/c01wexu/bundle/react";
        await extractSingle(compiledFile, originalRoot, buildDir, "react*");
    }
}

(async () => {
    await main();
})();
