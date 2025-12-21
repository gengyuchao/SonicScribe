import os
import time
import logging
import asyncio
import math
from fastapi import WebSocket
from starlette.websockets import WebSocketState
from typing import Optional, List, Tuple
from config import AppConfig
from vad import VADProcessor
from debug import DebugAudioManager
from audio_manager import AudioBufferManager
from data_basic import AudioChunk, SpeechSegment
from vad_processor_manager import VADProcessorManager
from transcription_manager import TranscriptionManager

logger = logging.getLogger("speech-to-text")


# ======================
# ConnectionManager 
# ======================
class ConnectionManager:
    """WebSocket连接管理器，协调VAD和转录处理"""
    def __init__(self, websocket: WebSocket, client_id: str):
        self.websocket = websocket
        self.client_id = client_id
        self.buffer_manager = AudioBufferManager()
        self.vad_processor = VADProcessorManager(self.buffer_manager)
        self.transcription_manager = TranscriptionManager()
        self.last_activity = time.time()
        self.is_active = True
        self.vad_task: Optional[asyncio.Task] = None
        self.last_temporary_transcription_time = 0.0
        self.last_chunk_id = -1
        self.saved_temporary_transcription_text = ""
        
    async def start_vad_processing(self):
        """启动独立的VAD处理任务"""
        if self.vad_task is not None and not self.vad_task.done():
            logger.warning(f"⚠️ VAD 任务已在运行，客户端: {self.client_id}")
            return
            
        async def vad_loop():
            logger.info(f"🔄 VAD 处理循环开始，客户端: {self.client_id}")
            last_vad_run = time.time()
            
            while self.is_active:
                try:
                    current_time = time.time()
                    elapsed = current_time - last_vad_run
                    
                    # 确保VAD处理不会过于频繁
                    if elapsed < AppConfig.VAD_PROCESSING_INTERVAL_MS / 1000.0:
                        await asyncio.sleep((AppConfig.VAD_PROCESSING_INTERVAL_MS / 1000.0) - elapsed)
                    
                    last_vad_run = time.time()
                    
                    # 处理VAD
                    state_changed, speech_start_id, speech_end_id = await self.vad_processor.process_vad()
                    
                    user_speaking = self.vad_processor.is_speaking_state()

                    if user_speaking:
                        logger.debug(f"🎙️ VAD 状态: 语音活动, 客户端: {self.client_id}")
                    
                    if state_changed:
                        # 语音开始
                        if speech_start_id is not None and user_speaking:
                            segment = self.buffer_manager.create_speech_segment(
                                speech_start_id, 
                                self.buffer_manager.chunk_buffer[speech_start_id].timestamp
                            )
                            logger.info(f"🎤 语音段开始，ID: {speech_start_id}, 客户端: {self.client_id}")
                        
                        # 语音结束
                        if speech_end_id is not None and not user_speaking:
                            segment = self.buffer_manager.finalize_current_segment(
                                speech_end_id,
                                self.buffer_manager.chunk_buffer[speech_end_id].timestamp
                            )
                            logger.info(f"🎤 语音段结束，ID: {speech_end_id}, 客户端: {self.client_id}")
                            if segment:
                                self.saved_temporary_transcription_text = ""
                                await self.process_committed_transcription(segment)
                    
                    # 定期处理临时转录
                    current_time = time.time()
                    if (user_speaking and 
                        current_time - self.last_temporary_transcription_time >= 1.0):
                        await self.process_temporary_transcription()
                        self.last_temporary_transcription_time = current_time
                    
                    # 小睡以让出事件循环
                    await asyncio.sleep(0.01)
                    
                except asyncio.CancelledError:
                    logger.info(f"⏹️ VAD 处理循环被取消，客户端: {self.client_id}")
                    break
                except Exception as e:
                    logger.error(f"❌ VAD处理循环错误: {str(e)}\n{traceback.format_exc()}, 客户端: {self.client_id}")
                    # 出错后休息更长时间
                    await asyncio.sleep(1.0)
        
        self.vad_task = asyncio.create_task(vad_loop())
        logger.info(f"✅ VAD 处理任务已创建，客户端: {self.client_id}")
    
    async def process_audio_chunk(self, audio_data: bytes, debug_audio: Optional[DebugAudioManager] = None):
        """处理单个音频片段"""
        try:
            if debug_audio:
                debug_audio.write(audio_data)
            
            # 添加到缓冲区
            chunk = self.buffer_manager.add_audio_chunk(audio_data)
            self.last_chunk_id = chunk.chunk_id
            self.last_activity = time.time()
            
            # 调试：记录处理状态
            if chunk.chunk_id % 5 == 0:  # 每5个片段记录一次
                logger.debug(f"📊 音频片段 {chunk.chunk_id} 已处理, 缓冲区大小: {len(self.buffer_manager.chunk_buffer)}, 客户端: {self.client_id}")
        
        except Exception as e:
            logger.error(f"❌ 处理音频片段失败: {str(e)}\n{traceback.format_exc()}, 客户端: {self.client_id}")
            raise
    
    async def process_temporary_transcription(self):
        """处理临时转录"""
        if not self.vad_processor.is_speaking_state() or not self.buffer_manager.current_segment:
            return
        
        try:
            # 获取当前语音段的最新片段
            chunks = self.buffer_manager.get_temporary_transcription_chunks()
            if not chunks:
                return
            
            # 合并音频数据
            audio_data = b''.join(chunk.audio_data for chunk in chunks)
            
            # 执行临时转录
            transcript = await self.transcription_manager.transcribe_temporary(audio_data)
            if not transcript:
                return
            
            self.saved_temporary_transcription_text += transcript

            # 发送临时结果
            current_time = time.time()
            await self.send_json({
                "type": "tentative_output",
                "current_text": transcript,
                "text": self.saved_temporary_transcription_text,
                "start_chunk_id": chunks[0].chunk_id,
                "end_chunk_id": chunks[-1].chunk_id,
                "duration": len(chunks) * AppConfig.AUDIO_CHUNK_DURATION_MS / 1000.0,
                "timestamp": current_time,
                "client_id": self.client_id,
                "confidence": "tentative",
                "processing_delay": current_time - chunks[-1].timestamp
            })
            
            logger.debug(f"⚡ 临时转录: '{transcript[:50]}...', 片段: {chunks[0].chunk_id}-{chunks[-1].chunk_id}")
            
        except Exception as e:
            logger.error(f"❌ 临时转录处理失败: {str(e)}\n{traceback.format_exc()}")
    
    
    async def process_committed_transcription(self, segment: SpeechSegment):
        """处理确认转录：支持超长音频自动分段转录"""
        try:
            audio_data = self.buffer_manager.get_committed_audio_data(segment)
            print(f"audio_data len ： {len(audio_data)}")
            
            if len(audio_data) < AppConfig.AUDIO_CHUNK_SIZE * 2:  # 至少200ms
                logger.warning(f"⚠️ 音频段太短 ({len(audio_data)} bytes)，跳过确认转录")
                return

            sample_rate = AppConfig.AUDIO_SAMPLE_RATE
            bytes_per_sec = sample_rate * 2
            max_duration = AppConfig.MAX_SEGMENT_DURATION
            max_bytes = int(max_duration * bytes_per_sec)

            # 计算实际音频时长（用于校验）
            actual_duration = len(audio_data) / bytes_per_sec
            segment_duration = min(actual_duration, segment.duration)  # 以防 metadata 不准

            # 如果未超限，走原逻辑
            if segment_duration <= max_duration:
                transcript = await self.transcription_manager.transcribe_committed(audio_data, segment_duration)
                if not transcript:
                    logger.warning("⚠️ 确认转录结果为空")
                    return
                segment.transcript = transcript
                await self._send_committed_result(
                    transcript=transcript,
                    segment=segment,
                    audio_length=len(audio_data),
                    duration=segment_duration
                )
                logger.info(f"✅ 确认转录成功: '{transcript[:100]}...', 时长: {segment_duration:.2f}s")
                return

            # === 超长处理：分段 ===
            logger.info(f"✂️ 音频段过长 ({segment_duration:.2f}s)，拆分为多个子段（每段≤{max_duration}s）")
            num_subsegments = math.ceil(len(audio_data) / max_bytes)
            sub_results: List[Tuple[str, float, float]] = []  # (text, start, end)

            for i in range(num_subsegments):
                start_byte = i * max_bytes
                end_byte = min(start_byte + max_bytes, len(audio_data))
                sub_audio = audio_data[start_byte:end_byte]
                sub_duration = len(sub_audio) / bytes_per_sec

                # 计算子段的时间戳（基于原始 segment 的 start_time）
                sub_start_time = segment.start_time + i * max_duration
                sub_end_time = sub_start_time + sub_duration

                # 转录子段
                transcript = await self.transcription_manager.transcribe_committed(sub_audio, sub_duration)
                if not transcript:
                    logger.warning(f"⚠️ 子段 {i+1}/{num_subsegments} 转录结果为空")
                    # 仍继续处理其他片段，不中断
                    continue

                # 发送子段结果
                await self._send_committed_result(
                    transcript=transcript,
                    segment=segment,
                    audio_length=len(sub_audio),
                    duration=sub_duration,
                    custom_start_time=sub_start_time,
                    custom_end_time=sub_end_time,
                    suffix=f"_part_{i+1}"
                )
                sub_results.append((transcript, sub_start_time, sub_end_time))

            # 可选：拼接完整文本并更新 segment（如果需要）
            full_transcript = " ".join(t for t, _, _ in sub_results)
            segment.transcript = full_transcript

            logger.info(f"✅ 超长音频分段转录完成 ({len(sub_results)} 段)，总文本: '{full_transcript[:100]}...'")

        except Exception as e:
            logger.error(f"❌ 确认转录处理失败: {str(e)}\n{traceback.format_exc()}")

    async def _send_committed_result(
        self,
        transcript: str,
        segment: SpeechSegment,
        audio_length: int,
        duration: float,
        custom_start_time: float = None,
        custom_end_time: float = None,
        suffix: str = ""
    ):
        """复用发送逻辑"""
        start_time = custom_start_time if custom_start_time is not None else segment.start_time
        end_time = custom_end_time if custom_end_time is not None else segment.end_time
        seg_id = f"{id(segment)}{suffix}" if suffix else id(segment)

        current_time = time.time()
        await self.send_json({
            "type": "committed_output",
            "text": transcript,
            "segment_id": seg_id,
            "start_chunk_id": segment.start_chunk_id,
            "end_chunk_id": segment.end_chunk_id,
            "start_time": start_time,
            "end_time": end_time,
            "duration": duration,
            "timestamp": current_time,
            "client_id": self.client_id,
            "confidence": "high",
            "audio_length": audio_length
        })
    
    async def send_json(self, data: dict):
        """安全发送JSON消息"""
        try:
            if self.websocket.client_state != WebSocketState.DISCONNECTED:
                await self.websocket.send_json(data)
        except Exception as e:
            logger.warning(f"⚠️ 消息发送失败 (客户端: {self.client_id}): {str(e)}")
            self.is_active = False
    
    def cleanup(self):
        """清理资源"""
        self.is_active = False
        
        # 取消VAD任务
        if self.vad_task:
            try:
                self.vad_task.cancel()
            except:
                pass
        
        # 清理缓冲区
        self.buffer_manager.cleanup()
        
        logger.info(f"🧹 连接管理器清理完成，客户端: {self.client_id}")

