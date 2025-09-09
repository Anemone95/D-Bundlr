# Structure

- `./codepredict`: Machine-learning–based prediction service
- `./d-bundlr`: Debundling tools
- `./evaluations`: Batch scripts to reproduce the experimental results
- `./codeql`: CodeQL setup and helpers

# Setup

## 1) Set up the Code Predict Server

Install conda: <https://docs.conda.io/projects/conda/en/latest/user-guide/getting-started.html>

Then install dependencies and start the prediction server.

> **Choose one environment** (GPU _or_ CPU):

```bash
cd codepredict
# If you have a GPU:
conda env create -f ./environment-gpu.yml && conda clean -a -y
# Otherwise (CPU only):
# conda env create -f ./environment-cpu.yml && conda clean -a -y

conda activate ml

# Download our trained models
wget -O saved_models.zip "https://zenodo.org/records/15034484/files/saved_models.zip?download=1"
unzip saved_models.zip

# Start the server (logs go to log.txt; run in the background)
python3 ./predictServer.py &> log.txt &
```

**Quick test:**

```bash
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" \
     -d "{\"code\":\" function makeNamespaceObject(exports: any){ if(typeof Symbol !== 'undefined' && Symbol.toStringTag) { Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' }); } Object.defineProperty(exports, '__esModule', { value: true }); }  \"}"
```

If you see an output similar to:

```bash
[{"confidence":0.7002745270729065,"function":{"functionFile":"webpack/runtime/make namespace object","functionName":"__make_namespace_object__","packageName":"webpack-demo"}},{"confidence":0.5005811452865601,"function":{"functionFile":"lib/isTaxID.js","functionName":"_interopRequireWildcard","packageName":"validator"}},{"confidence":0.500332236289978,"function":{"functionFile":"browser/nunjucks.js","functionName":"gensym","packageName":"nunjucks"}}]
```

then the predictor is running correctly.

### (Optional) Train a model yourself

Download the full dataset: <https://zenodo.org/records/15034484/files/full-dataset.tgz?download=1>

```bash
cd codepredict
mkdir -p dataset/full-dataset
wget -O full-dataset.tgz "https://zenodo.org/records/15034484/files/full-dataset.tgz?download=1"
tar -xf full-dataset.tgz -C dataset/full-dataset
python3 ./train.py --data ./dataset/full-dataset
```

## 2) Set up CodeQL

```bash
cd codeql
export CODE_QL_HOME="$(pwd)/codeql-home"
export CODEQL_VERSION="2.20.5"

# Choose the appropriate CodeQL binary for your system
curl -L -o codeql.zip "https://github.com/github/codeql-cli-binaries/releases/download/v${CODEQL_VERSION}/codeql-linux64.zip" && \
  unzip codeql.zip -d "$CODE_QL_HOME" && \
  rm codeql.zip

curl -L -o codeql-repo.zip "https://github.com/github/codeql/archive/refs/tags/codeql-cli/v${CODEQL_VERSION}.zip" && \
  unzip codeql-repo.zip -d "$CODE_QL_HOME" && \
  mv "$CODE_QL_HOME/codeql-codeql-cli-v${CODEQL_VERSION}" "$CODE_QL_HOME/codeql-repo" && \
  rm codeql-repo.zip

cp ./codeqlagent.jar "$CODE_QL_HOME/codeqlagent.jar"
sed -i 's|com.semmle.js.extractor.AutoBuild|-javaagent:$CODE_QL_HOME/codeqlagent.jar com.semmle.js.extractor.AutoBuild|' "$CODE_QL_HOME/codeql/javascript/tools/autobuild.sh"
```

The last two lines hook the CodeQL file lookup to include every JavaScript file (incl. `node_modules`).

## 3) Set up d-bundlr

First install Node.js following <https://github.com/nodesource/distributions/blob/master/DEV_README.md>.

Then build and link the tool:

```bash
cd d-bundlr
npm install .
npm run build
npm link
```

# Usage

> The following commands assume the current directory is `d-bundlr`.

```bash
node ./lib/main.js <bundle> [--no-predict] \
  --basedir <base_dir> \
  --debundle-dir <output_dir> \
  --diagnostics-json <diagnostics_json>
```

**Options:**
- `<bundle>`: The bundle script, or a directory containing the bundle.
- `<base_dir>`: The project root. If `<bundle>` is a script, set this to the script’s directory; otherwise set it to the same path as `<bundle>`.
- `<diagnostics_json>`: Path to the diagnostics output file.
- `<output_dir>`: Directory to write the debundled scripts.
- `--no-predict`: (Optional) Disable prediction mode.

For prediction mode, set the predictor endpoint (replace with the actual address if needed):
```bash
export PREDICT_SERVER=http://127.0.0.1:8000/
```

## Example: with prediction

`motivatingexample` is the motivating example in our paper.
```bash
export PREDICT_SERVER=http://127.0.0.1:8000/
node lib/main.js ./tests/motivatingexample \
  --basedir ./tests/motivatingexample \
  --debundle-dir ./tmp/unpack \
  --diagnostics-json ./tmp/diag-unpack.json
```

This takes ~2–3 minutes and ends with output similar to:

```json
{
  "success": true,
  "error": "",
  "mainFiles": 1,
  "chunks": 0,
  "errors": 0,
  "succ_runs": 5,
  "wrappers": [
    "react",
    "scheduler",
    "react-dom"
  ],
  "functions": [
    "query-string::extract",
    "query-string::parse",
    "react-router-dom::useNavigate",
    "react-router-dom::useLocation"
  ],
  "requireFunctionPredictedBy": "PatternMatching",
  "failedFiles": []
}
```

