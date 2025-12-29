import os
from dotenv import load_dotenv

# ======================
# 配置与初始化
# ======================
load_dotenv()

class AppConfig:
    """集中管理应用配置"""
    HOST = os.getenv('HOST', '0.0.0.0')
    PORT = int(os.getenv('PORT', 8000))
    CHECKPOINT_PATH = os.getenv('CHECKPOINT_PATH', './checkpoint')
    DEVICE = os.getenv('DEVICE', 'cuda')
    LOG_LEVEL = os.getenv('LOG_LEVEL', 'debug').upper()
    DEBUG_AUDIO_ENABLED = os.getenv('DEBUG_AUDIO_ENABLED', 'false').lower() == 'true'
    DEBUG_AUDIO_BASE_DIR = os.getenv('DEBUG_AUDIO_BASE_DIR', './debug_audio')
    USE_HTTPS = os.getenv('USE_HTTPS', 'false').lower() == 'true'
    SSL_CERT = os.getenv('SSL_CERT', './cert.pem')
    SSL_KEY = os.getenv('SSL_KEY', './key.pem')
    # 音频处理配置
    AUDIO_SAMPLE_RATE = 16000  # 音频采样率，不可修改
    AUDIO_CHUNK_DURATION_MS = 64  # 64ms音频片段
    AUDIO_CHUNK_SIZE = int(AUDIO_SAMPLE_RATE * 2 * AUDIO_CHUNK_DURATION_MS / 1000)  # 16kHz, 16-bit, mono
    MAX_AUDIO_BUFFER_SECONDS = 30  # 最大音频缓冲区30秒
    MAX_AUDIO_BUFFER_BYTES = int(MAX_AUDIO_BUFFER_SECONDS * 16000 * 4)
    # VAD配置
    VAD_SMOOTHING_WINDOW = 2  # VAD平滑窗口大小
    VAD_SPEECH_THRESHOLD = 0.6  # 语音活动阈值
    VAD_PROCESS_WINDOW = 10  # 语音活动窗口大小
    
    # ====== VAD 动态阈值配置 ======
    VAD_INITIAL_THRESHOLD = 0.3    # 初始阈值
    VAD_THRESHOLD_MIN = 0.3        # 最小阈值
    VAD_THRESHOLD_MAX = 0.9        # 最大阈值
    VAD_THRESHOLD_STEP = 0.1      # 每次增加的步长
    VAD_THRESHOLD_DECAY = 0.95     # 指数衰减系数（平滑过渡）
    
    # 转录配置
    TEMPORARY_TRANSCRIPTION_INTERVAL = 20  # 每20个片段(1.28秒)进行临时转录
    MAX_SEGMENT_DURATION = 30.0  # 单个语音段最大30秒
    # 任务配置
    VAD_PROCESSING_INTERVAL_MS = AUDIO_CHUNK_DURATION_MS  # VAD处理间隔
    MAX_SPEECH_SEGMENTS = 3  # 最多同时处理3个语音段