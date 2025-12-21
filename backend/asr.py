import torch
from transformers import (
    AutoConfig,
    AutoModelForCausalLM,
    AutoTokenizer,
    WhisperFeatureExtractor,
)
from pathlib import Path
import numpy as np
import torchaudio

WHISPER_FEAT_CFG = {
    "chunk_length": 30,
    "feature_extractor_type": "WhisperFeatureExtractor",
    "feature_size": 128,
    "hop_length": 160,
    "n_fft": 400,
    "n_samples": 480000,
    "nb_max_frames": 3000,
    "padding_side": "right",
    "padding_value": 0.0,
    "processor_class": "WhisperProcessor",
    "return_attention_mask": False,
    "sampling_rate": 16000,
}

def get_audio_token_length(seconds, merge_factor=2):
    def get_T_after_cnn(L_in, dilation=1):
        for padding, kernel_size, stride in [(1,3,1)] + [(1,3,2)]:
            L_out = L_in + 2 * padding - dilation * (kernel_size - 1) - 1
            L_out = 1 + L_out // stride
            L_in = L_out
        return L_out
    mel_len = int(seconds * 100)
    audio_len_after_cnn = get_T_after_cnn(mel_len)
    audio_token_num = (audio_len_after_cnn - merge_factor) // merge_factor + 1
    audio_token_num = min(audio_token_num, 1500 // merge_factor)
    return audio_token_num

def build_prompt(
    audio_tensor,
    tokenizer,
    feature_extractor,
    merge_factor,
    sampling_rate=16000,
) -> dict:
    # 处理音频张量
    wav = audio_tensor[:1, :]  # 只取单声道
    
    # 重采样到目标采样率
    if sampling_rate != feature_extractor.sampling_rate:
        wav = torchaudio.transforms.Resample(sampling_rate, feature_extractor.sampling_rate)(wav)
    
    tokens = []
    tokens += tokenizer.encode("<|user|>")
    tokens += tokenizer.encode("\n")
    
    audios = []
    audio_offsets = []
    audio_length = []
    
    # 处理整个音频
    mel = feature_extractor(
        wav.numpy(),
        sampling_rate=feature_extractor.sampling_rate,
        return_tensors="pt",
        padding="max_length",
    )["input_features"]
    audios.append(mel)
    
    seconds = wav.shape[1] / feature_extractor.sampling_rate
    num_tokens = get_audio_token_length(seconds, merge_factor)
    tokens += tokenizer.encode("<|begin_of_audio|>")
    audio_offsets.append(len(tokens))
    tokens += [0] * num_tokens
    tokens += tokenizer.encode("<|end_of_audio|>")
    audio_length.append(num_tokens)
    
    # 添加提示文本
    tokens += tokenizer.encode("<|user|>")
    tokens += tokenizer.encode("\nPlease transcribe this audio into text")
    tokens += tokenizer.encode("<|assistant|>")
    tokens += tokenizer.encode("\n")
    
    batch = {
        "input_ids": torch.tensor([tokens], dtype=torch.long),
        "audios": torch.cat(audios, dim=0),
        "audio_offsets": [audio_offsets],
        "audio_length": [audio_length],
        "attention_mask": torch.ones(1, len(tokens), dtype=torch.long),
    }
    return batch

class ASRModel:
    def __init__(self, checkpoint_dir, device="cuda"):
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        self.checkpoint_dir = Path(checkpoint_dir)
        
        # 加载tokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.checkpoint_dir))
        
        # 加载特征提取器
        self.feature_extractor = WhisperFeatureExtractor(**WHISPER_FEAT_CFG)
        
        # 加载模型配置
        self.config = AutoConfig.from_pretrained(self.checkpoint_dir, trust_remote_code=True)
        
        # 加载模型
        self.model = AutoModelForCausalLM.from_pretrained(
            self.checkpoint_dir,
            config=self.config,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        )
        self.model = self.model.to(self.device)
        self.model.eval()
    
    def transcribe(self, audio_tensor, sampling_rate=16000, max_new_tokens=128):
        with torch.no_grad():
            batch = build_prompt(
                audio_tensor,
                self.tokenizer,
                self.feature_extractor,
                merge_factor=self.config.merge_factor,
                sampling_rate=sampling_rate
            )
            
            model_inputs, prompt_len = self.prepare_inputs(batch)
            
            generated = self.model.generate(
                **model_inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
            )
            
            transcript_ids = generated[0, prompt_len:].cpu().tolist()
            transcript = self.tokenizer.decode(transcript_ids, skip_special_tokens=True).strip()
            return transcript
    
    def prepare_inputs(self, batch):
        tokens = batch["input_ids"].to(self.device)
        attention_mask = batch["attention_mask"].to(self.device)
        audios = batch["audios"].to(self.device)
        
        model_inputs = {
            "inputs": tokens,
            "attention_mask": attention_mask,
            "audios": audios.to(torch.bfloat16),
            "audio_offsets": batch["audio_offsets"],
            "audio_length": batch["audio_length"],
        }
        return model_inputs, tokens.size(1)
