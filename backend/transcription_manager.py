import os
import time
import logging
import asyncio
import numpy as np
import torch
import asyncio
import traceback
from config import AppConfig
from models_manager import asr_model_get

logger = logging.getLogger("speech-to-text")

# ======================
# 转录管理器
# ======================
class TranscriptionManager:
    """转录管理器，处理临时和确认转录"""
    async def transcribe_temporary(self, audio_data: bytes) -> str:
        """临时转录，快速响应"""
        if not audio_data or len(audio_data) < AppConfig.AUDIO_CHUNK_SIZE:
            return ""
        
        try:
            return await self._transcribe(audio_data, is_final=False, max_new_tokens=15)
        except Exception as e:
            logger.error(f"❌ 临时转录失败: {str(e)}\n{traceback.format_exc()}")
            return ""
    
    async def transcribe_committed(self, audio_data: bytes, segment_duration: float) -> str:
        """确认转录，高准确度"""
        if not audio_data or len(audio_data) < AppConfig.AUDIO_CHUNK_SIZE * 2:
            return ""
        
        try:
            # 根据时长调整 max_new_tokens
            max_new_tokens = min(50 + int(segment_duration * 5), 200)
            return await self._transcribe(audio_data, is_final=True, max_new_tokens=max_new_tokens)
        except Exception as e:
            logger.error(f"❌ 确认转录失败: {str(e)}\n{traceback.format_exc()}")
            return ""
    
    async def _transcribe(self, audio_data: bytes, is_final: bool, max_new_tokens: int) -> str:
        """通用转录方法"""
        audio_array = np.frombuffer(audio_data, dtype=np.int16)
        if len(audio_array) == 0:
            return ""
        
        audio_array = audio_array.copy()
        audio_tensor = torch.from_numpy(audio_array)
        audio_tensor = audio_tensor.float() / 32768.0
        
        if len(audio_tensor.shape) == 1:
            audio_tensor = audio_tensor.unsqueeze(0)
        
        asr_model = asr_model_get()
        if asr_model:
            result = asr_model.transcribe(
                audio_tensor,
                sampling_rate=16000,
                max_new_tokens=max_new_tokens
            )
            return result.strip()
        
        return ""
