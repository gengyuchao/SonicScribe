# models.py (集中管理所有模型实例)
from typing import Optional
import logging

from config import AppConfig
from asr import ASRModel
from vad import VADProcessor

# 配置专用 logger
logger = logging.getLogger("model_manager")

# 内部使用的全局实例（带下划线前缀表示私有）
_asr_model: Optional[ASRModel] = None
_vad_processor: Optional[VADProcessor] = None

def asr_model_init() -> None:
    """
    安全初始化 ASR 模型（幂等操作）
    
    :param config: 模型配置字典，包含:
                   - model_path: 模型文件路径
                   - device: 运行设备 (cuda/cpu)
                   - sample_rate: 音频采样率
    :raises ValueError: 配置无效时
    """
    global _asr_model
    
    if _asr_model is not None:
        logger.warning("ASR model already initialized. Skipping re-initialization.")
        return
    
    _asr_model = ASRModel(AppConfig.CHECKPOINT_PATH, device=AppConfig.DEVICE)

def vad_model_init() -> None:
    """
    安全初始化 VAD 处理器（幂等操作）
    
    :param config: 处理器配置字典，包含:
                   - threshold: 语音活动阈值 (0.0-1.0)
                   - min_speech_duration: 最小语音段长度(ms)
                   - sample_rate: 音频采样率
    """
    global _vad_processor
    
    if _vad_processor is not None:
        logger.warning("VAD processor already initialized. Skipping re-initialization.")
        return
    
    _vad_processor = VADProcessor()
    

def asr_model_get() -> ASRModel:
    """
    安全获取 ASR 模型实例
    
    :return: 已初始化的 ASRModel 实例
    :raises RuntimeError: 未初始化时
    """
    if _asr_model is None:
        logger.error("Attempted to access uninitialized ASR model")
        raise RuntimeError("ASR model not initialized. Call asr_model_init() first!")
    return _asr_model

def vad_model_get() -> VADProcessor:
    """
    安全获取 VAD 处理器实例
    
    :return: 已初始化的 VADProcessor 实例
    :raises RuntimeError: 未初始化时
    """
    if _vad_processor is None:
        logger.error("Attempted to access uninitialized VAD processor")
        raise RuntimeError("VAD processor not initialized. Call vad_model_init() first!")
    return _vad_processor