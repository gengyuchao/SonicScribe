import io
from pydub import AudioSegment
import numpy as np
import torch


def convert_audio_to_wav(file_content, filename):
    """转换音频到16kHz WAV格式"""
    audio_data = io.BytesIO(file_content)
    format_hint = get_audio_format(filename)
    
    try:
        audio = AudioSegment.from_file(audio_data, format=format_hint)
    except:
        audio_data.seek(0)
        audio = AudioSegment.from_file(audio_data)
    
    audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
    return audio

def audiosegment_to_tensor(audio_segment):
    """将AudioSegment转换为PyTorch张量"""
    samples = np.array(audio_segment.get_array_of_samples())
    samples = samples.astype(np.float32) / 32768.0  # 归一化到[-1, 1]
    return torch.tensor(samples).unsqueeze(0)

def get_audio_format(filename):
    """智能检测音频格式"""
    filename = filename.lower()
    if '.wav' in filename:
        return 'wav'
    elif '.mp3' in filename or '.mpeg' in filename:
        return 'mp3'
    elif '.m4a' in filename or '.mp4' in filename:
        return 'mp4'
    elif '.flac' in filename:
        return 'flac'
    elif '.ogg' in filename or '.webm' in filename:
        return 'ogg'
    else:
        return None
        
def standardize_audio_tensor(audio_tensor: torch.Tensor) -> torch.Tensor:
    """
    将任意形状的音频张量标准化为模型期望的[1, N]形状
    
    处理逻辑:
    - 1D张量 [N] -> 添加通道维度 [1, N]
    - 2D张量 [C, N] -> 取第一通道 [1, N]
    - 2D张量 [N, C] -> 转置并取单通道 [1, N]
    - 3D+张量 -> 抛出异常
    
    返回: 形状为 [1, N] 的张量
    """
    original_shape = audio_tensor.shape
    
    # 1. 确保是浮点类型
    if not audio_tensor.is_floating_point():
        audio_tensor = audio_tensor.float()
    
    # 2. 处理不同维度
    if audio_tensor.dim() == 1:
        # [N] -> [1, N]
        audio_tensor = audio_tensor.unsqueeze(0)
        print(f"升维: {original_shape} -> {audio_tensor.shape}")
    
    elif audio_tensor.dim() == 2:
        # 处理 [C, N] 格式 (正确格式)
        if audio_tensor.shape[0] == 1:
            pass  # 已是正确形状 [1, N]
        
        # 处理 [N, C] 格式 (转置)
        elif audio_tensor.shape[1] == 1:
            audio_tensor = audio_tensor.transpose(0, 1)  # [N, 1] -> [1, N]
            print(f"转置: {original_shape} -> {audio_tensor.shape}")
        
        # 多声道处理 (取第一通道)
        elif audio_tensor.shape[0] > 1:
            logger.warning(f"多声道音频，取第一通道 (原始形状: {original_shape})")
            audio_tensor = audio_tensor[0:1, :]  # 保持2D形状
        
        # 异常形状
        else:
            raise ValueError(f"不支持的2D形状: {original_shape}")
    
    else:
        raise ValueError(f"不支持的张量维度: {audio_tensor.dim()}, 形状: {original_shape}")
    
    # 3. 验证结果
    if audio_tensor.shape[0] != 1:
        raise ValueError(f"通道数必须为1，当前形状: {audio_tensor.shape}")
    
    print(f"✅ 标准化后形状: {audio_tensor.shape}, 值范围: [{audio_tensor.min().item():.4f}, {audio_tensor.max().item():.4f}]")
    return audio_tensor