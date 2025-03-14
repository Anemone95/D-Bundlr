import base64
import os
import pickle
import traceback
import uuid
import warnings

import torch
from flask import Flask, request, jsonify
from transformers import RobertaConfig, RobertaTokenizer, RobertaForSequenceClassification

import settings
from model import Model
from predict import predict_candidates
from utils import set_seed

app = Flask(__name__)

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


@app.route('/predict', methods=['POST'])
def predict():
    data = request.get_json()
    if not data or 'code' not in data:
        return jsonify({"error": "Missing 'code' in request body"}), 400

    function_code = data['code']
    topn = data.get('topn', 3)
    result = []
    try:
        funcs, confidents = predict_candidates(model, tokenizer, function_code, label_id_to_label, n=topn)
        for i, func in enumerate(funcs):
            result.append({"function": func, "confidence": float(confidents[i])})
    except Exception as e:
        with open(f"error-{uuid.uuid1()}.log", "w") as log_file:
            log_file.write(f"Exception occurred while processing data flow: {str(e)}\n\n")
            log_file.write(traceback.format_exc()+"\n\n")
            log_file.write(f"Code that caused the exception:\n{base64.encode(function_code)}\n\n")
    finally:
        return jsonify(result)


if __name__ == "__main__":
    # run with gunicorn -w 4 -b 0.0.0.0:8000 predictServer:app
    app.run(host='0.0.0.0', port=8000, debug=False)
