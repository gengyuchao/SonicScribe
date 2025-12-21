import os
import time
import logging
from config import AppConfig
from data_basic import AudioChunk, SpeechSegment
from typing import Optional, List

logger = logging.getLogger("speech-to-text")


class AudioBufferManager:
    """音频缓冲区管理器，处理音频片段的存储和检索"""
    def __init__(self):
        self.chunk_buffer: Dict[int, AudioChunk] = {}  # chunk_id -> AudioChunk
        self.speech_segments: List[SpeechSegment] = []
        self.current_segment: Optional[SpeechSegment] = None
        self.next_chunk_id = 0
        self.buffer_start_time = time.time()
        self.last_cleanup_time = time.time()
        
    def add_audio_chunk(self, audio_data: bytes) -> AudioChunk:
        """添加音频片段到缓冲区"""
        current_time = time.time()
        chunk_id = self.next_chunk_id
        self.next_chunk_id += 1
        
        chunk = AudioChunk(chunk_id, current_time, audio_data)
        self.chunk_buffer[chunk_id] = chunk
        
        # 清理旧数据
        self._cleanup_old_chunks()
        
        return chunk
    
    def _cleanup_old_chunks(self):
        """清理超过最大缓冲区的旧片段"""
        current_time = time.time()
        if current_time - self.last_cleanup_time < 1.0:  # 每秒清理一次
            return
            
        self.last_cleanup_time = current_time
        
        # 计算保留的最小时间
        min_time = current_time - AppConfig.MAX_AUDIO_BUFFER_SECONDS
        
        # 移除过期的片段
        old_chunk_ids = [cid for cid, chunk in self.chunk_buffer.items() 
                        if chunk.timestamp < min_time]
        
        for cid in old_chunk_ids:
            if cid in self.chunk_buffer:
                del self.chunk_buffer[cid]
        
        # 移除过期的语音段
        self.speech_segments = [seg for seg in self.speech_segments 
                               if seg.start_time >= min_time]
        
        logger.debug(f"🧹 缓冲区清理完成，剩余片段: {len(self.chunk_buffer)}, 剩余语音段: {len(self.speech_segments)}")
    
    def get_chunks_for_vad(self, window_size: int = AppConfig.VAD_SMOOTHING_WINDOW) -> List[AudioChunk]:
        """获取最近的N个片段用于VAD处理"""
        recent_chunks = sorted(
            [chunk for chunk in self.chunk_buffer.values() if not chunk.is_processed],
            key=lambda x: x.chunk_id,
            reverse=True
        )[:window_size]
        
        return sorted(recent_chunks, key=lambda x: x.chunk_id)  # 按时间顺序
    
    def get_chunks_by_range(self, start_chunk_id: int, end_chunk_id: int) -> List[AudioChunk]:
        """获取指定范围内的音频片段"""
        return [self.chunk_buffer[cid] for cid in range(start_chunk_id, end_chunk_id + 1) 
                if cid in self.chunk_buffer]
    
    def create_speech_segment(self, start_chunk_id: int, start_time: float) -> SpeechSegment:
        """创建新的语音段"""
        if self.current_segment:
            # 结束当前段
            self.current_segment.finalize(start_chunk_id - 1, start_time)
            self.speech_segments.append(self.current_segment)
            
            # 限制段数量
            if len(self.speech_segments) > AppConfig.MAX_SPEECH_SEGMENTS:
                self.speech_segments.pop(0)
        
        self.current_segment = SpeechSegment(start_chunk_id, start_time)
        logger.info(f"🎤 语音段创建，起始片段ID: {start_chunk_id}, 时间: {start_time:.3f}")
        return self.current_segment
    
    def finalize_current_segment(self, end_chunk_id: int, end_time: float) -> Optional[SpeechSegment]:
        """结束当前语音段"""
        if self.current_segment:
            segment = self.current_segment
            segment.finalize(end_chunk_id, end_time)
            self.speech_segments.append(segment)
            self.current_segment = None
            
            # 限制段数量
            if len(self.speech_segments) > AppConfig.MAX_SPEECH_SEGMENTS:
                self.speech_segments.pop(0)
                
            logger.info(f"✅ 语音段结束，片段范围: {segment.start_chunk_id}-{end_chunk_id}, 时长: {segment.duration:.2f}s")
            return segment
        return None
    
    def get_temporary_transcription_chunks(self) -> List[AudioChunk]:
        """获取用于临时转录的片段（当前语音段的最新10个片段）"""
        if not self.current_segment:
            return []
        
        start_chunk_id = max(self.current_segment.start_chunk_id, 
                            self.next_chunk_id - AppConfig.TEMPORARY_TRANSCRIPTION_INTERVAL)
        
        return self.get_chunks_by_range(start_chunk_id, self.next_chunk_id - 1)
    
    def get_committed_audio_data(self, segment: SpeechSegment) -> bytes:
        """获取用于确认转录的完整音频数据"""
        
        chunks = self.get_chunks_by_range(segment.start_chunk_id, self.next_chunk_id - 1)
        audio_data = bytearray()
        for chunk in chunks:
            audio_data.extend(chunk.audio_data)
        return bytes(audio_data)
    
    def cleanup(self):
        """清理所有资源"""
        self.chunk_buffer.clear()
        self.speech_segments.clear()
        self.current_segment = None
        logger.info("🧹 音频缓冲区已清理")
