from __future__ import absolute_import, division, print_function

import argparse
import logging
import platform
import os
from pathlib import Path
import random
import json
import numpy as np
import torch
from torch.utils.data import DataLoader, Dataset, SequentialSampler, RandomSampler, TensorDataset
from transformers import (WEIGHTS_NAME, AdamW, get_linear_schedule_with_warmup,
                          RobertaConfig, RobertaForSequenceClassification, RobertaTokenizer)
from tqdm import tqdm, trange

import settings
from model import Model

logger = logging.getLogger(__name__)

from parser import DFG_javascript
from parser import (remove_comments_and_docstrings,
                    tree_to_token_index,
                    index_to_code_token)

from tree_sitter import Parser, Language

dfg_function = {
    'javascript': DFG_javascript
}

parsers = {}
system = platform.system().lower()
arch = platform.machine().lower()
if system == "darwin" and "arm" in arch:  # macOS + ARM
    so = "lang-darwin-arm.so"
elif system == "linux" and ("x86_64" in arch or "amd64" in arch):  # Linux + x64
    so = "lang-linux-x64.so"
else:
    raise Exception("Unsupported platform")
for lang in dfg_function:
    # TODO: switch to different architecture
    LANGUAGE = Language(f"{settings.SCRIPT_DIR}/parser/{so}", lang)
    parser = Parser()
    parser.set_language(LANGUAGE)
    parser = [parser, dfg_function[lang]]
    parsers[lang] = parser

def safe_encode(text):
    return text.encode('utf-8', errors='replace').decode('utf-8')

# remove comments, tokenize code and extract dataflow
def extract_dataflow(code, parser, lang):
    # remove comments
    try:
        code = remove_comments_and_docstrings(code, lang)
    except:
        pass
    # obtain dataflow
    if lang == "php":
        code = "<?php" + code + "?>"
    tree = parser[0].parse(code.encode('utf-8', errors='replace'))
    root_node = tree.root_node
    tokens_index = tree_to_token_index(root_node)
    code = code.split('\n')
    code_tokens = [index_to_code_token(x, code) for x in tokens_index]
    index_to_code = {}
    for idx, (index, code) in enumerate(zip(tokens_index, code_tokens)):
        index_to_code[index] = (idx, code)
    DFG, _ = parser[1](root_node, index_to_code, {})
    DFG = sorted(DFG, key=lambda x: x[1])
    indexs = set()
    for d in DFG:
        if len(d[-1]) != 0:
            indexs.add(d[1])
        for x in d[-1]:
            indexs.add(x)
    new_DFG = []
    for d in DFG:
        if d[1] in indexs:
            new_DFG.append(d)
    dfg = new_DFG
    return code_tokens, dfg


class InputFeatures(object):
    """A single training/test features for a example."""

    def __init__(self,
                 input_tokens,
                 input_ids,
                 position_idx,
                 dfg_to_code,
                 dfg_to_dfg,
                 label,
                 ):
        # The first code function
        self.input_tokens = input_tokens
        self.input_ids = input_ids
        self.position_idx = position_idx
        self.dfg_to_code = dfg_to_code
        self.dfg_to_dfg = dfg_to_dfg

        # label
        self.label = label


def encode_label(label):
    return f'{label["packageName"]}!!{label["functionFile"]}!!{label["functionName"]}'


def decode_label(label):
    parts = label.split("!!")
    return {"packageName": parts[0], "functionFile": parts[1], "functionName": parts[2]}


