import { extractSingle } from "./unbundle/extract";

type CommandLineOptions = {
    basedir: string;
    compiledFile: string;
    output: string;
    packageName: string;
};

function parseArguments(args: string[]): CommandLineOptions {
    const options: CommandLineOptions = {basedir: '', compiledFile: '', output: '', packageName: ''};
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--basedir':
                options.basedir = args[i + 1];
                i++;  // Skip next value as it is consumed as the option's argument
                break;
            case '--compiled-file':
                options.compiledFile = args[i + 1];
                i++;  // Skip next value
                break;
            case '--output':
                options.output = args[i + 1];
                i++;  // Skip next value
                break;
            case '--package-name':
                options.packageName = args[i + 1];
                i++;  // Skip next value
                break;
        }
    }
    return options;
}

async function main() {
    const myArgs = process.argv.slice(2);  // Remove the first two elements
    const argOptions = parseArguments(myArgs);
    let compiledFile = argOptions.compiledFile;
    let originalRoot = argOptions.basedir;
    let output = argOptions.output;
    let packageName = argOptions.packageName;
    await extractSingle(compiledFile, originalRoot, output, packageName);
}

(async () => {
    await main();
})();
