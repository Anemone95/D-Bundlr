# Structure

`./codepredict`: For machine learning prediction

`./d-bundlr`: D-Bundle tools

`./evaluations`: Batch script to reproduce experiment results

`./codeql` CodeQL related setup

# Setup

## Setup Code Predict Server


Install conda <https://docs.conda.io/projects/conda/en/latest/user-guide/getting-started.html>

Then install other dependencies:

```bash
cd codepredict
conda env create -f ./environment-gpu.yml && conda clean -a -y //if you are using GPU
conda env create -f ./environment-cpu.yml && conda clean -a -y //otherwise
conda activate ml
wget -O saved_models.zip "https://zenodo.org/records/15034484/files/saved_models.zip?download=1" # download our trained models
unzip saved_models.zip 
python3 ./predictServer.py &> log.txt &
```

Test:

```bash
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" -d "{\"code\":\" function makeNamespaceObject(exports: any){ if(typeof Symbol !== 'undefined' && Symbol.toStringTag) { Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' }); } Object.defineProperty(exports, '__esModule', { value: true }); }  \"}"
```

If the result is:

```bash
[{"confidence":0.7002745270729065,"function":{"functionFile":"webpack/runtime/make namespace object","functionName":"__make_namespace_object__","packageName":"webpack-demo"}},{"confidence":0.5005811452865601,"function":{"functionFile":"lib/isTaxID.js","functionName":"_interopRequireWildcard","packageName":"validator"}},{"confidence":0.500332236289978,"function":{"functionFile":"browser/nunjucks.js","functionName":"gensym","packageName":"nunjucks"}}]
```

The predictor is installed successfully!

### Training a module by yourself

Download the full dataset in  <https://zenodo.org/records/15034484/files/full-dataset.tgz?download=1>


```bash
cd codepredict
mkdir dataset/full-dataset
wget -O full-dataset.tgz "https://zenodo.org/records/15034484/files/saved_models.zip?download=1" # download our dataset
tar -xf full-dataset.tgz -C dataset/full-dataset
python3 ./train.py --data ./dataset/full-dataset
```

## Setup CodeQL

```bash
cd codeql
export CODE_QL_HOME=$(pwd)/codeql-home
export CODEQL_VERSION="2.20.5" 

# choose the appropriate codeql binary according to your system
curl -L -o codeql.zip https://github.com/github/codeql-cli-binaries/releases/download/v${CODEQL_VERSION}/codeql-linux64.zip && \
    unzip codeql.zip -d $CODE_QL_HOME && \
    rm codeql.zip 
curl -L -o codeql-repo.zip https://github.com/github/codeql/archive/refs/tags/codeql-cli/v${CODEQL_VERSION}.zip && \
    unzip codeql-repo.zip -d $CODE_QL_HOME && \
    mv $CODE_QL_HOME/codeql-codeql-cli-v${CODEQL_VERSION} $CODE_QL_HOME/codeql-repo && \
    rm codeql-repo.zip
cp ./codeqlagent.jar $CODE_QL_HOME/codeqlagent.jar
sed -i 's|com.semmle.js.extractor.AutoBuild|-javaagent:$CODE_QL_HOME/codeqlagent.jar com.semmle.js.extractor.AutoBuild|' $CODE_QL_HOME/codeql/javascript/tools/autobuild.sh
```

The last two lines will hook the CodeQL file lookup function to include every JavaScript file.

## Setup d-bundlr

Follow the instructions at <https://github.com/nodesource/distributions/blob/master/DEV_README.md> to install NodeJS at first.

Then run the following command

```bash
cd d-bundlr
npm install .
npm run build
npm link 
```

# Usage
The following command suppose your current directory is `d-bundlr`.

```bash
node ./lib/main.js <bundle> [--no-predict] --basedir <base_dir> --debundle-dir <output_dir> --diagnostics-json <diagnostics_json>
```

Options:
* `<bundle>`: The bundle script or a directory contains bundle.
* `<base_dir>`: The root directory, if the `<bundle>` is a script set it to script's direcotry otherwise set it the same as `<bundle>`.
* `<diagnostics_json>`: The diagnostic output.
* `<output_dir>`: The debundled script directory.
* `--no-predict`: Optional, disable the prediction mode.

For prediction mode, set the predict server by (change `http://127.0.0.1:8000/` to the actual address):
```bash
export PREDICT_SERVER=http://127.0.0.1:8000/
```

## An Example with Prediction