def convert_examples_to_features(record, tokenizer, function2number):
    func = record['code']
    label = record['label']
    if label is None:
        label_vector = []
    else:
        num_labels = len(function2number)
        label_vector = [0] * num_labels
        label_vector[function2number[encode_label(label)]] = 1
    code_tokens, dfg = extract_dataflow(func, parser, 'javascript')
    code_tokens = [tokenizer.tokenize('@ ' + x)[1:] if idx != 0 else tokenizer.tokenize(x) for idx, x in
                   enumerate(code_tokens)]
    ori2cur_pos = {}
    ori2cur_pos[-1] = (0, 0)
    for i in range(len(code_tokens)):
        ori2cur_pos[i] = (ori2cur_pos[i - 1][1], ori2cur_pos[i - 1][1] + len(code_tokens[i]))
    code_tokens = [y for x in code_tokens for y in x]

    # truncating
    code_tokens = code_tokens[
                  :settings.code_length + settings.data_flow_length - 3 - min(len(dfg), settings.data_flow_length)][
                  :512 - 3]
    source_tokens = [tokenizer.cls_token] + code_tokens + [tokenizer.sep_token]
    source_ids = tokenizer.convert_tokens_to_ids(source_tokens)
    position_idx = [i + tokenizer.pad_token_id + 1 for i in range(len(source_tokens))]
    dfg = dfg[:settings.code_length + settings.data_flow_length - len(source_tokens)]
    source_tokens += [x[0] for x in dfg]
    position_idx += [0 for x in dfg]
    source_ids += [tokenizer.unk_token_id for x in dfg]
    padding_length = settings.code_length + settings.data_flow_length - len(source_ids)
    position_idx += [tokenizer.pad_token_id] * padding_length
    source_ids += [tokenizer.pad_token_id] * padding_length

    # reindex
    reverse_index = {}
    for idx, x in enumerate(dfg):
        reverse_index[x[1]] = idx
    for idx, x in enumerate(dfg):
        dfg[idx] = x[:-1] + ([reverse_index[i] for i in x[-1] if i in reverse_index],)
    dfg_to_dfg = [x[-1] for x in dfg]
    dfg_to_code = [ori2cur_pos[x[1]] for x in dfg]
    length = len([tokenizer.cls_token])
    dfg_to_code = [(x[0] + length, x[1] + length) for x in dfg_to_code]

    return InputFeatures(source_tokens, source_ids, position_idx, dfg_to_code, dfg_to_dfg, label_vector)


class BundleDataset(Dataset):
    def __init__(self, tokenizer, file_path: str = 'train'):
        self.examples: list[InputFeatures] = []
        self.package2number = {}
        self.function2number = {}
        # load index
        logger.info("Creating features from index file at %s ", file_path)
        data = []
        known_code = set()

        def _process(file_path: Path):
            with file_path.open() as f:
                for line in f:
                    line = line.strip()
                    record = json.loads(line)
                    if record['code'] in known_code:
                        continue
                    known_code.add(record['code'])
                    data.append(record)
                    # if file_path.parts[-3] == record["label"]["packageName"]:
                    packageName = record["label"]["packageName"]
                    functionName = encode_label(record["label"])
                    if packageName not in self.package2number:
                        self.package2number[packageName] = len(self.package2number)
                    if functionName not in self.function2number:
                        self.function2number[functionName] = len(self.function2number)

        if os.path.isfile(file_path) and file_path.endswith('.jsonl'):
            _process(Path(file_path))
        elif os.path.isdir(file_path):
            files = Path(file_path).glob('**/*.jsonl')
            for file in files:
                _process(file)
        else:
            raise ValueError(
                f"Invalid file path: {file_path}. Must be a .jsonl file or a directory containing .jsonl files.")

        # convert example to input features
        print("Converting examples to features")
        idHash = set()
        for x in tqdm(data, total=len(data)):
            feature = convert_examples_to_features(x, tokenizer, self.function2number)
            h = hash(tuple(feature.input_ids))
            if h in idHash:
                continue
            idHash.add(h)
            self.examples.append(feature)
        if len(self.examples) != len(data):
            logger.warning("Duplicate code(after strip) detected, removed duplicates")

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, item):

        return (torch.tensor(self.examples[item].input_ids),
                torch.tensor(self.examples[item].position_idx),
                torch.tensor(BundleDataset.compute_attn_mask(self.examples[item])),
                torch.tensor(self.examples[item].label, dtype=torch.float))

    @staticmethod
    def compute_attn_mask(item):
        # calculate graph-guided masked function
        attn_mask = np.zeros((settings.code_length + settings.data_flow_length,
                              settings.code_length + settings.data_flow_length), dtype=bool)
        # calculate begin index of node and max length of input
        node_index = sum([i > 1 for i in item.position_idx])
        max_length = sum([i != 1 for i in item.position_idx])
        # sequence can attend to sequence
        attn_mask[:node_index, :node_index] = True
        # special tokens attend to all tokens
        for idx, i in enumerate(item.input_ids):
            if i in [0, 2]:
                attn_mask[idx, :max_length] = True
        # nodes attend to code tokens that are identified from
        for idx, (a, b) in enumerate(item.dfg_to_code):
            if a < node_index and b < node_index:
                attn_mask[idx + node_index, a:b] = True
                attn_mask[a:b, idx + node_index] = True
        # nodes attend to adjacent nodes
        for idx, nodes in enumerate(item.dfg_to_dfg):
            for a in nodes:
                if a + node_index < len(item.position_idx):
                    attn_mask[idx + node_index, a + node_index] = True
        return attn_mask


