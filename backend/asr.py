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
import warnings

try:
    import bitsandbytes as bnb
    from bitsandbytes.nn import Int8Params
    HAS_BITSANDBYTES = True
except ImportError:
    HAS_BITSANDBYTES = False
    warnings.warn("bitsandbytes not installed. INT8 mode will not be available. Install with: pip install bitsandbytes")

class ASRModel:
    def __init__(self, checkpoint_dir: str, device: str = "cuda", mode: str = "native"):
        """
        初始化 ASR 模型，支持原生模式和 INT8 量化模式。
        
        Args:
            checkpoint_dir: 模型检查点目录路径。
            device: 运行设备 ("cuda" 或 "cpu")。
            mode: 运行模式，可选 "native" (原生 bfloat16) 或 "int8" (8-bit 量化)
                - "native": 使用 torch.bfloat16，精度高，显存占用大
                - "int8": 使用 8-bit 量化，显存占用小，适合 GTX1060 等小显存显卡
        """
        # 验证模式
        if mode not in ["native", "int8"]:
            raise ValueError("mode must be either 'native' or 'int8'")
        
        if mode == "int8" and not HAS_BITSANDBYTES:
            raise ImportError("INT8 mode requires bitsandbytes. Install with: pip install bitsandbytes")
        
        # 确定设备
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        self.mode = mode
        
        # 设置模型数据类型
        self.model_dtype = torch.bfloat16 if mode == "native" else torch.float16
        
        self.checkpoint_dir = Path(checkpoint_dir)
        
        # 加载 Processor
        self.processor = AutoProcessor.from_pretrained(str(self.checkpoint_dir))
        self.target_sr = self.processor.feature_extractor.sampling_rate
        
        # 加载配置
        self.config = AutoConfig.from_pretrained(self.checkpoint_dir, trust_remote_code=True)
        
        print(f"🚀 初始化 ASR 模型 | 模式: {mode.upper()} | 设备: {self.device}")

        # 检查是否为 GLM-ASR 模型
        self.is_glm_asr = hasattr(self.config, "model_type") and "glm" in str(self.config.model_type).lower()
        print(f"🔍 检测到模型类型: {'GLM-ASR' if self.is_glm_asr else '其他模型'}")

        # 加载模型
        if mode == "int8" and self.is_glm_asr:
            self.model = self._load_glm_asr_int8()
        else:
            self.model = self._load_model_standard(mode)
        
        self.model.eval()
        
        # 打印模型信息
        self._print_model_info()

    def _load_model_standard(self, mode: str):
        """标准方式加载模型（原生模式或非GLM-ASR的INT8模式）"""
        model_kwargs = {
            "trust_remote_code": True,
        }
        
        if self.device.type == "cuda":
            model_kwargs["device_map"] = "auto" if mode == "int8" else str(self.device)
        
        if mode == "native":
            model_kwargs["torch_dtype"] = self.model_dtype
        
        if mode == "int8" and not self.is_glm_asr:
            # 非GLM-ASR模型使用标准的load_in_8bit
            model_kwargs["load_in_8bit"] = True
        
        # 加载模型
        model = AutoModel.from_pretrained(
            self.checkpoint_dir,
            **model_kwargs
        )
        
        # 原生模式需要手动移动到设备
        if mode == "native" and self.device.type == "cuda":
            model = model.to(self.device)
        
        return model

    def _load_glm_asr_int8(self):
        """专门处理GLM-ASR模型的8-bit量化加载"""
        print("🔧 使用手动量化方式加载 GLM-ASR 模型 (INT8 模式)")
        
        # 1. 首先以float16加载模型到CPU
        with torch.device('cpu'):
            model = AutoModel.from_pretrained(
                self.checkpoint_dir,
                torch_dtype=torch.float16,
                trust_remote_code=True,
            )
        
        # 2. 应用8-bit量化
        self._quantize_model_int8(model)
        
        # 3. 移动到GPU
        if self.device.type == "cuda":
            model = model.to(self.device)
        
        return model

    def _quantize_model_int8(self, model):
        """手动将模型转换为8-bit量化"""
        print("⚡ 应用 8-bit 量化到模型...")
        
        for name, module in model.named_modules():
            if isinstance(module, torch.nn.Linear):
                # 跳过不需要量化的层（如lm_head）
                if any(skip_name in name for skip_name in ['lm_head', 'embed_tokens', 'audio_proj']):
                    continue
                
                print(f"  📦 量化线性层: {name}")
                
                # 创建8-bit线性层
                quantized_linear = bnb.nn.Linear8bitLt(
                    module.in_features,
                    module.out_features,
                    bias=module.bias is not None,
                    has_fp16_weights=False,  # 使用纯INT8
                    threshold=6.0,  # 默认阈值
                )
                
                # 复制权重并量化
                quantized_linear.weight = bnb.nn.Int8Params(
                    module.weight.data.cpu(), 
                    requires_grad=False, 
                    has_fp16_weights=False
                )
                
                if module.bias is not None:
                    quantized_linear.bias = torch.nn.Parameter(module.bias.data.cpu())
                
                # 替换原模块
                parent_name = '.'.join(name.split('.')[:-1])
                child_name = name.split('.')[-1]
                
                if parent_name:
                    parent_module = dict(model.named_modules())[parent_name]
                    setattr(parent_module, child_name, quantized_linear)
                else:
                    setattr(model, child_name, quantized_linear)
        
        print("✅ 8-bit 量化完成")

    def _print_model_info(self):
        """打印模型信息和显存使用情况"""
        if self.device.type == "cuda":
            torch.cuda.empty_cache()
            allocated = torch.cuda.memory_allocated() / 1024**2
            reserved = torch.cuda.memory_reserved() / 1024**2
            print(f"📊 GPU 显存使用: 已分配 {allocated:.1f}MB | 已保留 {reserved:.1f}MB")
        
        # 打印模型参数数量
        total_params = sum(p.numel() for p in self.model.parameters())
        trainable_params = sum(p.numel() for p in self.model.parameters() if p.requires_grad)
        print(f"📊 模型参数: 总计 {total_params/1e9:.2f}B | 可训练 {trainable_params/1e9:.2f}B")
        
        if self.mode == "int8":
            print("💡 INT8 模式提示: 显存占用大幅降低，但精度可能略有下降。适合 GTX1060 等小显存显卡。")

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
                # 其他浮点张量转换为模型精度
                elif value.is_floating_point():
                    if self.mode == "native":
                        prepared_inputs[key] = value.to(self.device, dtype=self.model_dtype)
                    else:
                        # INT8 模式使用 float16
                        prepared_inputs[key] = value.to(self.device, dtype=torch.float16)
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
        hotwords: Optional[List[str]] = None,
        return_debug_info: bool = False
    ) -> Union[str, Dict[str, Any]]:
        """
        执行语音识别转录，支持热词增强功能
        
        Args:
            audio_tensor: 输入音频张量。
            sampling_rate: 音频采样率。
            max_new_tokens: 最大生成的 token 数量。
            hotwords: 需要特别关注的热词列表，例如 ["brand name", "product name"]
            return_debug_info: 是否返回调试信息（包括处理时间和显存使用）
            
        Returns:
            转录后的文本字符串，或包含调试信息的字典（如果 return_debug_info=True）
        """
        temp_audio_path = None
        start_time = torch.cuda.Event(enable_timing=True) if self.device.type == "cuda" else None
        end_time = torch.cuda.Event(enable_timing=True) if self.device.type == "cuda" else None
        
        try:
            # 记录开始时间
            if self.device.type == "cuda":
                torch.cuda.synchronize()
                start_time = torch.cuda.Event(enable_timing=True)
                end_time = torch.cuda.Event(enable_timing=True)
                start_time.record()
            
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
                if self.mode == "native" and self.device.type == "cuda":
                    # 原生模式使用 autocast 优化性能
                    with torch.autocast(device_type='cuda', dtype=self.model_dtype):
                        outputs = self.model.generate(
                            **inputs,
                            max_new_tokens=max_new_tokens,
                            do_sample=False,
                        )
                else:
                    # INT8 模式或 CPU 模式直接推理
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

            # 记录结束时间
            elapsed_time = 0.0
            if self.device.type == "cuda":
                end_time.record()
                torch.cuda.synchronize()
                elapsed_time = start_time.elapsed_time(end_time) / 1000.0  # 转换为秒

            # 9. 清理缓存
            if self.device.type == "cuda":
                torch.cuda.empty_cache()

            if return_debug_info:
                debug_info = {
                    "transcript": transcript,
                    "processing_time": elapsed_time,
                    "audio_length_sec": audio_tensor.shape[-1] / sampling_rate,
                    "mode": self.mode,
                    "device": str(self.device),
                }
                
                if self.device.type == "cuda":
                    debug_info.update({
                        "gpu_memory_allocated_mb": torch.cuda.memory_allocated() / 1024**2,
                        "gpu_memory_reserved_mb": torch.cuda.memory_reserved() / 1024**2,
                    })
                
                return debug_info
            
            return transcript

        except RuntimeError as e:
            error_msg = str(e)
            if "out of memory" in error_msg.lower():
                print("⚠️ 显存不足！建议：")
                print("   1. 使用更短的音频")
                print("   2. 减少 max_new_tokens")
                print("   3. 如果使用原生模式，切换到 INT8 模式")
            elif "load_in_8bit" in error_msg:
                print("⚠️ 模型不支持直接加载 8-bit，已自动切换到手动量化方式")
            raise e
        except Exception as e:
            print(f"❌ 转录过程中发生错误: {str(e)}")
            raise e
        finally:
            # 9. 清理临时文件 (确保无论是否出错都执行)
            if temp_audio_path and os.path.exists(temp_audio_path):
                try:
                    os.unlink(temp_audio_path)
                except Exception as e:
                    print(f"⚠️ 无法删除临时文件 {temp_audio_path}: {e}")

    def get_model_info(self) -> Dict[str, Any]:
        """获取模型详细信息"""
        info = {
            "mode": self.mode,
            "device": str(self.device),
            "model_dtype": str(self.model_dtype),
            "target_sampling_rate": self.target_sr,
            "checkpoint_dir": str(self.checkpoint_dir),
            "is_glm_asr": self.is_glm_asr,
        }
        
        if self.device.type == "cuda":
            info.update({
                "cuda_version": torch.version.cuda,
                "gpu_name": torch.cuda.get_device_name(),
                "gpu_memory_total_mb": torch.cuda.get_device_properties(0).total_memory / 1024**2,
            })
        
        return info


