import path, {sep} from "path";
import fs from "fs";
import {execSync} from "child_process";
import {extractSingle} from "./extract";
import logger from "../misc/logger";

const TEMPLATE_PROJECT = __dirname + `${sep}..${sep}..${sep}resources${sep}compilerTemplate`;

function copyDirectory(src: string, dest: string) {
    fs.readdirSync(src, { withFileTypes: true }).forEach(dirent => {
        const source = path.join(src, dirent.name);
        const destination = path.join(dest, dirent.name);

        if (dirent.isDirectory()) {
            if (!fs.existsSync(destination)) {
                fs.mkdirSync(destination);
            }
            copyDirectory(source, destination);
        } else {
            fs.copyFileSync(source, destination);
        }
    });
}

function getMainCode(packageName:string){
    return `import * as R from '${packageName}';
    let fields1 = new Set();
    let queue = [[R,0]];
    let visitedObjects = new Set();
    while (queue.length > 0) {
        let [obj,level] = queue.shift();
        if (visitedObjects.has(obj))
            continue;
        visitedObjects.add(obj);
        if (obj && (typeof obj === "object" || typeof obj === "function")) {
            for (let k of Object.keys(obj)) {
                if ((k === "default"|| k.includes("esModule")) && level === 0) {
                    queue.push([obj[k], level+1]);
                } else {
                    if (level===0 && Object.keys(obj).length === 1) {
                        queue.push([obj[k], level+1]);
                    }
                    if (level === 0 && obj[k].prototype) {
                        queue.push([obj[k].prototype, level+1]);
                    }
                    fields1.add(k);
                }
            }
        }
    }
    _MODULE.exportField = fields1;`;
}

export function preparePackageDir(name: string, version: string, packages_dir: string): string {
    // write main code
    const packageDir = path.join(packages_dir, name, version);
    const bundlePath = path.join(packageDir,'dist', 'bundle.js');
    name = name.replace('__', '/');
    if (!fs.existsSync(TEMPLATE_PROJECT)) {
        throw new Error('Template directory does not exist.');
    }
    if (fs.existsSync(bundlePath)) {
        return packageDir;
    }
    if (fs.existsSync(packageDir)) {
        
    }
    fs.mkdirSync(packageDir, { recursive: true });
    copyDirectory(TEMPLATE_PROJECT, packageDir);

    const mainCode = getMainCode(name);
    fs.writeFileSync(path.join(packageDir, 'main.js'), mainCode);

    // npm install
    logger.info("pnpm install --ignore-scripts")
    execSync(`pnpm install ${name}@${version} --verbose`, { cwd: packageDir, stdio: 'inherit' });
    logger.info("npm run build")
    execSync('npm run build', { cwd: packageDir, stdio: 'inherit' });
    return packageDir;
}

export function ensureAbsolutePath(inputPath: string) {
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }
    return path.resolve(inputPath);
}

async function collectPackage(name: string, version: string, outputDir: string, packages_dir: string) {

    let packageDir = preparePackageDir(name, version, packages_dir);
    packageDir = ensureAbsolutePath(packageDir);
    const bundlePath = path.join(packageDir, 'dist', 'bundle.js');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    // collect code mapping
    await extractSingle(bundlePath, packageDir, outputDir, name);
}

if (require.main === module) {
    (async () => {
        const packageName = process.argv[2];
        const packageVersion = process.argv[3];
        const output = process.argv[4];
        const packagesDir = process.argv[5];
        await collectPackage(packageName, packageVersion, output, packagesDir);
    })();
}