def set_seed():
    random.seed(settings.seed)
    np.random.seed(settings.seed)
    torch.manual_seed(settings.seed)
    if settings.n_gpu > 0:
        torch.cuda.manual_seed_all(settings.seed)


def evaluate(args, model, tokenizer, eval_when_training=False):
    from sklearn.metrics import f1_score, precision_score, recall_score
    eval_dataset = BundleDataset(tokenizer, file_path=args.eval_data_file)
    eval_sampler = SequentialSampler(eval_dataset)
    eval_dataloader = DataLoader(eval_dataset, sampler=eval_sampler, batch_size=settings.eval_batch_size, num_workers=4)

    if settings.n_gpu > 1 and eval_when_training is False:
        model = torch.nn.DataParallel(model)

    logger.info("***** Running evaluation *****")
    logger.info("  Num examples = %d", len(eval_dataset))
    logger.info("  Batch size = %d", settings.eval_batch_size)

    eval_loss = 0.0
    nb_eval_steps = 0
    model.eval()
    all_logits = []
    all_labels = []
    for batch in eval_dataloader:
        inputs_ids, position_idx, attn_mask, labels = [x.to(settings.device) for x in batch]
        with torch.no_grad():
            lm_loss, logits = model(inputs_ids, position_idx, attn_mask, labels)
            eval_loss += lm_loss.mean().item()
            all_logits.append(torch.sigmoid(logits).cpu().numpy())
            all_labels.append(labels.cpu().numpy())
        nb_eval_steps += 1

    all_logits = np.concatenate(all_logits, axis=0)
    all_labels = np.concatenate(all_labels, axis=0)

    threshold = 0.5
    all_preds = (all_logits > threshold).astype(int)

    f1 = f1_score(all_labels, all_preds, average='macro')
    precision = precision_score(all_labels, all_preds, average='macro')
    recall = recall_score(all_labels, all_preds, average='macro')

    results = {
        "eval_f1": f1,
        "eval_precision": precision,
        "eval_recall": recall,
        "eval_loss": eval_loss / nb_eval_steps,
    }

    for key, value in results.items():
        logger.info(f"{key}: {value:.4f}")

    return results


def test(args, model, tokenizer, best_threshold=0):
    # build dataloader
    eval_dataset = BundleDataset(tokenizer, file_path=args.test_data_file)
    eval_sampler = SequentialSampler(eval_dataset)
    eval_dataloader = DataLoader(eval_dataset, sampler=eval_sampler, batch_size=settings.eval_batch_size, num_workers=4)

    # multi-gpu evaluate
    if settings.n_gpu > 1:
        model = torch.nn.DataParallel(model)

    # Eval!
    logger.info("***** Running Test *****")
    logger.info("  Num examples = %d", len(eval_dataset))
    logger.info("  Batch size = %d", settings.eval_batch_size)
    eval_loss = 0.0
    nb_eval_steps = 0
    model.eval()
    logits = []
    y_trues = []
    for batch in eval_dataloader:
        (inputs_ids, position_idx, attn_mask, labels) = [x.to(settings.device) for x in batch]
        with torch.no_grad():
            lm_loss, logit = model(inputs_ids, position_idx, attn_mask, labels)
            eval_loss += lm_loss.mean().item()
            logits.append(logit.cpu().numpy())
            y_trues.append(labels.cpu().numpy())
        nb_eval_steps += 1

    # output result
    logits = np.concatenate(logits, 0)
    y_preds = logits[:, 1] > best_threshold
    with open(os.path.join(settings.output_dir, "predictions.txt"), 'w') as f:
        for example, pred in zip(eval_dataset.examples, y_preds):
            if pred:
                f.write(example.url1 + '\t' + example.url2 + '\t' + '1' + '\n')
            else:
                f.write(example.url1 + '\t' + example.url2 + '\t' + '0' + '\n')


