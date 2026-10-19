"""Generate a tiny, offline BERT-shaped ONNX fixture, without a Python ONNX dependency.

The graph casts token IDs and adds a hidden-size dimension. Transformers still
loads a native ORT session and performs feature extraction; there are no trained
weights or downloads. Protobuf fields follow onnx/onnx.proto (IR 8, opset 13).
"""
import json
import pathlib
import struct
import sys

root = pathlib.Path(sys.argv[1])
(root / "onnx").mkdir(parents=True)


def varint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def number(field, value):
    return varint(field << 3) + varint(value)


def blob(field, value):
    if isinstance(value, str):
        value = value.encode()
    return varint((field << 3) | 2) + varint(len(value)) + value


def tensor_info(name, dtype, dims):
    shape = b"".join(blob(1, number(1, dim) if isinstance(dim, int) else blob(2, dim)) for dim in dims)
    return blob(1, name) + blob(2, blob(1, number(1, dtype) + blob(2, shape)))


cast_attribute = blob(1, "to") + number(3, 1) + number(20, 2)
cast = blob(1, "input_ids") + blob(2, "floats") + blob(4, "Cast") + blob(5, cast_attribute)
unsqueeze = blob(1, "floats") + blob(1, "axes") + blob(2, "last_hidden_state") + blob(4, "Unsqueeze")
axes = number(1, 1) + number(2, 7) + blob(8, "axes") + blob(9, struct.pack("<q", 2))
graph = (blob(1, cast) + blob(1, unsqueeze) + blob(2, "offline-embedding-probe") + blob(5, axes)
         + blob(11, tensor_info("input_ids", 7, ["batch", "sequence"]))
         + blob(12, tensor_info("last_hidden_state", 1, ["batch", "sequence", 1])))
(root / "onnx/model.onnx").write_bytes(number(1, 8) + blob(7, graph) + blob(8, number(2, 13)))

vocab = {token: index for index, token in enumerate(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "hello", "world"])}
config = {"model_type": "bert", "hidden_size": 1, "num_attention_heads": 1, "num_hidden_layers": 1,
          "intermediate_size": 1, "vocab_size": len(vocab), "max_position_embeddings": 512}
tokenizer_config = {"tokenizer_class": "BertTokenizer", "model_max_length": 512,
                    "unk_token": "[UNK]", "sep_token": "[SEP]", "pad_token": "[PAD]",
                    "cls_token": "[CLS]", "mask_token": "[MASK]"}
tokenizer = {"version": "1.0", "truncation": None, "padding": None, "added_tokens": [],
             "normalizer": {"type": "BertNormalizer", "clean_text": True, "handle_chinese_chars": True,
                            "strip_accents": None, "lowercase": True},
             "pre_tokenizer": {"type": "BertPreTokenizer"},
             "post_processor": {"type": "BertProcessing", "sep": ["[SEP]", 3], "cls": ["[CLS]", 2]},
             "decoder": {"type": "WordPiece", "prefix": "##", "cleanup": True},
             "model": {"type": "WordPiece", "unk_token": "[UNK]", "continuing_subword_prefix": "##",
                       "max_input_chars_per_word": 100, "vocab": vocab}}
for name, data in [("config", config), ("tokenizer_config", tokenizer_config), ("tokenizer", tokenizer)]:
    (root / (name + ".json")).write_text(json.dumps(data))
print("Offline fixture: 1 ONNX graph, 3 JSON files")