# 使用示例
if __name__ == "__main__":
    # 示例1：原生模式（适合大显存显卡）
    try:
        print("\n=== 测试原生模式 ===")
        asr_native = ASRModel(
            checkpoint_dir="./glm-asr-model",
            device="cuda",
            mode="native"  # 原生 bfloat16 模式
        )
        print("✅ 原生模式模型初始化成功")
        print(f"模型信息: {asr_native.get_model_info()}")
    except Exception as e:
        print(f"❌ 原生模式初始化失败: {e}")

    # 示例2：INT8 模式（适合 GTX1060 等小显存显卡）
    try:
        print("\n=== 测试 INT8 模式 ===")
        asr_int8 = ASRModel(
            checkpoint_dir="./glm-asr-model",
            device="cuda", 
            mode="int8"  # 8-bit 量化模式
        )
        print("✅ INT8 模式模型初始化成功")
        print(f"模型信息: {asr_int8.get_model_info()}")
    except Exception as e:
        print(f"❌ INT8 模式初始化失败: {e}")
        print("💡 提示: 确保已安装 bitsandbytes: pip install bitsandbytes")

    # 示例3：CPU 模式（无 GPU 时）
    try:
        print("\n=== 测试 CPU 模式 ===")
        asr_cpu = ASRModel(
            checkpoint_dir="./glm-asr-model",
            device="cpu",
            mode="native"  # CPU 不支持 INT8
        )
        print("✅ CPU 模式模型初始化成功")
        print(f"模型信息: {asr_cpu.get_model_info()}")
    except Exception as e:
        print(f"❌ CPU 模式初始化失败: {e}")