import torch
import numpy as np
import torchaudio
from silero_vad import load_silero_vad, get_speech_timestamps, VADIterator, read_audio

class VADProcessor:
    def __init__(self, threshold=0.5, sampling_rate=16000):
        """
        初始化 VAD 处理器
        :param threshold: VAD 阈值 (0.0-1.0)
        :param sampling_rate: 采样率 (Hz)，必须是8000或16000
        """
        self.model = load_silero_vad()
        self.sampling_rate = sampling_rate
        self.threshold = threshold
        self.min_speech_duration = 0.3  # 最小语音持续时间(秒)
        self.max_silence_duration = 1.0  # 最大静音持续时间(秒)
        self.vad_iterator = None
        
        # 验证采样率
        if self.sampling_rate not in [8000, 16000]:
            raise ValueError("采样率必须是8000或16000 Hz")
    
    def _normalize_audio(self, audio_tensor):
        """
        标准化音频到[-1, 1]范围
        """
        if isinstance(audio_tensor, np.ndarray):
            audio_tensor = torch.tensor(audio_tensor, dtype=torch.float32)
        
        # 确保是浮点类型
        if audio_tensor.dtype not in [torch.float32, torch.float64]:
            audio_tensor = audio_tensor.float()
        
        # 归一化到[-1, 1]范围
        if audio_tensor.abs().max() > 1.0:
            audio_tensor = audio_tensor / audio_tensor.abs().max()
        
        return audio_tensor
    
    def detect_voice_activity(self, audio_tensor, threshold=None):
        """
        检测语音活动
        :param audio_tensor: 音频张量，形状为 [1, T] 或 [T]
        :param threshold: VAD阈值 (可选，覆盖初始化值)
        :return: (speech_timestamps, is_speech)
        """
        if threshold is None:
            threshold = self.threshold
        
        # 确保音频是正确的格式
        if isinstance(audio_tensor, torch.Tensor):
            audio = audio_tensor.squeeze()
        else:
            audio = torch.tensor(audio_tensor).squeeze()
        
        # 标准化音频
        audio = self._normalize_audio(audio)
        
        # 确保是16kHz采样率（创建副本，不修改self.sampling_rate）
        current_sampling_rate = self.sampling_rate
        if current_sampling_rate != 16000:
            resampler = torchaudio.transforms.Resample(
                orig_freq=current_sampling_rate, 
                new_freq=16000
            )
            audio = resampler(audio)
            current_sampling_rate = 16000
        
        # 使用正确的 API 调用
        speech_timestamps = get_speech_timestamps(
            audio,
            self.model,
            threshold=threshold,
            sampling_rate=current_sampling_rate,
            min_speech_duration_ms=int(self.min_speech_duration * 1000),
            max_speech_duration_s=float('inf'),
            min_silence_duration_ms=int(self.max_silence_duration * 1000)
        )
        
        is_speech = len(speech_timestamps) > 0
        return speech_timestamps, is_speech
    
    def is_voice_active(self, audio_chunk, threshold=None):
        """
        检查音频块是否包含语音
        :param audio_chunk: 音频块，numpy 数组或 torch 张量
        :param threshold: VAD阈值 (可选，覆盖初始化值)
        :return: bool
        """
        if threshold is None:
            threshold = self.threshold
        
        # 确保音频是正确的格式
        if isinstance(audio_chunk, np.ndarray):
            audio_tensor = torch.tensor(audio_chunk, dtype=torch.float32)
        elif isinstance(audio_chunk, torch.Tensor):
            audio_tensor = audio_chunk.float()
        else:
            raise ValueError("音频块必须是 numpy 数组或 torch 张量")
        
        # 标准化音频
        audio_tensor = self._normalize_audio(audio_tensor)
        
        # 确保是16kHz采样率
        current_sampling_rate = self.sampling_rate
        if current_sampling_rate != 16000:
            resampler = torchaudio.transforms.Resample(
                orig_freq=current_sampling_rate, 
                new_freq=16000
            )
            audio_tensor = resampler(audio_tensor)
            current_sampling_rate = 16000
        
        # 检查是否有语音
        speech_timestamps = get_speech_timestamps(
            audio_tensor,
            self.model,
            threshold=threshold,
            sampling_rate=current_sampling_rate,
            min_speech_duration_ms=100,  # 100ms 最小语音持续时间
            max_speech_duration_s=1.0,   # 1秒最大语音持续时间
            min_silence_duration_ms=100  # 100ms 最小静音持续时间
        )
        
        return len(speech_timestamps) > 0
    
    def set_threshold(self, threshold):
        """
        动态设置 VAD 阈值
        :param threshold: 新的阈值 (0.0-1.0)
        """
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("阈值必须在 0.0 到 1.0 之间")
        self.threshold = threshold
        print(f"✅ VAD 阈值更新为: {threshold}")
    
    def get_threshold(self):
        """
        获取当前 VAD 阈值
        :return: float
        """
        return self.threshold
    
    def reset(self):
        """重置 VAD 迭代器"""
        self.vad_iterator = None
    
    def load_audio_file(self, file_path, target_sampling_rate=16000):
        """
        加载并预处理音频文件
        :param file_path: 音频文件路径
        :param target_sampling_rate: 目标采样率
        :return: 处理后的音频张量
        """
        try:
            # 尝试使用torchaudio加载
            waveform, sample_rate = torchaudio.load(file_path)
            print(f"🎵 使用 torchaudio 加载音频文件: {file_path}")
            print(f"   原始采样率: {sample_rate}Hz, 形状: {waveform.shape}")
        except Exception as e:
            print(f"⚠️ torchaudio加载失败: {e}")
            try:
                # 尝试使用librosa加载
                import librosa
                waveform, sample_rate = librosa.load(file_path, sr=None, mono=True)
                waveform = torch.tensor(waveform).unsqueeze(0)
                print(f"🎵 使用 librosa 加载音频文件: {file_path}")
                print(f"   原始采样率: {sample_rate}Hz, 形状: {waveform.shape}")
            except Exception as e:
                print(f"⚠️ librosa加载失败: {e}")
                # 使用silero_vad的read_audio作为最后手段
                waveform = read_audio(file_path, sampling_rate=target_sampling_rate)
                sample_rate = target_sampling_rate
                print(f"🎵 使用 silero_vad read_audio 加载音频文件: {file_path}")
        
        # 确保是单声道
        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)
            print("   ➡️ 转换为单声道")
        
        # 重采样到目标采样率
        if sample_rate != target_sampling_rate:
            resampler = torchaudio.transforms.Resample(
                orig_freq=sample_rate,
                new_freq=target_sampling_rate
            )
            waveform = resampler(waveform)
            print(f"   ➡️ 重采样到 {target_sampling_rate}Hz")
        
        # 标准化音频
        waveform = self._normalize_audio(waveform)
        
        return waveform.squeeze()