Debundled scripts are in `./tmp/unpack`; the corresponding source files are in `./tmp/unpack-raw`.

**Test what CodeQL sees in the bundle:**
```bash
$CODE_QL_HOME/../codeqlscan.sh ./tmp/unpack-raw ./tmp/bundle.csv
```

You should first see logs like:
```text
...
[2025-03-16 21:41:43] [build-stdout] [Agent] Agent loaded!
[2025-03-16 21:41:43] [build-stdout] Found target class: com/semmle/js/extractor/AutoBuild
[2025-03-16 21:41:43] [build-stdout] [Agent] Modifying method: setupFilters
[2025-03-16 21:41:43] [build-stdout] [Agent] Modifying method: setupIncludesAndExcludes
[2025-03-16 21:41:43] [build-stdout] [ModifiedCodeQL] Modified method: com.semmle.js.extractor.AutoBuild
[2025-03-16 21:41:43] [build-stdout] [Agent] Modified method: com.semmle.js.extractor.AutoBuild
...
```

This indicates the hook is working.

The first run compiles the CodeQL queries (~5 minutes). After that, `bundle.csv` should be empty, i.e., there are **no alerts** on the bundled code.

Running CodeQL on the debundled code yields 2 alerts:
```bash
$CODE_QL_HOME/../codeqlscan.sh ./tmp/unpack ./tmp/unpack.csv
```

```text
"Client-side URL redirect","Client-side URL redirection based on unvalidated user input may cause redirection to malicious web sites.","error","Untrusted URL redirection depends on a [[""user-provided value""|""relative:///main.a8436a49/main.jsx:1226:47:1226:54""]].","/main.a8436a49/main.jsx","1227","36","1227","36"
"Client-side cross-site scripting","Writing user input directly to the DOM allows for a cross-site scripting vulnerability.","error","Cross-site scripting vulnerability due to [[""user-provided value""|""relative:///main.a8436a49/main.jsx:1226:47:1226:54""]].","/main.a8436a49/main.jsx","1227","36","1227","36"
```

## Example: without prediction

(The case study `www1.pluska.sk` is used in the experimental section.)
```bash
node ./lib/main.js ./tests/www1.pluska.sk --no-predict \
  --basedir tests/www1.pluska.sk \
  --debundle-dir ./tmp/unpack2 \
  --diagnostics-json ./tmp/diag-unpack2.json
```

Debundled files are in `./tmp/unpack2`; the corresponding bundled files are in `./tmp/unpack2-raw`.

Run CodeQL for both to compare:
```bash
$CODE_QL_HOME/../codeqlscan.sh ./tmp/unpack2-raw ./tmp/bundle2.csv
$CODE_QL_HOME/../codeqlscan.sh ./tmp/unpack2 ./tmp/unpack2.csv
```

# Evaluation

Install the benchmark tools:

```bash
cd evaluation
pip3 install -r requirements.txt
```

> The commands below assume the current directory is `evaluation`.

## Dataset

Download and extract the dataset:

```bash
wget -O packages.part1.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part1.tgz?download=true"
wget -O packages.part2.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part2.tgz?download=true"
wget -O packages.part3.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part3.tgz?download=true"
wget -O packages.part4.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part4.tgz?download=true"
wget -O packages.part5.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part5.tgz?download=true"
wget -O packages.part6.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part6.tgz?download=true"
wget -O packages.part7.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part7.tgz?download=true"
wget -O packages.part8.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part8.tgz?download=true"
wget -O packages.part9.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part9.tgz?download=true"
wget -O packages.part10.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part10.tgz?download=true"
wget -O packages.part11.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part11.tgz?download=true"
wget -O packages.part12.tgz "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part12.tgz?download=true"

tar -xf packages.part1.tgz  -C dataset
tar -xf packages.part2.tgz  -C dataset
tar -xf packages.part3.tgz  -C dataset
tar -xf packages.part4.tgz  -C dataset
tar -xf packages.part5.tgz  -C dataset
tar -xf packages.part6.tgz  -C dataset
tar -xf packages.part7.tgz  -C dataset
tar -xf packages.part8.tgz  -C dataset
tar -xf packages.part9.tgz  -C dataset
tar -xf packages.part10.tgz -C dataset
tar -xf packages.part11.tgz -C dataset
tar -xf packages.part12.tgz -C dataset

# Move extracted projects into the dataset root
mv dataset/home/*/work/debundle/tmp/*/* dataset
```

## Reproduce Table 3

Create `evaluation/settings-local.py` and adjust process count (≈ physical RAM in GB / 30):

```python
PROCESSES = 4  # Number of processes to run in parallel
```

Run the evaluation in batch for dataset part X (1–12):

```bash
./cli.py pipeline ./bundle_project/table3/dataset.partX.json \
  --script ./bundle_project/table3/pipeline.json \
  --task-label "table3"
```

If your prediction server is not `http://127.0.0.1:8000/`, update line 9 in `D-Bundlr/d-bundlr/src/unbundle/predictpackage.ts` and rebuild `d-bundlr` before launching the pipeline.

After completing all parts, generate the table:

```bash
python3 -m bundle_project.table3.maketable ./results/table3
```

The table will be written to `./tmp/output.xlsx`.
