
import os
from config import AppConfig
from typing import Optional
import logging
import traceback
import wave

logger = logging.getLogger("speech-to-text")

# ======================
# 调试音频管理
# ======================
class DebugAudioManager:
    """调试音频文件管理器"""
    def __init__(self, client_id: str, session_time: str):
        self.client_id = client_id
        self.session_time = session_time
        self.audio_path = ""
        self.writer: Optional[wave.Wave_write] = None
        self.session_dir = ""
        
    def __enter__(self) -> Optional['DebugAudioManager']:
        """创建调试音频文件"""
        if not AppConfig.DEBUG_AUDIO_ENABLED:
            return None
        try:
            # 创建会话目录
            self.session_dir = os.path.join(
                AppConfig.DEBUG_AUDIO_BASE_DIR, 
                self.session_time
            )
            os.makedirs(self.session_dir, exist_ok=True)
            # 创建音频文件
            audio_filename = f"{self.client_id}.wav"
            self.audio_path = os.path.join(self.session_dir, audio_filename)
            self.writer = wave.open(self.audio_path, 'wb')
            self.writer.setnchannels(1)   # 单声道
            self.writer.setsampwidth(2)   # 16-bit
            self.writer.setframerate(16000)  # 16kHz
            logger.info(f"🎧 调试音频已启用，保存到: {self.audio_path}")
            return self
        except Exception as e:
            logger.error(f"❌ 初始化调试音频失败: {str(e)}\n{traceback.format_exc()}")
            self.cleanup()
            return None
            
    def write(self, audio_data: bytes):
        """写入音频数据"""
        if self.writer:
            try:
                self.writer.writeframes(audio_data)
            except Exception as e:
                logger.error(f"❌ 写入调试音频失败: {str(e)}")
    
    def cleanup(self):
        """清理调试音频资源"""
        if self.writer:
            try:
                self.writer.close()
                logger.info(f"📼 调试音频文件已关闭: {self.client_id}")
                # 检查并清理空文件/目录
                if os.path.exists(self.audio_path) and os.path.getsize(self.audio_path) == 0:
                    os.remove(self.audio_path)
                    logger.info(f"🗑️ 删除空音频文件: {self.audio_path}")
                    if os.path.exists(self.session_dir) and not os.listdir(self.session_dir):
                        os.rmdir(self.session_dir)
                        logger.info(f"🗑️ 删除空会话目录: {self.session_dir}")
            except Exception as e:
                logger.error(f"❌ 清理调试音频失败: {str(e)}")
            finally:
                self.writer = None