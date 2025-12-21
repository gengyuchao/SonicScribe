import os
import time
import logging
from typing import Optional

logger = logging.getLogger("speech-to-text")

# ======================
# 音频片段和语音段管理
# ======================
class AudioChunk:
    """音频片段数据结构"""
    def __init__(self, chunk_id: int, timestamp: float, audio_data: bytes):
        self.chunk_id = chunk_id
        self.timestamp = timestamp  # 片段开始时间戳
        self.audio_data = audio_data
        self.vad_confidence = 0.0
        self.is_processed = False
        
    @property
    def duration(self) -> float:
        return AppConfig.AUDIO_CHUNK_DURATION_MS / 1000.0
    
    def to_dict(self) -> dict:
        return {
            "chunk_id": self.chunk_id,
            "timestamp": self.timestamp,
            "duration": self.duration,
            "vad_confidence": self.vad_confidence,
            "is_processed": self.is_processed
        }

class SpeechSegment:
    """语音段数据结构"""
    def __init__(self, start_chunk_id: int, start_time: float):
        self.start_chunk_id = start_chunk_id
        self.start_time = start_time
        self.end_chunk_id = -1
        self.end_time = -1.0
        self.audio_data = bytearray()
        self.transcript = ""
        self.temporary_transcripts: List[str] = []
        self.is_final = False
        self.created_at = time.time()
        
    @property
    def duration(self) -> float:
        if self.end_time <= 0:
            return time.time() - self.start_time
        return self.end_time - self.start_time
        
    def add_chunk(self, chunk: AudioChunk):
        """添加音频片段到语音段"""
        self.audio_data.extend(chunk.audio_data)
        if not self.is_final:
            chunk.is_processed = True
        
    def finalize(self, end_chunk_id: int, end_time: float):
        """结束语音段"""
        self.end_chunk_id = end_chunk_id
        self.end_time = end_time
        self.is_final = True
        
    def to_dict(self) -> dict:
        return {
            "start_chunk_id": self.start_chunk_id,
            "end_chunk_id": self.end_chunk_id,
            "start_time": self.start_time,
            "end_time": self.end_time,
            "duration": self.duration,
            "transcript": self.transcript,
            "temporary_transcripts": self.temporary_transcripts,
            "is_final": self.is_final,
            "segment_id": id(self)
        }