def main():
    parser = argparse.ArgumentParser()

    ## Required parameters
    parser.add_argument("--train_data_file", default=None, type=str,
                        help="The input training data file (a text file).")
    parser.add_argument("--output_dir", default=None, type=str, required=True,
                        help="The output directory where the model predictions and checkpoints will be written.")

    ## Other parameters
    parser.add_argument("--eval_data_file", default=None, type=str,
                        help="An optional input evaluation data file to evaluate the perplexity on (a text file).")
    parser.add_argument("--test_data_file", default=None, type=str,
                        help="An optional input evaluation data file to evaluate the perplexity on (a text file).")

    parser.add_argument("--model_name_or_path", default="microsoft/graphcodebert-base", type=str,
                        help="The model checkpoint for weights initialization.")

    parser.add_argument("--config_name", default="microsoft/graphcodebert-base", type=str,
                        help="Optional pretrained config name or path if not the same as model_name_or_path")
    parser.add_argument("--tokenizer_name", default="microsoft/graphcodebert-base", type=str,
                        help="Optional pretrained tokenizer name or path if not the same as model_name_or_path")
    parser.add_argument("--do_train", action='store_true',
                        help="Whether to run training.")
    parser.add_argument("--do_eval", action='store_true',
                        help="Whether to run eval on the dev set.")
    parser.add_argument("--do_test", action='store_true',
                        help="Whether to run eval on the dev set.")

    parser.add_argument("--do_predict", action='store_true', help="predict the code.")
    parser.add_argument("--evaluate_during_training", action='store_true',
                        help="Run evaluation during training at each logging step.")

    parser.add_argument("--code_length", default=256, type=int,
                        help="Optional Code input sequence length after tokenization.")
    parser.add_argument("--data_flow_length", default=64, type=int,
                        help="Optional Data Flow input sequence length after tokenization.")
    parser.add_argument("--train_batch_size", default=4, type=int,
                        help="Batch size per GPU/CPU for training.")
    parser.add_argument("--eval_batch_size", default=4, type=int,
                        help="Batch size per GPU/CPU for evaluation.")
    parser.add_argument('--gradient_accumulation_steps', type=int, default=1,
                        help="Number of updates steps to accumulate before performing a backward/update pass.")
    parser.add_argument("--learning_rate", default=5e-5, type=float,
                        help="The initial learning rate for Adam.")
    parser.add_argument("--weight_decay", default=0.0, type=float,
                        help="Weight deay if we apply some.")
    parser.add_argument("--adam_epsilon", default=1e-8, type=float,
                        help="Epsilon for Adam optimizer.")
    parser.add_argument("--max_grad_norm", default=1.0, type=float,
                        help="Max gradient norm.")
    parser.add_argument("--max_steps", default=-1, type=int,
                        help="If > 0: set total number of training steps to perform. Override num_train_epochs.")
    parser.add_argument("--warmup_steps", default=0, type=int,
                        help="Linear warmup over warmup_steps.")

    parser.add_argument('--seed', type=int, default=42,
                        help="random seed for initialization")
    parser.add_argument('--epochs', type=int, default=3,
                        help="training epochs")

    args = parser.parse_args()

    # Setup logging
    logging.basicConfig(format='%(asctime)s - %(levelname)s - %(name)s -   %(message)s', datefmt='%m/%d/%Y %H:%M:%S',
                        level=logging.INFO)
    logger.warning("device: %s, n_gpu: %s", settings.device, settings.n_gpu, )

    # Set seed
    set_seed()
    config = RobertaConfig.from_pretrained(settings.model_name)
    tokenizer = RobertaTokenizer.from_pretrained(settings.model_name)
    model = RobertaForSequenceClassification.from_pretrained(settings.model_name, config=config)

    # Evaluation
    results = {}
    if args.do_eval:
        checkpoint_prefix = 'checkpoint-best-f1/model.bin'
        output_dir = os.path.join(settings.output_dir, '{}'.format(checkpoint_prefix))
        model = Model(model, config, tokenizer, args)
        model.load_state_dict(torch.load(output_dir))
        model.to(settings.device)
        result = evaluate(args, model, tokenizer)

    if args.do_test:
        checkpoint_prefix = 'checkpoint-best-f1/model.bin'
        output_dir = os.path.join(settings.output_dir, '{}'.format(checkpoint_prefix))
        model = Model(model, config, tokenizer, args)
        model.load_state_dict(torch.load(output_dir))
        model.to(settings.device)
        test(args, model, tokenizer, best_threshold=0.5)

    return results


if __name__ == "__main__":
    main()
