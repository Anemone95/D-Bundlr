from transformers import AutoTokenizer, AutoModel
import torch
import faiss
import numpy as np
from transformers.modeling_outputs import (
    BaseModelOutput,
    BaseModelOutputWithPooling,
    BaseModelOutputWithPoolingAndCrossAttentions,
    CausalLMOutputWithPast,
)

# Define a function to initialize model and tokenizer
def load_model_and_tokenizer(model_id):
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModel.from_pretrained(model_id)
    return model, tokenizer

# Compute embeddings for code snippets or natural language
def compute_embedding(model, tokenizer, input_text):
    # Tokenize the input
    tokens = tokenizer.tokenize(input_text)
    tokens = [tokenizer.cls_token] + tokens + [tokenizer.sep_token]
    tokens_ids = tokenizer.convert_tokens_to_ids(tokens)

    # Convert to tensor and pass through the model
    input_ids = torch.tensor(tokens_ids).unsqueeze(0)  # Add batch dimension
    outputs = model(input_ids)

    # Handle different output types dynamically
    if isinstance(outputs, (BaseModelOutput, BaseModelOutputWithPooling)):
        # For CodeBERT or similar models: Use last_hidden_state
        context_embeddings = outputs.last_hidden_state  # Shape: [batch_size, seq_len, hidden_dim]
        sequence_embedding = context_embeddings.mean(dim=1).squeeze(0).detach().numpy()
    elif isinstance(outputs, BaseModelOutputWithPoolingAndCrossAttentions):
        # For models with pooling: Use pooled_output
        sequence_embedding = outputs.pooler_output.squeeze(0).detach().numpy()
    elif isinstance(outputs, CausalLMOutputWithPast):
        # For CodeGemma or similar models: Use logits
        logits = outputs.logits  # Shape: [batch_size, sequence_length, vocab_size]
        last_token_logits = logits[:, -1, :]  # Extract the last token's logits
        sequence_embedding = last_token_logits.squeeze(0).detach().numpy()
    else:
        raise ValueError(f"Unsupported model output type: {type(outputs)}")

    # Normalize for cosine similarity
    sequence_embedding /= np.linalg.norm(sequence_embedding)
    return sequence_embedding

# Initialize FAISS index for cosine similarity
def initialize_faiss_index(embedding_dim):
    return faiss.IndexFlatIP(embedding_dim)  # Use inner product for cosine similarity

# Add embeddings to FAISS index
def add_to_faiss(index, embeddings, code_snippets):
    for i, embedding in enumerate(embeddings):
        index.add(np.array([embedding], dtype="float32"))
        code_mapping[i] = code_snippets[i]

# Query the FAISS index
def query_faiss(index, code_mapping, query_embedding, top_k=1):
    distances, indices = index.search(np.array([query_embedding], dtype="float32"), top_k)
    results = [(code_mapping[idx], dist) for idx, dist in zip(indices[0], distances[0])]
    return results

# Select model_id to switch between CodeBERT and CodeGemma
model_id = "microsoft/graphcodebert-base"  # Use "google/codegemma-2b" for CodeGemma
model, tokenizer = load_model_and_tokenizer(model_id)

# Code snippets to store in FAISS
code_snippets = [
    "def max(a, b): return a if a > b else b",
    "def min(a, b): return a if a < b else b"
]

# Compute embeddings for all snippets
code_mapping = {}  # Map FAISS indices to code snippets
embeddings = [compute_embedding(model, tokenizer, snippet) for snippet in code_snippets]

# Initialize FAISS index and add embeddings
embedding_dim = embeddings[0].shape[0]  # Get the dimensionality of the embeddings
faiss_index = initialize_faiss_index(embedding_dim)
add_to_faiss(faiss_index, embeddings, code_snippets)

# Query the FAISS index with a new code snippet
query_code = "def func(first, second): return first if first < second else second"  # Query code snippet
query_embedding = compute_embedding(model, tokenizer, query_code)
results = query_faiss(faiss_index, code_mapping, query_embedding, top_k=1)

# Print query results
print(f"Query Code: {query_code}")
for similar_code, similarity in results:
    print(f"Similar Code: {similar_code}")
    print(f"Cosine Similarity: {similarity}")