# Sequence lengths
import os
import torch


SCRIPT_DIR = os.path.split(os.path.realpath(__file__))[0]
model_name="microsoft/graphcodebert-base"

code_length = 256  # Code input sequence length after tokenization
data_flow_length = 64  # Data Flow input sequence length after tokenization
token_length = 512

# Training configurations
train_batch_size = 10  # Batch size per GPU/CPU for training
eval_batch_size = 1  # Batch size per GPU/CPU for evaluation
gradient_accumulation_steps = 1  # Updates steps to accumulate before backward/update pass
learning_rate = 1e-4  # Initial learning rate for Adam optimizer
weight_decay = 0.0  # Weight decay if applied
adam_epsilon = 1e-8  # Epsilon for Adam optimizer
max_grad_norm = 1.0  # Maximum gradient norm
max_steps = -1  # Maximum training steps (-1 means disabled)
warmup_steps = 0  # Linear warmup over this number of steps
epochs = 100

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
n_gpu = torch.cuda.device_count()

# Random seed for reproducibility
seed = 42

output_dir = f"{SCRIPT_DIR}/saved_models"
