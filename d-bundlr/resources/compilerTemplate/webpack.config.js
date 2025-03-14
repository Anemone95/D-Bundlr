const path = require("path");
module.exports = {
    // Assuming the entry file is located at <project_root>/src/index.js
    entry: "./main.js", // Make sure this path is correct
    output: {
        filename: "bundle.js",
        path: path.resolve(__dirname, "dist"), // Output directory
    },
    devtool: "source-map",
    // Other configurations...
};
