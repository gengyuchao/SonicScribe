import os
import time
from contextlib import asynccontextmanager
from typing import Optional, Dict, Any, AsyncGenerator, List, Tuple, Deque
import asyncio
import json
import logging
import traceback
import wave
import torch
import numpy as np
from collections import deque
import uvicorn
from fastapi import FastAPI, UploadFile, File, WebSocket, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from asr import ASRModel
from vad import VADProcessor
from vad_processor_manager import VADProcessorManager
from config import AppConfig
from debug import DebugAudioManager
from connection_manager import ConnectionManager, SpeechSegment, AudioChunk, AudioBufferManager
from utils import convert_audio_to_wav, audiosegment_to_tensor, standardize_audio_tensor
from dotenv import load_dotenv
from models_manager import asr_model_init, vad_model_init, asr_model_get, vad_model_get
from starlette.websockets import WebSocketDisconnect, WebSocketState

# 配置日志
logging.basicConfig(
    level=getattr(logging, AppConfig.LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("speech-to-text")


# ======================
# 生命周期管理
# ======================
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """应用生命周期管理"""
    logger.info("🚀 应用启动中...")
    # 初始化调试目录
    _init_debug_directory()
    # 初始化模型
    await _init_models()
    yield
    # 清理资源
    await _cleanup_resources()

async def _init_models():
    """初始化ASR和VAD模型"""
    global asr_model, vad_processor
    try:
        logger.info("🔊 加载 VAD 处理器...")
        vad_model_init()
        vad_processor = vad_model_get()
        logger.info("✅ VAD 处理器加载成功")
        logger.info(f"🧠 加载 ASR 模型，路径: {AppConfig.CHECKPOINT_PATH}, 设备: {AppConfig.DEVICE}")
        asr_model_init()
        asr_model = asr_model_get()
        logger.info("✅ ASR 模型加载成功")
    except Exception as e:
        logger.error(f"❌ 模型加载失败: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=503, detail="模型加载失败")

def _init_debug_directory():
    """初始化调试音频目录"""
    if AppConfig.DEBUG_AUDIO_ENABLED:
        os.makedirs(AppConfig.DEBUG_AUDIO_BASE_DIR, exist_ok=True)
        logger.info(f"📁 调试音频已启用，存储目录: {AppConfig.DEBUG_AUDIO_BASE_DIR}")

async def _cleanup_resources():
    """清理资源"""
    logger.info("🧹 应用关闭，清理资源...")
    global asr_model, vad_processor
    if asr_model and hasattr(asr_model, 'model'):
        logger.info("🗑️ 释放 ASR 模型内存...")
        del asr_model.model
        torch.cuda.empty_cache()
        asr_model = None
    vad_processor = None
    logger.info("✅ 资源清理完成")

# ======================
# 应用初始化
# ======================
app = FastAPI(
    title="语音转文字API",
    description="基于FastAPI的语音转文字服务，支持实时对话和文件分析",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    contact={
        "name": "技术支持",
        "email": "gengyuchao11@163.com"
    }
)

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.get("/vad/status")
async def get_vad_status():
    """获取VAD处理器状态，用于调试"""
    global vad_processor
    
    if not vad_processor:
        return {"status": "error", "message": "VAD处理器未初始化"}
    
    status = {
        "status": "active",
        "processor_type": type(vad_processor).__name__,
        "has_is_voice_active": hasattr(vad_processor, 'is_voice_active'),
        "configuration": {
            "speech_threshold": AppConfig.VAD_SPEECH_THRESHOLD,
            "smoothing_window": AppConfig.VAD_SMOOTHING_WINDOW,
        }
    }
    
    # 尝试测试VAD处理器
    try:
        test_audio = torch.randn(1600) * 0.01  # 小幅随机噪声
        is_speech = vad_processor.is_voice_active(test_audio)
        status["test_is_speech"] = bool(is_speech)
    except Exception as e:
        status["test_error"] = str(e)
    
    return status


# ======================
# API 端点
# ======================
class VADConfig(BaseModel):
    enabled: bool = True
    speech_threshold: float = 0.6
    silence_threshold: float = 0.3
    smoothing_window: int = 2

@app.get("/health")
async def health_check():
    """健康检查接口"""
    return {
        "status": "ok",
        "service": "speech-to-text",
        "version": "2.0.0",
        "timestamp": time.time(),
        "models": {
            "asr_loaded": asr_model is not None,
            "vad_loaded": vad_processor is not None
        },
        "configuration": {
            "audio_chunk_duration_ms": AppConfig.AUDIO_CHUNK_DURATION_MS,
            "vad_smoothing_window": AppConfig.VAD_SMOOTHING_WINDOW,
            "max_audio_buffer_seconds": AppConfig.MAX_AUDIO_BUFFER_SECONDS,
            "temporary_transcription_interval": AppConfig.TEMPORARY_TRANSCRIPTION_INTERVAL
        }
    }

@app.get("/debug/config")
async def get_config():
    """获取当前配置信息"""
    return {
        "api_base_url": f"http://{AppConfig.HOST}:{AppConfig.PORT}",
        "websocket_url": f"ws://{AppConfig.HOST}:{AppConfig.PORT}/ws/audio",
        "audio_processing": {
            "chunk_duration_ms": AppConfig.AUDIO_CHUNK_DURATION_MS,
            "chunk_size_bytes": AppConfig.AUDIO_CHUNK_SIZE,
            "max_buffer_seconds": AppConfig.MAX_AUDIO_BUFFER_SECONDS
        },
        "vad_configuration": {
            "smoothing_window": AppConfig.VAD_SMOOTHING_WINDOW,
            "speech_threshold": AppConfig.VAD_SPEECH_THRESHOLD,
            "processing_interval_ms": AppConfig.VAD_PROCESSING_INTERVAL_MS
        },
        "transcription_configuration": {
            "temporary_interval_chunks": AppConfig.TEMPORARY_TRANSCRIPTION_INTERVAL,
            "max_segment_duration": AppConfig.MAX_SEGMENT_DURATION,
        }
    }


@app.post("/transcribe/file")
async def transcribe_file(
    file: UploadFile = File(...),
    stream: bool = True,
    vad_enabled: bool = True
):
    """
    优化版文件转文字接口（性能提升）
    """
    if not asr_model or not vad_processor:
        logger.error("ASR 或 VAD 模型未加载")
        raise HTTPException(status_code=503, detail="模型未加载")

    try:
        logger.info(f"📁 处理文件上传: {file.filename}, 大小: {file.size} bytes")
        file_content = await file.read()
        logger.info("🔄 转换音频格式...")
        
        # 从内存直接处理，避免临时文件 I/O
        start_time = time.time()
        
        # === 优化1: 直接从内存加载音频（避免文件 I/O）===
        logger.info("⚡ 从内存加载音频...")
        
        # 先获取完整音频用于 VAD 和分段
        try:
            # 使用内存中的音频数据
            audio = convert_audio_to_wav(file_content, file.filename)
            full_audio_tensor = audiosegment_to_tensor(audio)
            full_audio_tensor = standardize_audio_tensor(full_audio_tensor)
            
            # 确保是 1D 张量
            if full_audio_tensor.ndim > 1:
                full_audio_tensor = full_audio_tensor.squeeze()
            
            total_samples = full_audio_tensor.shape[0]
            sample_rate = AppConfig.AUDIO_SAMPLE_RATE
            total_duration = total_samples / sample_rate
            
            logger.info(f"🎵 音频信息 - 时长: {total_duration:.2f}秒, 样本数: {total_samples}, 采样率: {sample_rate}Hz")
            logger.info(f"⚡ 音频加载耗时: {time.time() - start_time:.2f}s")
            
        except Exception as e:
            logger.error(f"❌ 音频加载失败: {str(e)}")
            raise HTTPException(status_code=500, detail=f"音频加载失败: {str(e)}")
        
        # === 优化2: 异步 VAD 处理 + 快速响应 ===
        async def get_segments():
            """异步获取语音段，尽快返回段信息"""
            if not vad_enabled or total_duration < 1.0:  # 短音频不 VAD
                logger.info("⚡ 短音频或 VAD 禁用，使用整个音频")
                return [{
                    'original_index': 1,
                    'start_sample': 0,
                    'end_sample': total_samples,
                    'start_time': 0.0,
                    'end_time': total_duration,
                    'duration': total_duration,
                    'is_long_segment': total_duration > AppConfig.MAX_SEGMENT_DURATION
                }]
            
            try:
                logger.info("⚡ 异步 VAD 检测中...")
                vad_start_time = time.time()
                
                # 在后台线程执行 CPU 密集型 VAD 操作
                loop = asyncio.get_event_loop()
                speech_timestamps, has_speech = await loop.run_in_executor(
                    None, 
                    lambda: vad_processor.detect_voice_activity(
                        full_audio_tensor.unsqueeze(0),  # 确保维度正确
                        threshold=AppConfig.VAD_SPEECH_THRESHOLD
                    )
                )
                
                vad_time = time.time() - vad_start_time
                logger.info(f"⚡ VAD 检测完成，耗时: {vad_time:.2f}s")
                
                if has_speech and speech_timestamps:
                    segments = []
                    for idx, ts in enumerate(speech_timestamps):
                        start_sample = max(0, min(ts['start'], total_samples - 1))
                        end_sample = max(start_sample + 100, min(ts['end'], total_samples))
                        duration = (end_sample - start_sample) / sample_rate
                        
                        if duration > 0.1:  # 跳过过短段
                            segments.append({
                                'original_index': idx + 1,
                                'start_sample': start_sample,
                                'end_sample': end_sample,
                                'start_time': start_sample / sample_rate,
                                'end_time': end_sample / sample_rate,
                                'duration': duration,
                                'is_long_segment': duration > AppConfig.MAX_SEGMENT_DURATION
                            })
                    
                    if segments:
                        logger.info(f"✅ 检测到 {len(segments)} 个有效语音段")
                        return segments
                
                logger.warning("🔇 VAD 未检测到有效语音，使用整个音频")
                return [{
                    'original_index': 1,
                    'start_sample': 0,
                    'end_sample': total_samples,
                    'start_time': 0.0,
                    'end_time': total_duration,
                    'duration': total_duration,
                    'is_long_segment': total_duration > AppConfig.MAX_SEGMENT_DURATION
                }]
                
            except Exception as e:
                logger.error(f"❌ VAD 处理失败: {str(e)}\n{traceback.format_exc()}")
                logger.warning("🔇 VAD 失败，回退到整个音频")
                return [{
                    'original_index': 1,
                    'start_sample': 0,
                    'end_sample': total_samples,
                    'start_time': 0.0,
                    'end_time': total_duration,
                    'duration': total_duration,
                    'is_long_segment': total_duration > AppConfig.MAX_SEGMENT_DURATION
                }]
        
        # === 优化3: 尽快返回段信息，后台处理转录 ===
        raw_segments = await get_segments()
        
        # 切割长段
        final_segments = cut_long_segments(raw_segments, sample_rate, total_samples, total_duration)
        
        # 为所有段分配唯一索引
        for i, segment in enumerate(final_segments):
            segment['segment_index'] = i + 1
        
        total_segments = len(final_segments)
        logger.info(f"🎯 最终处理 {total_segments} 个语音段")
        
        # === 优化4: 立即返回段信息，转录在后台进行 ===
        async def transcribe_generator():
            """生成器：快速返回段信息，后台异步转录"""
            
            # 立即发送初始化信息
            init_message = {
                "type": "initialization",
                "filename": file.filename,
                "file_size": len(file_content),
                "total_duration": round(total_duration, 2),
                "total_segments": total_segments,
                "vad_enabled": vad_enabled,
                "max_segment_duration": AppConfig.MAX_SEGMENT_DURATION,
                "timestamp": time.time()
            }
            yield (json.dumps(init_message, ensure_ascii=False) + "\n").encode("utf-8")
            
            # 立即发送段摘要（不等待转录）
            segments_summary = get_segments_summary(final_segments, sample_rate)
            
            summary_message = {
                "type": "segments_summary",
                "segments": segments_summary,
                "total_segments": total_segments,
                "timestamp": time.time()
            }
            yield (json.dumps(summary_message, ensure_ascii=False) + "\n").encode("utf-8")
            
            # 异步转录任务队列
            transcription_tasks = []
            successful_segments = 0
            failed_segments = 0
            
            # 创建转录任务（不立即执行）
            for segment in final_segments:
                task = {
                    'segment': segment,
                    'future': None
                }
                transcription_tasks.append(task)
            
            # 使用信号量控制并发
            MAX_CONCURRENT_TRANSCRIPTIONS = 3  # 根据 GPU 能力调整
            semaphore = asyncio.Semaphore(MAX_CONCURRENT_TRANSCRIPTIONS)
            
            async def transcribe_segment(task):
                async with semaphore:
                    segment = task['segment']
                    return await transcribe_single_segment(
                        segment, full_audio_tensor, sample_rate
                    )
            
            # 启动所有转录任务
            for task in transcription_tasks:
                task['future'] = asyncio.create_task(transcribe_segment(task))
            
            # 按顺序收集结果（显示更有序）
            for task in transcription_tasks:
                try:
                    result = await task['future']
                    if result.get('type') == 'segment_result':
                        successful_segments += 1
                    else:
                        failed_segments += 1
                    
                    # 发送进度更新
                    progress = round((successful_segments + failed_segments) / total_segments * 100, 1)
                    result['progress'] = progress
                    
                    yield (json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8")
                    
                    # 小延迟，避免前端过载
                    if total_segments > 5:
                        await asyncio.sleep(0.01)
                    
                except Exception as e:
                    logger.error(f"❌ 段转录任务失败: {str(e)}")
                    failed_segments += 1
            
            # 发送最终汇总
            final_summary = {
                "type": "final_summary",
                "total_segments": total_segments,
                "successful_segments": successful_segments,
                "failed_segments": failed_segments,
                "total_duration": round(total_duration, 2),
                "processing_time": round(time.time() - start_time, 2),
                "completed_at": time.time(),
                "message": "转录完成"
            }
            yield (json.dumps(final_summary, ensure_ascii=False) + "\n").encode("utf-8")
        
        if stream:
            logger.info("⚡ 启用流式响应，立即返回段信息")
            return StreamingResponse(
                transcribe_generator(),
                media_type="application/x-ndjson",
                headers={
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive"
                }
            )
        else:
            # 非流式处理（保持兼容）
            results = []
            async for chunk in transcribe_generator():
                results.append(json.loads(chunk.decode("utf-8").strip()))
            
            segments_result = [r for r in results if r.get("type") == "segment_result"]
            return {
                "status": "completed",
                "filename": file.filename,
                "file_size": len(file_content),
                "total_duration": round(total_duration, 2),
                "segments": segments_result,
                "total_segments": len(segments_result),
                "processing_time": round(time.time() - start_time, 2)
            }
    
    except Exception as e:
        logger.error(f"❌ 文件转录失败: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))

# === 辅助方法（提取到类外部或保持为局部函数）===

def cut_long_segments(raw_segments, sample_rate, total_samples, total_duration):
    """切割长音频段"""
    final_segments = []
    
    for raw_segment in raw_segments:
        duration = raw_segment['duration']
        start_sample = raw_segment['start_sample']
        end_sample = raw_segment['end_sample']
        
        if duration <= AppConfig.MAX_SEGMENT_DURATION:
            final_segments.append({
                **raw_segment,
                'is_long_segment': False,
                'sub_segment_count': 1,
                'sub_segment_index': 1
            })
        else:
            # 长段切割
            num_sub_segments = int(np.ceil(duration / AppConfig.MAX_SEGMENT_DURATION))
            samples_per_sub_segment = int(AppConfig.MAX_SEGMENT_DURATION * sample_rate)
            
            for sub_idx in range(num_sub_segments):
                sub_start_sample = start_sample + sub_idx * samples_per_sub_segment
                sub_end_sample = min(start_sample + (sub_idx + 1) * samples_per_sub_segment, end_sample, total_samples)
                sub_duration = (sub_end_sample - sub_start_sample) / sample_rate
                
                if sub_duration > 0.1:  # 跳过过短段
                    final_segments.append({
                        **raw_segment,
                        'start_sample': sub_start_sample,
                        'end_sample': sub_end_sample,
                        'start_time': sub_start_sample / sample_rate,
                        'end_time': sub_end_sample / sample_rate,
                        'duration': sub_duration,
                        'is_long_segment': True,
                        'sub_segment_count': num_sub_segments,
                        'sub_segment_index': sub_idx + 1,
                        'original_duration': duration
                    })
    
    return final_segments

def get_segments_summary(segments, sample_rate):
    """获取段摘要信息"""
    return [
        {
            "segment_index": seg['segment_index'],
            "original_index": seg['original_index'],
            "start_time": round(seg['start_time'], 3),
            "end_time": round(seg['end_time'], 3),
            "duration": round(seg['duration'], 3),
            "is_long_segment": seg['is_long_segment'],
            "sub_segment_count": seg.get('sub_segment_count', 1),
            "sub_segment_index": seg.get('sub_segment_index', 1)
        }
        for seg in segments
    ]

async def transcribe_single_segment(segment, full_audio_tensor, sample_rate):
    """转录单个段（异步）"""
    segment_index = segment['segment_index']
    start_sample = segment['start_sample']
    end_sample = segment['end_sample']
    start_time = segment['start_time']
    end_time = segment['end_time']
    duration = segment['duration']
    is_long_segment = segment['is_long_segment']
    
    try:
        # 从完整音频中提取段
        segment_samples = full_audio_tensor[start_sample:end_sample]
        
        # 确保有足够的样本
        if len(segment_samples) < int(0.1 * sample_rate):  # 100ms
            raise ValueError(f"段 {segment_index} 样本过少: {len(segment_samples)}")
        
        # 直接使用张量（避免临时文件）
        segment_tensor = segment_samples.clone()
        if segment_tensor.ndim == 1:
            segment_tensor = segment_tensor.unsqueeze(0)  # 转为 [1, samples]
        
        # 转录（CPU 密集型操作在后台线程）
        loop = asyncio.get_event_loop()
        transcript = await loop.run_in_executor(
            None,
            lambda: asr_model.transcribe(segment_tensor, sampling_rate=sample_rate)
        )

        return {
            "type": "segment_result",
            "segment_index": segment_index,
            "original_index": segment['original_index'],
            "start_time": round(start_time, 3),
            "end_time": round(end_time, 3),
            "duration": round(duration, 3),
            "text": transcript.strip(),
            "processing_time": 0,  # 真实时间在外部计算
            "is_long_segment": is_long_segment,
            "timestamp": time.time()
        }
        
    except Exception as e:
        logger.error(f"❌ 段 {segment_index} 转录失败: {str(e)}")
        return {
            "type": "segment_error",
            "segment_index": segment_index,
            "original_index": segment['original_index'],
            "error": str(e),
            "is_long_segment": is_long_segment,
            "timestamp": time.time()
        }

@app.post("/vad/config")
async def update_vad_config(config: VADConfig):
    """更新VAD配置"""
    try:
        logger.info(f"⚙️ 更新 VAD 配置: {config}")
        
        # 更新全局配置
        AppConfig.VAD_SPEECH_THRESHOLD = config.speech_threshold
        AppConfig.VAD_SMOOTHING_WINDOW = config.smoothing_window
        
        return {
            "status": "success",
            "config": config.model_dump(),
            "message": "VAD 配置更新成功"
        }
    except Exception as e:
        logger.error(f"❌ VAD 配置更新失败: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))

# ======================
# WebSocket 处理 
# ======================
active_connections: Dict[str, ConnectionManager] = {}

def cleanup_client_resources(client_id: str):
    """清理客户端相关资源"""
    if client_id in active_connections:
        manager = active_connections[client_id]
        try:
            manager.cleanup()
            logger.info(f"✅ 客户端资源已清理: {client_id}")
        except Exception as e:
            logger.error(f"❌ 清理客户端资源失败 (客户端: {client_id}): {str(e)}")
        finally:
            del active_connections[client_id]

def log_audio_metrics(audio_data: bytes, chunk_id: int, client_id: str):
    """记录音频数据指标用于调试"""
    if len(audio_data) == 0:
        logger.warning(f"🎤 客户端 {client_id} 音频数据为空 (chunk_id: {chunk_id})")
        return
        
    # 计算音量RMS
    audio_array = np.frombuffer(audio_data, dtype=np.int16)
    if len(audio_array) > 0:
        rms = np.sqrt(np.mean(np.square(audio_array.astype(np.float32))))
        peak = np.max(np.abs(audio_array))
        logger.debug(f"🎤 客户端 {client_id} 音频指标 - Chunk {chunk_id}: "
                    f"大小={len(audio_data)}字节, RMS={rms:.2f}, 峰值={peak}")

@app.websocket("/ws/audio")
async def websocket_audio(websocket: WebSocket):
    """WebSocket 实时音频处理端点"""
    client_id = f"client_{int(time.time())}_{id(websocket)}"
    logger.info(f"🔌 新的 WebSocket 连接请求: {client_id}，来源: {websocket.client}")
    session_time = time.strftime("%Y%m%d_%H%M%S")
    debug_audio = None
    manager = None
    
    try:
        # 验证来源
        origin = websocket.headers.get('origin', '')
        logger.info(f"🌐 连接来源: {origin}")
        
        # 接受连接
        await websocket.accept()
        logger.info(f"✅ WebSocket 连接已建立: {client_id}")
        
        # 创建连接管理器
        manager = ConnectionManager(websocket, client_id)
        active_connections[client_id] = manager
        
        # 发送连接确认
        await manager.send_json({
            "type": "connection_established",
            "client_id": client_id,
            "server_time": time.time(),
            "message": "WebSocket 连接成功",
            "features": {
                "tiered_output": True,
                "low_latency": True,
                "vad_separation": True,
                "chunk_based_processing": True,
                "debug_audio": AppConfig.DEBUG_AUDIO_ENABLED
            },
            "configuration": {
                "audio_chunk_duration_ms": AppConfig.AUDIO_CHUNK_DURATION_MS,
                "vad_smoothing_window": AppConfig.VAD_SMOOTHING_WINDOW,
                "temporary_transcription_interval": AppConfig.TEMPORARY_TRANSCRIPTION_INTERVAL,
                "max_segment_duration": AppConfig.MAX_SEGMENT_DURATION
            }
        })
        
        # 检查模型状态
        if not asr_model or not vad_processor:
            error_msg = "模型未加载，无法处理音频"
            logger.error(f"❌ {error_msg}: {client_id}")
            await manager.send_json({
                "type": "error",
                "code": 503,
                "message": error_msg
            })
            return
        
        # 初始化调试音频
        if AppConfig.DEBUG_AUDIO_ENABLED:
            debug_audio = DebugAudioManager(client_id, session_time).__enter__()
            if debug_audio:
                await manager.send_json({
                    "type": "debug_audio_info",
                    "enabled": True,
                    "session_id": session_time,
                    "file_path": debug_audio.audio_path,
                    "message": "音频数据将被存档用于调试"
                })
        
        # 启动VAD处理任务
        await manager.start_vad_processing()
        logger.info(f"🚀 VAD 处理任务已启动，客户端: {client_id}")
        
        # 主音频接收循环
        while manager.is_active:
            try:
                # 检查连接状态
                if websocket.client_state == WebSocketState.DISCONNECTED:
                    logger.warning(f"🔌 客户端已断开连接，停止处理: {client_id}")
                    break
                
                # 接收数据（带超时）
                try:
                    # 正确处理WebSocket接收的数据格式
                    message = await asyncio.wait_for(websocket.receive(), timeout=5.0)
                    manager.last_activity = time.time()
                    
                    # 记录收到的消息类型
                    if 'type' in message and message['type'] == 'websocket.disconnect':
                        logger.info(f"🔌 客户端主动断开连接，代码: {message.get('code', 'unknown')}")
                        break
                    
                except asyncio.TimeoutError:
                    # 检查长时间无活动
                    if time.time() - manager.last_activity > 30.0:
                        logger.warning(f"⏰ 连接超时无活动，客户端: {client_id}")
                        await manager.send_json({
                            "type": "error",
                            "code": 408,
                            "message": "连接超时，30秒内无活动",
                            "client_id": client_id
                        })
                        break
                    continue
                
                # 处理二进制音频数据 
                if 'bytes' in message and message['bytes'] is not None:
                    audio_data = message['bytes']
                    logger.debug(f"🎧 收到音频数据: {len(audio_data)} 字节，客户端: {client_id}")
                    
                    # 验证音频数据
                    if len(audio_data) == 0:
                        logger.warning(f"⚠️ 空音频数据，客户端: {client_id}")
                        continue
                    
                    # 检查音频数据大小
                    expected_size = AppConfig.AUDIO_CHUNK_SIZE
                    if len(audio_data) != expected_size:
                        logger.warning(f"⚠️ 音频数据大小不匹配，预期: {expected_size}, 实际: {len(audio_data)}，客户端: {client_id}")
                        
                        # 尝试重新同步或处理不匹配的数据
                        if len(audio_data) < expected_size:
                            # 填充小数据
                            logger.info(f"🔧 填充小音频数据: {len(audio_data)} -> {expected_size} 字节")
                            padded_data = bytearray(audio_data)
                            padded_data.extend(b'\x00' * (expected_size - len(audio_data)))
                            audio_data = bytes(padded_data)
                        elif len(audio_data) > expected_size:
                            # 处理大数据 - 可能是多个片段
                            logger.info(f"🔧 处理大数据块: {len(audio_data)} 字节，可能包含 {len(audio_data) // expected_size + 1} 个片段")
                            
                            # 处理完整的片段
                            for i in range(0, len(audio_data) - expected_size + 1, expected_size):
                                chunk = audio_data[i:i+expected_size]
                                if len(chunk) == expected_size:
                                    await manager.process_audio_chunk(chunk, debug_audio)
                                    log_audio_metrics(chunk, manager.last_chunk_id, client_id)
                            
                            # 剩余数据不足一个片段
                            remaining = len(audio_data) % expected_size
                            if remaining > 0:
                                logger.info(f"🔧 剩余 {remaining} 字节，等待下一批数据完成片段")
                            continue
                    
                    # 处理单个音频片段
                    await manager.process_audio_chunk(audio_data, debug_audio)
                    log_audio_metrics(audio_data, manager.last_chunk_id, client_id)
                
                # 处理文本控制消息
                elif 'text' in message and message['text'] is not None:
                    try:
                        # 正确解析文本消息
                        text_data = message['text']
                        msg_data = json.loads(text_data)
                        msg_type = msg_data.get('type', 'unknown')
                        logger.debug(f"⚙️ 收到控制消息: {msg_type}, 客户端: {client_id}")
                        
                        if msg_type == 'close':
                            logger.info(f"👋 客户端请求关闭连接, 客户端: {client_id}")
                            break
                            
                        elif msg_type == 'ping':
                            await manager.send_json({
                                "type": "pong",
                                "timestamp": time.time(),
                                "client_id": client_id
                            })
                            logger.debug(f"🏓 已回应 ping，客户端: {client_id}")
                            
                        elif msg_type == 'get_state':
                            state = {
                                "type": "connection_state",
                                "client_id": client_id,
                                "buffer_size": len(manager.buffer_manager.chunk_buffer),
                                "active_segment": manager.buffer_manager.current_segment is not None,
                                "vad_state": manager.vad_processor.is_speaking_state(),
                                "last_chunk_id": manager.last_chunk_id,
                                "timestamp": time.time(),
                                "audio_config": {
                                    "chunk_duration_ms": AppConfig.AUDIO_CHUNK_DURATION_MS,
                                    "sample_rate": AppConfig.AUDIO_SAMPLE_RATE,
                                    "bytes_per_sample": 2
                                }
                            }
                            await manager.send_json(state)
                            logger.debug(f"📊 已发送连接状态，客户端: {client_id}")
                            
                        elif msg_type == 'vad_config':
                            config = msg_data.get('config', {})
                            logger.info(f"🔧 收到 VAD 配置更新请求: {config}, 客户端: {client_id}")
                            # 转发到VAD配置端点
                            vad_config = VADConfig(**config)
                            response = await update_vad_config(vad_config)
                            await manager.send_json({
                                "type": "config_updated",
                                "timestamp": time.time(),
                                "client_id": client_id,
                                "config": config
                            })
                            
                        else:
                            logger.warning(f"❓ 未知消息类型: {msg_type}, 客户端: {client_id}")
                            await manager.send_json({
                                "type": "error",
                                "code": 400,
                                "message": f"未知消息类型: {msg_type}",
                                "client_id": client_id
                            })
                    except json.JSONDecodeError as e:
                        logger.error(f"❌ JSON 解析失败: {str(e)}, 原始数据: {text_data}, 客户端: {client_id}")
                        await manager.send_json({
                            "type": "error",
                            "code": 400,
                            "message": f"无效的 JSON 格式: {str(e)}",
                            "client_id": client_id
                        })
                    except Exception as e:
                        logger.error(f"❌ 处理控制消息失败: {str(e)}\n{traceback.format_exc()}, 客户端: {client_id}")
                        await manager.send_json({
                            "type": "error",
                            "code": 500,
                            "message": f"处理控制消息失败: {str(e)}",
                            "client_id": client_id
                        })
                else:
                    # 记录未知消息格式
                    logger.debug(f"🔍 未知消息格式，客户端: {client_id}, 消息: {message}")
            
            except WebSocketDisconnect as e:
                logger.info(f"🔌 客户端正常断开连接 (code={e.code}), 客户端: {client_id}")
                break
            except Exception as e:
                logger.error(f"❌ WebSocket 处理错误 (客户端: {client_id}): {str(e)}\n{traceback.format_exc()}")
                await manager.send_json({
                    "type": "error",
                    "code": 500,
                    "message": f"服务器内部错误: {str(e)}",
                    "client_id": client_id
                })
    
    except Exception as e:
        logger.critical(f"❌ WebSocket 未处理异常 (客户端: {client_id}): {str(e)}\n{traceback.format_exc()}")
    finally:
        logger.info(f"🧹 最终清理客户端资源: {client_id}")
        
        # 清理连接
        if client_id in active_connections:
            cleanup_client_resources(client_id)
        
        # 清理调试音频
        if debug_audio:
            debug_audio.cleanup()
        
        # 确保连接关闭
        try:
            if websocket.client_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=1000, reason="Normal closure")
        except Exception as e:
            logger.warning(f"⚠️ 关闭连接时出错 (客户端: {client_id}): {str(e)}")

# ======================
# 应用启动
# ======================
if __name__ == "__main__":
    logger.info("🚀 启动 FastAPI 服务器...")
    logger.info(f"📍 访问地址: http{'s' if AppConfig.USE_HTTPS else ''}://{AppConfig.HOST}:{AppConfig.PORT}/docs")
    logger.info(f"📍 WebSocket 地址: ws{'s' if AppConfig.USE_HTTPS else ''}://{AppConfig.HOST}:{AppConfig.PORT}/ws/audio")
    logger.info(f"⚙️ 核心配置:")
    logger.info(f"  - 音频处理: {AppConfig.AUDIO_CHUNK_DURATION_MS}ms/片段")
    logger.info(f"  - VAD处理: {AppConfig.VAD_SMOOTHING_WINDOW}片段平滑窗口")
    logger.info(f"  - 临时转录: 每{AppConfig.TEMPORARY_TRANSCRIPTION_INTERVAL}片段(1秒)")
    logger.info(f"  - 最大缓冲区: {AppConfig.MAX_AUDIO_BUFFER_SECONDS}秒")
    logger.info(f"  - 设备: {AppConfig.DEVICE}")
    logger.info(f"🔍 调试音频: {'启用' if AppConfig.DEBUG_AUDIO_ENABLED else '禁用'}")
    logger.info("🛡️ CORS 配置: 允许所有来源")
    
    uvicorn_config = {
        "app": app,
        "host": AppConfig.HOST,
        "port": AppConfig.PORT,
        "reload": False,
        "log_level": AppConfig.LOG_LEVEL.lower(),
        "workers": 1  # WebSocket 不支持多 worker
    }
    
    if AppConfig.USE_HTTPS:
        logger.info("🔒 启用 HTTPS 模式")
        uvicorn_config.update({
            "ssl_certfile": AppConfig.SSL_CERT,
            "ssl_keyfile": AppConfig.SSL_KEY
        })
    else:
        logger.warning("⚠️  使用 HTTP 模式 (生产环境建议启用 HTTPS)")
    
    uvicorn.run(**uvicorn_config)