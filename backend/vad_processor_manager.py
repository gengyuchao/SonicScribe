import os
import time
import logging
import asyncio
import traceback  # 添加 traceback 导入
from config import AppConfig
from data_basic import AudioChunk, SpeechSegment
from typing import Optional, List, Tuple
from audio_manager import AudioBufferManager
from vad import VADProcessor
import torch
import numpy as np
from models_manager import asr_model_get, vad_model_get

logger = logging.getLogger("speech-to-text")

# ======================
# VAD 处理器 
# ======================
class VADProcessorManager:
    """VAD处理管理器，按10个片段组合进行语音活动检测"""
    def __init__(self, buffer_manager: AudioBufferManager):
        self.buffer_manager = buffer_manager
        self.vad_is_speaking = False
        self.speech_start_chunk_id = -1
        self.speech_start_time = -1.0
        self.silence_count = 0
        self.speech_count = 0
        self.last_processed_chunk_id = -1
        self.last_vad_time = time.time()
        self.processing_window = AppConfig.VAD_PROCESS_WINDOW  # 组合10个片段进行VAD检测
        self.chunk_accumulator = []  # 用于累积片段
        self.vad_processor = vad_model_get()
        
        # ========== 动态阈值参数 ==========
        self.current_vad_threshold = AppConfig.VAD_INITIAL_THRESHOLD  # 初始阈值 0.3
        self.vad_threshold_min = AppConfig.VAD_THRESHOLD_MIN  # 最小阈值 0.3
        self.vad_threshold_max = AppConfig.VAD_THRESHOLD_MAX  # 最大阈值 0.9
        self.vad_threshold_step = AppConfig.VAD_THRESHOLD_STEP  # 每次增加步长 0.05
        self.vad_threshold_decay = AppConfig.VAD_THRESHOLD_DECAY  # 指数衰减系数 0.95
    
    async def process_vad(self) -> Tuple[bool, Optional[int], Optional[int]]:
        """
        增强版VAD处理 - 按10个片段组合处理，支持动态阈值调整
        返回: (状态变化, 语音开始片段ID, 语音结束片段ID)
        """
        # 记录VAD处理间隔
        current_time = time.time()
        self.last_vad_time = current_time
        
        # 获取待处理的片段 - 只获取未处理的片段
        recent_chunks = self.buffer_manager.get_chunks_for_vad()
        
        # 调试：记录缓冲区状态
        if not recent_chunks:
            logger.debug(f"🔍 无新音频片段用于VAD处理，最后处理片段ID: {self.last_processed_chunk_id}")
            return False, None, None
        
        # 更新最后处理的片段ID
        if recent_chunks[-1].chunk_id > self.last_processed_chunk_id:
            self.last_processed_chunk_id = recent_chunks[-1].chunk_id
        
        # 累积片段
        for chunk in recent_chunks:
            if chunk.chunk_id not in [c.chunk_id for c in self.chunk_accumulator]:
                self.chunk_accumulator.append(chunk)

        # 检查是否累积了足够的片段
        if len(self.chunk_accumulator) < self.processing_window:
            logger.debug(f"⏳ 等待更多片段用于VAD处理，当前: {len(self.chunk_accumulator)}/{self.processing_window}")
            return False, None, None
        
        # 确保片段按时间顺序排列
        self.chunk_accumulator.sort(key=lambda x: x.chunk_id)
        
        logger.debug(f"🔍 开始VAD处理，片段ID范围: {self.chunk_accumulator[0].chunk_id}-{self.chunk_accumulator[-1].chunk_id}, 当前阈值: {self.current_vad_threshold:.2f}")
        
        state_changed = False
        speech_start_id = None
        speech_end_id = None
        
        try:
            # 组合10个片段的音频数据
            combined_audio = bytearray()
            for chunk in self.chunk_accumulator[:self.processing_window]:
                combined_audio.extend(chunk.audio_data)
            
            # 转换为tensor进行VAD处理
            audio_array = np.frombuffer(bytes(combined_audio), dtype=np.int16)
            if len(audio_array) == 0:
                logger.warning("⚠️ 无效音频数据，跳过VAD处理")
                self.chunk_accumulator = self.chunk_accumulator[self.processing_window:]
                return False, None, None
            
            logger.debug(f"🔊 处理VAD组合数据，总样本数: {len(audio_array)}, 片段数: {self.processing_window}, 阈值: {self.current_vad_threshold:.2f}")
            
            audio_array = audio_array.copy()
            audio_tensor = torch.tensor(audio_array, dtype=torch.float32)
            audio_tensor = audio_tensor / 32768.0

            # ========== 使用动态阈值进行VAD检测 ==========
            is_speech = self.vad_processor.is_voice_active(
                audio_tensor.squeeze(), 
                threshold=self.current_vad_threshold  # 使用当前动态阈值
            )
            
            if is_speech:
                self.speech_count += 1
                self.speech_count = min(self.speech_count, AppConfig.VAD_SMOOTHING_WINDOW)
                self.silence_count = max(0, self.silence_count - 1)  # 平滑减少静音计数
            else:
                self.silence_count += 1
                self.silence_count = min(self.silence_count, AppConfig.VAD_SMOOTHING_WINDOW)
                self.speech_count = max(0, self.speech_count - 1)
            
            # 确保计数是整数
            self.speech_count = int(self.speech_count)
            self.silence_count = int(self.silence_count)
            
            # ========== 动态阈值调整逻辑 ==========
            prev_threshold = self.current_vad_threshold
            
            # 情况1: 检测到语音开始 - 开始提升阈值
            if not self.vad_is_speaking and self.speech_count >= 1:
                self.vad_is_speaking = True
                self.speech_start_chunk_id = self.chunk_accumulator[0].chunk_id
                self.speech_start_time = self.chunk_accumulator[0].timestamp
                speech_start_id = self.chunk_accumulator[0].chunk_id
                state_changed = True
                logger.info(f"🎙️ 语音开始检测，组合片段ID: {speech_start_id}-{self.chunk_accumulator[-1].chunk_id} 语音计数: {self.speech_count}, 阈值: {self.current_vad_threshold:.2f}")
                
                # 开始提升阈值（但不超过最大值）
                new_threshold = min(
                    self.current_vad_threshold + self.vad_threshold_step,
                    self.vad_threshold_max
                )
                # 指数衰减平滑过渡
                self.current_vad_threshold =  new_threshold
                logger.debug(f"📈 语音开始 - 阈值提升: {prev_threshold:.2f} → {self.current_vad_threshold:.2f}")
            
            # 情况2: 语音中持续检测 - 逐渐提升阈值
            elif self.vad_is_speaking and self.speech_count > 0:
                # 继续提升阈值（但不超过最大值）
                new_threshold = min(
                    self.current_vad_threshold + self.vad_threshold_step * 0.3,  # 减缓提升速度
                    self.vad_threshold_max
                )
                # 指数衰减平滑过渡
                self.current_vad_threshold = new_threshold
                
                logger.info(f"📈 语音持续 - 阈值提升: {prev_threshold:.2f} → {self.current_vad_threshold:.2f}")
            
            # 情况3: 检测到语音结束 - 重置阈值
            elif self.vad_is_speaking and self.silence_count >= AppConfig.VAD_SMOOTHING_WINDOW:
                self.vad_is_speaking = False
                speech_end_id = self.chunk_accumulator[-1].chunk_id
                state_changed = True
                
                # 重置阈值到最小值
                prev_threshold = self.current_vad_threshold
                self.current_vad_threshold = self.vad_threshold_min
                logger.info(f"⏹️ 语音结束检测，组合片段ID: {self.chunk_accumulator[0].chunk_id}-{speech_end_id} 静音计数: {self.silence_count}, 阈值重置: {prev_threshold:.2f} → {self.current_vad_threshold:.2f}")
            
            # 情况4: 长时间无语音 - 确保阈值保持在最小值
            elif not self.vad_is_speaking and self.silence_count >= AppConfig.VAD_SMOOTHING_WINDOW:
                self.current_vad_threshold = self.vad_threshold_min
            
            # ========== 边界保护 ==========
            # 确保阈值在合理范围内
            self.current_vad_threshold = max(self.vad_threshold_min, min(self.vad_threshold_max, self.current_vad_threshold))
            
            # 清除已处理的片段
            self.chunk_accumulator = self.chunk_accumulator[self.processing_window:]
            
        except Exception as e:
            logger.error(f"❌ VAD组合处理失败: {str(e)}\n{traceback.format_exc()}")
            # 异常时重置阈值到安全值
            self.current_vad_threshold = max(self.vad_threshold_min, min(self.vad_threshold_max, self.current_vad_threshold))
            # 清除缓冲区以避免卡住
            self.chunk_accumulator = []
        
        return state_changed, speech_start_id, speech_end_id
    
    def is_speaking_state(self) -> bool:
        """获取当前VAD状态"""
        return self.vad_is_speaking
    
    def get_current_threshold(self) -> float:
        """获取当前VAD阈值（用于监控）"""
        return self.current_vad_threshold