For example (`motivatingexample` is the motivating example in our paper):
```bash
export PREDICT_SERVER=http://127.0.0.1:8000/
node lib/main.js ./tests/motivatingexample --basedir ./tests/motivatingexample --debundle-dir ./tmp/unpack --diagnostics-json ./tmp/diag-unpack.json
```

It takes 2-3 minutes and will output in the end:

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

The debundled scripts are in `./tmp/unpack`,  the relevant source codes are in `./tmp/unpack-raw`.

Test what CodeQL can get from bundle:

```bash
$CODE_QL_HOME/../codeql/codeqlscan.sh ./tmp/unpack-raw ./tmp/bundle.csv
```

First you will see:
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

It means hooking is working.

The first run needs compile CodeQL queries, which takes ~5 minutes. After that you will see `bundle.csv` has **nothing**, means no alerts we can get from the bundle.


You will see 2 alerts when scan debundled code:
```bash
> $CODE_QL_HOME/../codeql/codeqlscan.sh ./tmp/unpack ./tmp/unpack.csv

"Client-side URL redirect","Client-side URL redirection based on unvalidated user input may cause redirection to malicious web sites.","error","Untrusted URL redirection depends on a [[""user-provided value""|""relative:///main.a8436a49/main.jsx:1226:47:1226:54""]].","/main.a8436a49/main.jsx","1227","36","1227","36"
"Client-side cross-site scripting","Writing user input directly to the DOM allows for a cross-site scripting vulnerability.","error","Cross-site scripting vulnerability due to [[""user-provided value""|""relative:///main.a8436a49/main.jsx:1226:47:1226:54""]].","/main.a8436a49/main.jsx","1227","36","1227","36"
```


## An Example without Prediction

For example(`www1.pluska.sk` is the case study we used in experiment section):

```bash
node ./lib/main.js ./tests/www1.pluska.sk --no-predict --basedir tests/www1.pluska.sk --debundle-dir ./tmp/unpack2 --diagnostics-json ./tmp/diag-unpack2.json
```

The debundled files are in `./tmp/unpack2`; the corresponding bundled files are in `./tmp/unpack2-raw`.

Run codeql for both to see the difference:

```
$CODE_QL_HOME/../codeqlscan.sh ./tmp/unpack2-raw ./tmp/bundle2.csv
```

```
$CODE_QL_HOME/../codeqlscan.sh ./tmp/unpack2 ./tmp/unpack2.csv
```



# Evaluation

Install the benchmark:

```bash
cd evaluation
pip3 install -r requirements.txt
```

The following instruction suppose your current directory is `evaluation`.

## Dataset

Download and extract the dataset:

```bash
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part1.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part2.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part3.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part4.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part5.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part6.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part7.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part8.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part9.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part10.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part11.tgz?download=true"
wget "https://huggingface.co/datasets/wyxu95/icse26-debundle-web-dataset/resolve/main/packages.part12.tgz?download=true"
tar -xf packages.part1.tgz -C dataset
tar -xf packages.part2.tgz -C dataset
tar -xf packages.part3.tgz -C dataset
tar -xf packages.part4.tgz -C dataset
tar -xf packages.part5.tgz -C dataset
tar -xf packages.part6.tgz -C dataset
tar -xf packages.part7.tgz -C dataset
tar -xf packages.part8.tgz -C dataset
tar -xf packages.part9.tgz -C dataset
tar -xf packages.part10.tgz -C dataset
tar -xf packages.part11.tgz -C dataset
tar -xf packages.part12.tgz -C dataset
mv dataset/home/*/work/debundle/tmp/*/* dataset
```


## Reproduce Table 3

Create a setting file named `evaluation/settings-local.py` with the following content. Adjust the number of processes (~Physical memory(GB)/30GB) your machine:
```python
PROCESSES = 4 # Number of processes to run in parallel
```

Run evaluate script in batch for dataset part X (1~12).

```bash
./cli.py pipeline ./bundle_project/table3/dataset.partX.json --script ./bundle_project/table3/pipeline.json --task-label="table3"
```

If your predict server is not `http://127.0.0.1:8000/`, change it at line 9 in "D-Bundlr/d-bundlr/src/unbundle/predictpackage.ts" and recompile `d-bundlr` before running pipeline.

When you've done all parts, generate the table from the result:

```bash
python3 -m bundle_project.table3.maketable ./results/table3
```

See `./tmp/output.xlsx` for the table.
