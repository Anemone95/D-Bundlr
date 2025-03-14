import argparse
import logging
import os
import pickle

import numpy as np
from tqdm import tqdm
import torch
from torch.utils.data import RandomSampler, DataLoader
from transformers import (AdamW, get_linear_schedule_with_warmup,
                          RobertaConfig, RobertaForSequenceClassification, RobertaTokenizer)

import settings
from model import Model
from utils import BundleDataset, set_seed

logger = logging.getLogger(__name__)


def train(train_dataset, model):
    """ Train the model """

    # build dataloader
    train_sampler = RandomSampler(train_dataset)
    train_dataloader = DataLoader(train_dataset, sampler=train_sampler, batch_size=settings.train_batch_size,
                                  num_workers=4)

    max_steps = settings.epochs * len(train_dataloader)
    save_steps = max(1, len(train_dataloader) // 2)
    warmup_steps = max_steps // 5
    model.to(settings.device)

    # Prepare optimizer and schedule (linear warmup and decay)
    no_decay = ['bias', 'LayerNorm.weight']
    optimizer_grouped_parameters = [
        {'params': [p for n, p in model.named_parameters() if not any(nd in n for nd in no_decay)],
         'weight_decay': settings.weight_decay},
        {'params': [p for n, p in model.named_parameters() if any(nd in n for nd in no_decay)], 'weight_decay': 0.0}
    ]
    optimizer = AdamW(optimizer_grouped_parameters, lr=settings.learning_rate, eps=settings.adam_epsilon)
    scheduler = get_linear_schedule_with_warmup(optimizer, num_warmup_steps=warmup_steps,
                                                num_training_steps=max_steps)

    # multi-gpu training
    if settings.n_gpu > 1:
        model = torch.nn.DataParallel(model)

    # Train!
    logger.info("***** Running training *****")
    logger.info("  Num examples = %d", len(train_dataset))
    logger.info("  Num Epochs = %d", settings.epochs)
    logger.info("  Instantaneous batch size per GPU = %d", settings.train_batch_size // max(settings.n_gpu, 1))
    logger.info("  Total train batch size = %d", settings.train_batch_size * settings.gradient_accumulation_steps)
    logger.info("  Gradient Accumulation steps = %d", settings.gradient_accumulation_steps)
    logger.info("  Total optimization steps = %d", settings.max_steps)

    global_step = 0
    tr_loss, logging_loss, avg_loss, tr_nb, tr_num, train_loss = 0.0, 0.0, 0.0, 0, 0, 0
    best_f1 = 0

    model.zero_grad()

    early_stop = False
    for idx in range(settings.epochs):
        print("idx",idx)
        if early_stop:
            print("early_stop")
            break
        bar = tqdm(train_dataloader, total=len(train_dataloader))
        tr_num = 0
        train_loss = 0
        for step, batch in enumerate(bar):
            (inputs_ids, position_idx, attn_mask, labels) = [x.to(settings.device) for x in batch]
            model.train()
            loss, logits = model(inputs_ids, position_idx, attn_mask, labels)

            if settings.n_gpu > 1:
                loss = loss.mean()

            if settings.gradient_accumulation_steps > 1:
                loss = loss / settings.gradient_accumulation_steps

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), settings.max_grad_norm)

            tr_loss += loss.item()
            tr_num += 1
            train_loss += loss.item()
            if avg_loss == 0:
                avg_loss = tr_loss

            avg_loss = round(train_loss / tr_num, 5)
            bar.set_description("epoch {} loss {}".format(idx, avg_loss))
            best_loss = 999999
            if (step + 1) % settings.gradient_accumulation_steps == 0:
                optimizer.step()
                optimizer.zero_grad()
                scheduler.step()
                global_step += 1
                output_flag = True
                avg_loss = round(np.exp((tr_loss - logging_loss) / (global_step - tr_nb)), 4)

                if global_step % save_steps == 0:
                    if loss < best_loss:
                        best_loss = loss
                        checkpoint_prefix = 'checkpoint-best-f1'
                        output_dir = os.path.join(settings.output_dir, '{}'.format(checkpoint_prefix))
                        if not os.path.exists(output_dir):
                            os.makedirs(output_dir)
                        model_to_save = model.module if hasattr(model, 'module') else model
                        output_dir = os.path.join(output_dir, '{}'.format('model.bin'))
                        torch.save(model_to_save.state_dict(), output_dir)
                        logger.info("Saving model checkpoint to %s", output_dir)
                        with open(os.path.join(settings.output_dir, 'labelMap.pkl'), 'wb') as f:
                            pickle.dump(train_dataset.function2number, f)
                    if loss < 0.01:
                        best_loss = loss
                        checkpoint_prefix = 'checkpoint-best-f1'
                        output_dir = os.path.join(settings.output_dir, '{}'.format(checkpoint_prefix))
                        if not os.path.exists(output_dir):
                            os.makedirs(output_dir)
                        model_to_save = model.module if hasattr(model, 'module') else model
                        output_dir = os.path.join(output_dir, '{}'.format('model.bin'))
                        torch.save(model_to_save.state_dict(), output_dir)
                        logger.info("Saving model checkpoint to %s", output_dir)
                        with open(os.path.join(settings.output_dir, 'labelMap.pkl'), 'wb') as f:
                            pickle.dump(train_dataset.function2number, f)
                        print("early stop")
                        early_stop = True
                        break


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    ## Required parameters
    parser.add_argument("--dataset", default=None, type=str,
                        help="The input training data file (a text file).")
    # Setup logging
    logging.basicConfig(format='%(asctime)s - %(levelname)s - %(name)s -   %(message)s', datefmt='%m/%d/%Y %H:%M:%S',
                        level=logging.INFO)
    logger.warning("device: %s, n_gpu: %s", settings.device, settings.n_gpu, )

    args = parser.parse_args()
    # Set seed
    set_seed()
    tokenizer = RobertaTokenizer.from_pretrained(settings.model_name)
    train_dataset = BundleDataset(tokenizer, args.dataset)
    config = RobertaConfig.from_pretrained(settings.model_name, num_labels=len(train_dataset.function2number))
    config.num_labels = len(train_dataset.function2number)
    model = RobertaForSequenceClassification.from_pretrained(settings.model_name, config=config)
    model = Model(model, config, tokenizer)
    train(train_dataset, model)
