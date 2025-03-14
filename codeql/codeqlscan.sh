#!/bin/bash

if [ "$#" -ne 2 ]; then
    echo "Usage: ./codeqlscan <targetdir> <output>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_DIR=$1
OUTPUT_FILE=$2

$CODE_QL_HOME/codeql/codeql database create --language=javascript codeql-database --source-root="$TARGET_DIR" --overwrite
$CODE_QL_HOME/codeql/codeql database analyze codeql-database $SCRIPT_DIR/querysuite.qls --format=csv --output="$OUTPUT_FILE" --threads=4

cat "$OUTPUT_FILE"

