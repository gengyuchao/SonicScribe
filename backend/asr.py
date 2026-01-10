import os
import tempfile
from pathlib import Path
from typing import Union, Dict, Any, List, Optional

import numpy as np
import soundfile as sf
import torch
import torchaudio
from transformers import (
    AutoConfig,
    AutoModel,
    AutoProcessor,
)


class ASRModel:
    def __init__(self, checkpoint_dir: str, device: str = "cuda"):
        """
        初始化 ASR 模型。
        
        Args:
            checkpoint_dir: 模型检查点目录路径。
            device: 运行设备 ("cuda" 或 "cpu")。
        """
        # 确定设备和 device_map 策略
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        # 对于 transformers，device_map 通常期望字符串或字典，而不是 torch.device 对象
        device_map = "auto" if self.device.type == "cuda" else "cpu"
        
        self.checkpoint_dir = Path(checkpoint_dir)
        self.model_dtype = torch.bfloat16
        
        # 加载 Processor
        self.processor = AutoProcessor.from_pretrained(str(self.checkpoint_dir))
        self.target_sr = self.processor.feature_extractor.sampling_rate
        
        # 加载配置
        self.config = AutoConfig.from_pretrained(self.checkpoint_dir, trust_remote_code=True)
        
        # 加载模型
        self.model = AutoModel.from_pretrained(
            self.checkpoint_dir,
            torch_dtype=self.model_dtype,
            device_map=device_map,
            trust_remote_code=True,
        )
        self.model.eval()

    def _prepare_audio_tempfile(self, audio_tensor: torch.Tensor, sampling_rate: int) -> str:
        """
        预处理音频张量并保存到临时 WAV 文件。
        
        处理流程：
        1. 确保单声道。
        2. 重采样至目标采样率。
        3. 归一化。
        4. 保存至临时文件。
        
        Args:
            audio_tensor: 输入音频张量 (Channel, Time) 或。
            sampling_rate: 原始采样率。
            
        Returns:
            临时文件的绝对路径。
        """
        # 处理 1D 输入 -> 2D (1, N)
        if audio_tensor.dim() == 1:
            audio_tensor = audio_tensor.unsqueeze(0)
            
        # 取单声道 (如果输入是多声道，取第一声道)
        wav = audio_tensor[:1, :]

        # 重采样 (如果采样率不匹配)
        if sampling_rate != self.target_sr:
            # 每次实例化 Resample 可能会有开销，但能动态适应不同输入采样率
            resampler = torchaudio.transforms.Resample(
                orig_freq=sampling_rate, 
                new_freq=self.target_sr
            )
            wav = resampler(wav)

        # 归一化 (保持原逻辑：避免除零，并归一化到 [-1, 1])
        # 注意：这会改变音频的绝对响度，但保持相对动态范围
        max_val = torch.max(torch.abs(wav))
        if max_val > 1e-6:
            wav = wav / max_val
            
        # 创建临时文件
        # 使用 delete=False，因为我们需要在上下文之外由 processor 读取它
        # 文件将在 transcribe 结束时手动删除
        fd, tmp_path = tempfile.mkstemp(suffix='.wav')
        os.close(fd) # 关闭文件描述符，让 soundfile 可以打开它
        
        # 保存音频
        sf.write(tmp_path, wav.squeeze(0).cpu().numpy(), self.target_sr)
        
        return tmp_path

    def _prepare_model_inputs(self, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """
        准备模型输入数据，确保张量位于正确的设备和拥有正确的精度。
        """
        prepared_inputs = {}
        for key, value in inputs.items():
            if isinstance(value, torch.Tensor):
                # input_ids 和 attention_mask 必须是 long 类型
                if key in ("input_ids", "attention_mask"):
                    prepared_inputs[key] = value.to(self.device, dtype=torch.long)
                # 其他浮点张量 (如 audios) 转换为模型精度
                elif value.is_floating_point():
                    prepared_inputs[key] = value.to(self.device, dtype=self.model_dtype)
                else:
                    prepared_inputs[key] = value.to(self.device)
            else:
                prepared_inputs[key] = value
        return prepared_inputs

    def _format_hotwords_prompt(self, hotwords: List[str], max_hotwords: int = 10) -> str:
        """
        格式化热词提示语句
        
        Args:
            hotwords: 热词列表
            max_hotwords: 最大热词数量限制
            
        Returns:
            格式化后的热词提示字符串
        """
        if not hotwords:
            return ""
        
        # 清理和去重热词
        cleaned_hotwords = [
            hw.strip().lower() 
            for hw in set(hotwords) 
            if hw and isinstance(hw, str) and hw.strip()
        ]
        
        if not cleaned_hotwords:
            return ""
        
        # 限制热词数量
        if len(cleaned_hotwords) > max_hotwords:
            cleaned_hotwords = cleaned_hotwords[:max_hotwords]
        
        # 构建提示语句
        hotwords_str = ", ".join(f'"{hw}"' for hw in cleaned_hotwords)
        return f". Pay special attention to these important terms: {hotwords_str}"

    def transcribe(
        self, 
        audio_tensor: torch.Tensor, 
        sampling_rate: int = 16000, 
        max_new_tokens: int = 128,
        hotwords: Optional[List[str]] = None
    ) -> str:
        """
        执行语音识别转录，支持热词增强功能
        
        Args:
            audio_tensor: 输入音频张量。
            sampling_rate: 音频采样率。
            max_new_tokens: 最大生成的 token 数量。
            hotwords: 需要特别关注的热词列表，例如 ["brand name", "product name"]
            
        Returns:
            转录后的文本字符串。
        """
        temp_audio_path = None
        try:
            # 1. 预处理音频并获取临时文件路径
            temp_audio_path = self._prepare_audio_tempfile(audio_tensor, sampling_rate)

            # 2. 构建基础指令
            base_instruction = "Please transcribe this audio into text"
            
            # 3. 添加热词提示（如果提供）
            hotwords_prompt = self._format_hotwords_prompt(hotwords or [])
            full_instruction = base_instruction + hotwords_prompt

            # 4. 构建符合 chat template 格式的消息
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "audio", "url": temp_audio_path},
                        {"type": "text", "text": full_instruction},
                    ],
                }
            ]

            # 5. 应用 chat template 并转换为张量
            inputs = self.processor.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                return_dict=True,
                return_tensors="pt"
            )

            # 6. 转换数据类型并移动到设备
            inputs = self._prepare_model_inputs(inputs)

            input_length = inputs["input_ids"].shape[1]

            # 7. 推理生成
            with torch.no_grad():
                outputs = self.model.generate(
                    **inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                )

            # 8. 解码结果
            generated_tokens = outputs[:, input_length:]
            transcript = self.processor.batch_decode(
                generated_tokens,
                skip_special_tokens=True
            )[0].strip()

            return transcript

        finally:
            # 9. 清理临时文件 (确保无论是否出错都执行)
            if temp_audio_path and os.path.exists(temp_audio_path):
                os.unlink(temp_audio_path)