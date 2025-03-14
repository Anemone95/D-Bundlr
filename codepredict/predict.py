# Load label map
import base64
import json
import os
import pickle
import traceback

import numpy as np
import torch

from model import Model
import settings
from utils import BundleDataset, convert_examples_to_features, set_seed, decode_label
from transformers import RobertaConfig, RobertaTokenizer, RobertaForSequenceClassification
import warnings


def predict_candidates(model, tokenizer, function_code, label_id_to_label, n=5):
    """
    Predict the label for a given JavaScript function code.
    """
    # Tokenize and process the input code
    inputs = {
        "code": function_code,
        "label": None
    }
    feature = convert_examples_to_features(inputs, tokenizer, {})
    # Prepare model input tensors
    input_ids = torch.tensor(feature.input_ids, dtype=torch.long).unsqueeze(0).to(settings.device)
    position_idx = torch.tensor(feature.position_idx, dtype=torch.long).unsqueeze(0).to(settings.device)
    attn_mask = torch.tensor(BundleDataset.compute_attn_mask(feature)).unsqueeze(0).to(settings.device)
    # Predict
    model.eval()
    with torch.no_grad():
        logits = model(input_ids, position_idx, attn_mask)
        probabilities = torch.sigmoid(logits).cpu().numpy()[0]
        predicted_label_ids = np.argsort(probabilities)[-n:][::-1]
        predicted_labels = list(map(lambda e: decode_label(label_id_to_label[e]), predicted_label_ids))

    return predicted_labels, probabilities[predicted_label_ids]


if __name__ == '__main__':
    label_map_path = os.path.join(settings.output_dir, 'labelMap.pkl')
    if not os.path.exists(label_map_path):
        raise FileNotFoundError(f"Label map file not found at {label_map_path}")
    with open(label_map_path, 'rb') as f:
        label_id_to_label = {v: k for k, v in pickle.load(f).items()}
    warnings.filterwarnings("ignore", category=FutureWarning)
    set_seed()

    checkpoint_prefix = 'checkpoint-best-f1/model.bin'
    output_dir = os.path.join(settings.output_dir, '{}'.format(checkpoint_prefix))

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    config = RobertaConfig.from_pretrained(settings.model_name)
    config.num_labels = len(label_id_to_label)
    tokenizer = RobertaTokenizer.from_pretrained(settings.model_name)
    
    model = Model(encoder=None, config=config, tokenizer=tokenizer)
    
    checkpoint_path = os.path.join(settings.output_dir, 'checkpoint-best-f1/model.bin')
    model.load_state_dict(torch.load(checkpoint_path, map_location=device))
    model.to(settings.device)
    function_code = """
    function makeNamespaceObject(exports: any){ if(typeof Symbol !== 'undefined' && Symbol.toStringTag) { Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' }); } Object.defineProperty(exports, '__esModule', { value: true }); }
    """
    predicted_label = predict_candidates(model, tokenizer, function_code, label_id_to_label, n=3)
    print(f"Predicted Label: {predicted_label}")
