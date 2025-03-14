import path from "path";
import fs from "fs";
import {extractSingle} from "./extract";
import {ensureAbsolutePath, preparePackageDir} from "./collectCodeMappingByCompile";
import {execSync} from "child_process";

async function collectPackage(name: string, version: string, outputDir: string, packages_dir: string, collectingFunctions: Record<string, Array<any>>) {
    let packageDir = path.join(packages_dir, name, version);
    const bundlePath = path.join(packageDir, 'dist', 'bundle.js');
    if (fs.existsSync(packageDir)) {
        execSync('npm run build', { cwd: packageDir, stdio: 'inherit' });
    } else {
        packageDir = preparePackageDir(name, version, packages_dir);
        packageDir = ensureAbsolutePath(packageDir);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
    }

    // collect code mapping
    await extractSingle(bundlePath, packageDir, outputDir, name, collectingFunctions);
}

if (require.main === module) {
    (async () => {
        const packageName = "io";
        const packageVersion = "latest";
        const output = "./bundle/jelly/tmp";
        const packagesDir = "./bundle/jelly/tmp";
        // the first argument is this
        await collectPackage(packageName, packageVersion, output, packagesDir, {
            // "io": ["http://google.com"],
            // "decode": ["SGVsbG8gd29ybGQ="],
            // "toBase64": ["SGVsbG8gd29ybGQ"],
            // "fromBase64": ["SGVsbG8gd29ybGQ="],
            // "parse": ["?foo=bar"],
            // "pick": ["https://foo.bar?foo=bar", ['foo']],
            // "exclude": ["https://foo.bar?foo=bar", ['foo']]
        });
    })();
}
