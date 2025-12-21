export class RealTimeChat {
    constructor() {
        this.websocket = null;
        this.audioContext = null;
        this.mediaStream = null;
        this.workletNode = null;
        this.isRecording = false;
        this.vadEnabled = true;
        this.vadThreshold = 0.6;
        this.lastSpeechTime = 0;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        // 分层输出相关
        this.segments = new Map();
        this.speechSegments = new Map();
        this.currentTemporaryElement = null;
        this.lastChunkId = -1;
        // 音频配置 - 现在使用 64ms 片段 (1024 samples at 16kHz)
        this.AUDIO_CHUNK_DURATION_MS = 64; // 2^10 = 1024 samples
        this.SAMPLE_RATE = 16000;
        this.BYTES_PER_SAMPLE = 2; // 16-bit
        // 从环境变量获取配置
        this.apiBaseUrl = process.env.VUE_APP_API_BASE_URL || 'http://localhost:8000';
        this.wsBaseUrl = process.env.VUE_APP_WS_BASE_URL || 'ws://localhost:8000';
        this.wsPath = process.env.VUE_APP_WS_PATH || '/ws/audio';
        // 自动根据当前页面协议调整 WebSocket 协议
        if (window.location.protocol === 'https:') {
            this.wsBaseUrl = this.wsBaseUrl.replace('ws://', 'wss://');
            this.apiBaseUrl = this.apiBaseUrl.replace('http://', 'https://');
        } else if (window.location.protocol === 'http:') {
            this.wsBaseUrl = this.wsBaseUrl.replace('wss://', 'ws://');
            this.apiBaseUrl = this.apiBaseUrl.replace('https://', 'http://');
        }
        this.wsUrl = `${this.wsBaseUrl}${this.wsPath}`;
        console.log('🔧 RealTimeChat 配置:');
        console.log(`   当前页面协议: ${window.location.protocol}`);
        console.log(`   API Base URL: ${this.apiBaseUrl}`);
        console.log(`   WS Base URL: ${this.wsBaseUrl}`);
        console.log(`   WS Path: ${this.wsPath}`);
        console.log(`   Final WS URL: ${this.wsUrl}`);
        console.log(`   音频配置: ${this.AUDIO_CHUNK_DURATION_MS}ms/片段, ${this.SAMPLE_RATE}Hz`);
        this.initElements();
        this.initEvents();
        this.setupWebSocket();
        this.setupPingInterval();
    }
    setupPingInterval() {
        // 每30秒发送ping保持连接
        this.pingInterval = setInterval(() => {
            if (this.websocket?.readyState === WebSocket.OPEN) {
                this.sendPing();
            }
        }, 30000);
    }
    initElements() {
        this.startBtn = document.getElementById('startBtn');
        this.btnText = document.getElementById('btnText');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.connectionText = document.getElementById('connectionText');
        this.vadEnabledCheckbox = document.getElementById('vadEnabled');
        this.vadThresholdSlider = document.getElementById('vadThreshold');
        this.thresholdValue = document.getElementById('thresholdValue');
        this.voiceLevelFill = document.getElementById('voiceLevelFill');
        this.transcriptArea = document.getElementById('realtimeTranscript');

        this.vadStatusDisplay = document.createElement('div');
        this.vadStatusDisplay.style.marginTop = '10px';
        this.vadStatusDisplay.style.fontSize = '0.9em';
        this.vadStatusDisplay.style.color = '#6b7280';
        this.transcriptArea.parentNode.insertBefore(this.vadStatusDisplay, this.transcriptArea);

        
        // 显示当前配置
        const configInfo = document.createElement('div');
        configInfo.style.fontSize = '0.8rem';
        configInfo.style.color = '#6b7280';
        configInfo.style.marginTop = '8px';
        configInfo.innerHTML = `
            <strong>当前配置:</strong><br>
            WebSocket: ${this.wsUrl}<br>
            API: ${this.apiBaseUrl}<br>
            音频: ${this.AUDIO_CHUNK_DURATION_MS}ms片段, ${this.SAMPLE_RATE}Hz
        `;
        this.startBtn.parentNode.insertBefore(configInfo, this.startBtn.nextSibling);
    }
    initEvents() {
        this.startBtn.addEventListener('click', () => this.toggleRecording());
        // 更新VAD启用状态
        this.vadEnabledCheckbox.addEventListener('change', (e) => {
            this.vadEnabled = e.target.checked;
            console.log('VAD enabled:', this.vadEnabled);
            // 立即同步到后端
            this.updateVADConfig({
                enabled: this.vadEnabled,
                speech_threshold: this.vadThreshold,
                silence_threshold: 0.3,
                smoothing_window: 2,
                min_speech_duration_ms: 300,
                min_silence_duration_ms: 500
            });
        });
        // 更新VAD阈值
        let vadUpdateTimeout;
        this.vadThresholdSlider.addEventListener('input', (e) => {
            this.vadThreshold = parseFloat(e.target.value);
            this.thresholdValue.textContent = this.vadThreshold.toFixed(1);
            console.log('VAD threshold:', this.vadThreshold);
            clearTimeout(vadUpdateTimeout);
            vadUpdateTimeout = setTimeout(() => {
                this.updateVADConfig({
                    enabled: this.vadEnabled,
                    speech_threshold: this.vadThreshold,
                    silence_threshold: 0.3,
                    smoothing_window: 2,
                    min_speech_duration_ms: 300,
                    min_silence_duration_ms: 500
                });
            }, 300);
        });
        // 添加重新连接按钮
        const reconnectBtn = document.createElement('button');
        reconnectBtn.textContent = '重新连接 WebSocket';
        reconnectBtn.className = 'btn';
        reconnectBtn.style.marginTop = '10px';
        reconnectBtn.addEventListener('click', () => this.setupWebSocket());
        this.connectionStatus.parentNode.appendChild(reconnectBtn);
        // 添加清除按钮
        const clearBtn = document.createElement('button');
        clearBtn.textContent = '清除转录内容';
        clearBtn.className = 'btn';
        clearBtn.style.marginTop = '5px';
        clearBtn.style.backgroundColor = '#6b7280';
        clearBtn.addEventListener('click', () => this.clearTranscript());
        this.transcriptArea.parentNode.insertBefore(clearBtn, this.transcriptArea.nextSibling);
        // 添加获取状态按钮
        const getStateBtn = document.createElement('button');
        getStateBtn.textContent = '获取连接状态';
        getStateBtn.className = 'btn';
        getStateBtn.style.marginTop = '5px';
        getStateBtn.style.backgroundColor = '#3b82f6';
        getStateBtn.addEventListener('click', () => this.sendGetState());
        this.transcriptArea.parentNode.insertBefore(getStateBtn, this.transcriptArea.nextSibling);
    }
    clearTranscript() {
        this.transcriptArea.innerHTML = '';
        this.segments.clear();
        this.speechSegments.clear();
        if (this.currentTemporaryElement) {
            this.currentTemporaryElement.remove();
            this.currentTemporaryElement = null;
        }
        console.log('🧹 转录内容已清除');
    }
    /**
     * 专门处理服务器发送的消息
     * @param {Object} data - 服务器消息数据
     */
    handleServerMessage(data) {
        switch (data.type) {
            case 'connection_established':
                console.log('🎉 服务器确认连接:', data);
                if (data.configuration) {
                    this.updateConfigFromServer(data.configuration);
                }
                // 服务器支持分层输出通过其他特征判断
                console.log('✨ 服务器支持分层输出策略');
                break;
            case 'tentative_output':
                this.handleTentativeOutput(data);
                break;
            case 'committed_output':
                this.handleCommittedOutput(data);
                break;
            case 'pong':
                console.log('🏓 收到服务器 pong 响应');
                break;
            case 'debug_audio_info':
                console.log('📁 调试音频信息:', data);
                break;
            case 'connection_state':
                console.log('📁 链接状态信息:', data);
                break;
            case 'error':
                console.error('❌ 服务器错误:', data);
                this.appendTranscript(`[服务器错误 ${data.code}] ${data.message || '未知错误'}`, true);
                break;
            case 'vad_debug':
                this.updateVADStatusDisplay(data);
                break;

            default:
                console.warn('❓ 未知服务器消息类型:', data.type, data);
                break;
        }
    }

    updateVADStatusDisplay(data) {
        if (!this.vadStatusDisplay) return;
        
        let statusText = `<strong>VAD状态:</strong><br>`;
        statusText += `置信度: ${(data.confidence || 0).toFixed(3)}<br>`;
        statusText += `语音状态: ${data.is_speech ? '🗣️ 语音活动' : '🔇 静音'}<br>`;
        statusText += `平滑状态: ${data.smoothed_state ? '🗣️ 语音' : '🔇 静音'}<br>`;
        statusText += `语音计数: ${data.speech_count || 0}<br>`;
        statusText += `静音计数: ${data.silence_count || 0}<br>`;
        statusText += `处理延迟: ${data.processing_time ? data.processing_time.toFixed(2) : 0}ms`;
        
        this.vadStatusDisplay.innerHTML = statusText;
    }

    handleTentativeOutput(data) {
        const text = data.text?.trim();
        const startChunkId = data.start_chunk_id;
        const endChunkId = data.end_chunk_id;
        const timestamp = data.timestamp || Date.now();
        
        if (!text || startChunkId === undefined || endChunkId === undefined) {
            console.warn('⚠️ 无效的临时输出数据:', data);
            return;
        }
        
        // 移除旧的临时元素
        if (this.currentTemporaryElement) {
            this.currentTemporaryElement.remove();
            this.currentTemporaryElement = null;
        }
        
        // 创建新的临时元素
        this.currentTemporaryElement = document.createElement('span');
        this.currentTemporaryElement.className = 'transcript-segment tentative-text';
        this.currentTemporaryElement.textContent = text + '...';
        this.currentTemporaryElement.dataset.startChunkId = startChunkId;
        this.currentTemporaryElement.dataset.endChunkId = endChunkId;
        this.currentTemporaryElement.dataset.timestamp = timestamp;
        
        this.transcriptArea.appendChild(this.currentTemporaryElement);
        
        // 记录这些chunk已被处理
        for (let chunkId = startChunkId; chunkId <= endChunkId; chunkId++) {
            this.segments.set(chunkId, this.currentTemporaryElement);
        }
        
        console.log(`⚡ 临时输出 [${startChunkId}-${endChunkId}]: "${text}"`);
        this.scrollToBottom();
    }
    
    handleCommittedOutput(data) {
        const segmentId = data.segment_id;
        const text = data.text?.trim();
        const startChunkId = data.start_chunk_id;
        const endChunkId = data.end_chunk_id;
        
        if (!text || startChunkId === undefined || endChunkId === undefined) {
            console.warn('⚠️ 无效的确认输出数据:', data);
            return;
        }
        
        // 1. 移除相关的临时元素
        for (let chunkId = startChunkId; chunkId <= endChunkId; chunkId++) {
            if (this.segments.has(chunkId)) {
                const element = this.segments.get(chunkId);
                if (element && element.classList.contains('tentative-text')) {
                    element.remove();
                    this.segments.delete(chunkId);
                }
            }
        }
        
        // 2. 移除当前临时元素（如果是这部分）
        if (this.currentTemporaryElement) {
            const tempStart = parseInt(this.currentTemporaryElement.dataset.startChunkId);
            const tempEnd = parseInt(this.currentTemporaryElement.dataset.endChunkId);
            if (tempStart <= endChunkId && tempEnd >= startChunkId) {
                this.currentTemporaryElement.remove();
                this.currentTemporaryElement = null;
            }
        }
        
        // 3. 创建确认段
        let segmentElement = this.speechSegments.get(segmentId);
        if (!segmentElement) {
            // 创建新段
            segmentElement = document.createElement('span');
            segmentElement.id = `segment-${segmentId}`;
            segmentElement.className = 'transcript-segment committed-text';
            segmentElement.textContent = text;
            segmentElement.dataset.segmentId = segmentId;
            segmentElement.dataset.startChunkId = startChunkId;
            segmentElement.dataset.endChunkId = endChunkId;
            segmentElement.dataset.timestamp = data.timestamp || Date.now();
            
            this.transcriptArea.appendChild(segmentElement);
            this.speechSegments.set(segmentId, segmentElement);
            
            // 添加淡入动画
            segmentElement.style.opacity = '0';
            segmentElement.style.transform = 'translateY(5px)';
            setTimeout(() => {
                segmentElement.style.transition = 'all 0.3s ease';
                segmentElement.style.opacity = '1';
                segmentElement.style.transform = 'translateY(0)';
            }, 10);
        } else {
            // 更新现有段
            segmentElement.textContent = text;
            segmentElement.dataset.startChunkId = startChunkId;
            segmentElement.dataset.endChunkId = endChunkId;
        }
        
        // 4. 记录这些chunk属于这个段
        for (let chunkId = startChunkId; chunkId <= endChunkId; chunkId++) {
            this.segments.set(chunkId, segmentElement);
        }
        
        console.log(`✅ 确认输出 [${startChunkId}-${endChunkId}] (段 ${segmentId}): "${text}"`);
        this.scrollToBottom();
    }
    
    updateConfigFromServer(config) {
        if (config.audio_chunk_duration_ms) {
            this.AUDIO_CHUNK_DURATION_MS = config.audio_chunk_duration_ms;
            console.log(`⚙️ 从服务器更新音频配置: ${this.AUDIO_CHUNK_DURATION_MS}ms/片段`);
        }
    }
    scrollToBottom() {
        try {
            // 平滑滚动
            this.transcriptArea.scrollTo({
                top: this.transcriptArea.scrollHeight,
                behavior: 'smooth'
            });
        } catch (e) {
            console.warn('滚动到底部失败:', e);
            this.transcriptArea.scrollTop = this.transcriptArea.scrollHeight;
        }
    }
    /**
     * 向服务器发送客户端消息
     * @param {Object} message - 客户端消息
     */
    sendClientMessage(message) {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            console.warn('⚠️ WebSocket 未连接，无法发送消息:', message.type);
            return;
        }
        try {
            const jsonMessage = JSON.stringify(message);
            this.websocket.send(jsonMessage);
            console.log(`📤 发送消息 [${message.type}]:`, message);
        } catch (error) {
            console.error('❌ 发送消息失败:', error);
        }
    }
    async updateVADConfig(config) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/vad/config`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(config)
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`VAD 配置更新失败: ${errorData.detail || response.statusText}`);
            }
            
            const result = await response.json();
            console.log('✅ VAD 配置更新成功:', result);
            return result;
        } catch (error) {
            console.error('❌ VAD 配置更新失败:', error);
            this.appendTranscript(`[配置错误] ${error.message}`, true);
            return null;
        }
    }
    async setupWebSocket() {
        // 关闭现有连接
        this.closeWebSocket();
        this.connectionStatus.className = 'status-indicator';
        this.connectionStatus.classList.add('connecting');
        this.connectionText.textContent = '连接中...';
        this.startBtn.disabled = true;
        try {
            console.log('🔧 WebSocket 连接调试开始');
            console.log(`🔌 尝试连接 WebSocket: ${this.wsUrl}`);
            console.log(`📡 协议支持: ${window.WebSocket ? 'WebSocket API 可用' : 'WebSocket API 不可用'}`);
            console.log(`🌐 网络状态: ${navigator.onLine ? '在线' : '离线'}`);
            // 检查 URL 格式
            try {
                new URL(this.wsUrl);
                console.log('✅ WebSocket URL 格式正确');
            } catch (e) {
                console.error('❌ WebSocket URL 格式错误:', e);
                throw new Error(`无效的 WebSocket URL: ${this.wsUrl}`);
            }
            this.websocket = new WebSocket(this.wsUrl);
            // 添加详细的连接事件监听
            this.websocket.onopen = (event) => {
                console.log('✅ WebSocket 连接成功', {
                    url: this.wsUrl,
                    protocol: this.websocket.protocol,
                    readyState: this.websocket.readyState,
                    bufferedAmount: this.websocket.bufferedAmount,
                    extensions: this.websocket.extensions,
                    timestamp: Date.now()
                });
                this.connectionStatus.className = 'status-indicator active';
                this.connectionText.textContent = '已连接';
                this.startBtn.disabled = false;
                this.reconnectAttempts = 0;

                // 请求完整状态同步
                this.sendGetState();
                // 开启心跳
                this.startHeartbeat();
            };
            this.websocket.onmessage = (event) => {
                try {
                    if (event.data instanceof ArrayBuffer) {
                        console.debug(`📥 收到二进制数据: ${event.data.byteLength} bytes`);
                        return;
                    }
                    const data = JSON.parse(event.data);
                    console.log(`📥 收到服务器消息 [${data.type}]:`, data);
                    this.handleServerMessage(data);
                } catch (e) {
                    console.error('❌ 消息解析失败:', e, event.data);
                    this.appendTranscript(`[消息解析错误] ${e.message}`, true);
                }
            };
            this.websocket.onclose = (event) => {
                console.log('🔌 WebSocket 连接关闭', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean,
                    timestamp: Date.now()
                });
                this.connectionStatus.className = 'status-indicator';
                this.connectionText.textContent = `已断开 (code: ${event.code})`;
                this.startBtn.disabled = true;
                if (this.isRecording) {
                    this.stopRecording();
                }
                // 清理状态
                this.segments.clear();
                this.speechSegments.clear();
                if (this.currentTemporaryElement) {
                    this.currentTemporaryElement.remove();
                    this.currentTemporaryElement = null;
                }
                // 尝试重新连接
                if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.reconnectAttempts++;
                    console.log(`🔄 尝试重新连接 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                    this.connectionText.textContent = `重新连接中 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`;
                    setTimeout(() => {
                        this.setupWebSocket();
                    }, this.reconnectDelay * this.reconnectAttempts);
                } else {
                    console.log('❌ 达到最大重连次数，停止尝试');
                    this.appendTranscript(`WebSocket 连接失败，代码: ${event.code}, 原因: ${event.reason}`, true);
                }
            };
            this.websocket.onerror = (error) => {
                console.error('❌ WebSocket 错误', {
                    error: error.message,
                    type: error.type,
                    timestamp: Date.now()
                });
                this.connectionStatus.className = 'status-indicator';
                this.connectionStatus.classList.add('error');
                this.connectionText.textContent = '连接错误';
                this.startBtn.disabled = true;
                this.appendTranscript(`WebSocket 错误: ${error.message}`, true);
            };
            // 添加连接超时
            setTimeout(() => {
                if (this.websocket && this.websocket.readyState === WebSocket.CONNECTING) {
                    console.warn('⏰ WebSocket 连接超时 (30秒)');
                    this.websocket.close(4000, 'Connection timeout');
                }
            }, 30000);
        } catch (error) {
            console.error('❌ WebSocket 设置失败:', error);
            this.connectionStatus.className = 'status-indicator';
            this.connectionStatus.classList.add('error');
            this.connectionText.textContent = '设置失败';
            this.startBtn.disabled = true;
            // 显示详细错误信息
            const errorInfo = document.createElement('div');
            errorInfo.style.color = 'var(--danger)';
            errorInfo.style.marginTop = '8px';
            errorInfo.innerHTML = `
                <strong>WebSocket 连接失败:</strong><br>
                URL: ${this.wsUrl}<br>
                错误: ${error.message}<br>
                <br>
                <strong>排查步骤:</strong><br>
                1. 检查后端服务是否运行在 ${this.wsBaseUrl}<br>
                2. 检查防火墙是否开放端口 ${this.wsBaseUrl.split(':')[2] || '8000'}<br>
                3. 检查浏览器控制台是否有 CORS 错误<br>
                4. 尝试直接访问: ${this.apiBaseUrl}/health<br>
                5. 检查网络连接是否正常
            `;
            this.transcriptArea.innerHTML = '';
            this.transcriptArea.appendChild(errorInfo);
            this.appendTranscript(`WebSocket 设置失败: ${error.message}`, true);
        }
    }
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.heartbeatInterval = setInterval(() => {
            if (this.websocket?.readyState === WebSocket.OPEN) {
                const pingData = {
                    type: 'ping',
                    timestamp: Date.now(),
                    client_id: this.clientId || `web-${Date.now()}`
                };
                this.websocket.send(JSON.stringify(pingData));
                console.debug('💓 发送心跳 ping');
            }
        }, 5000); // 每5秒发送一次心跳
    }
    closeWebSocket() {
        if (this.websocket) {
            if (this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.close(1000, 'Client disconnect');
            }
            this.websocket = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
    async toggleRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }
    async startRecording() {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            alert('WebSocket 未连接，请先确保连接成功后再开始录音');
            return;
        }
        try {
            this.startBtn.disabled = true;
            const loadingElement = document.querySelector('.loading');
            if (loadingElement) {
                loadingElement.style.display = 'inline-block';
            }
            // 请求麦克风权限
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            // 初始化音频上下文
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.SAMPLE_RATE,
                latencyHint: 'interactive'
            });
            // 使用 AudioWorklet - 修复方案
            await this.setupAudioWorklet();
            this.isRecording = true;
            // 更新UI
            this.startBtn.classList.add('btn-danger');
            this.btnText.textContent = '停止对话';
            this.connectionStatus.classList.add('recording');
            this.startBtn.disabled = false;
            const loadingElementEnd = document.querySelector('.loading');
            if (loadingElementEnd) {
                loadingElementEnd.style.display = 'none';
            }
            console.log(`🎤 录音已开始 (16kHz, ${this.AUDIO_CHUNK_DURATION_MS}ms片段)`);
        } catch (error) {
            console.error('❌ 录音启动失败:', error);
            this.startBtn.disabled = false;
            const loadingElementError = document.querySelector('.loading');
            if (loadingElementError) {
                loadingElementError.style.display = 'none';
            }
            alert(`录音启动失败: ${error.message}\n请检查:\n1. 浏览器是否有麦克风权限\n2. 是否使用 HTTPS (某些浏览器要求)\n3. 音频设备是否可用`);
            this.cleanupAudio();
        }
    }
    async setupAudioWorklet() {
        try {
            const baseUrl = window.location.origin;
            const workletPath = `${baseUrl}/audio-worklets/pcm-processor.js`;
            console.log('🔍 验证 AudioWorklet 文件:', workletPath);
            // 验证文件是否存在
            const response = await fetch(workletPath, { 
                method: 'GET',
                headers: {
                    'Accept': 'application/javascript'
                }
            });
            if (!response.ok) {
                throw new Error(`AudioWorklet 文件不可访问: ${workletPath}, status: ${response.status}, ${response.statusText}`);
            }
            const fileContent = await response.text();
            if (fileContent.length < 100) {
                throw new Error(`AudioWorklet 文件内容异常，长度: ${fileContent.length}`);
            }
            console.log('✅ AudioWorklet 文件验证成功，加载模块...');
            await this.audioContext.audioWorklet.addModule(workletPath);
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 0,
                processorOptions: {
                    sampleRate: this.SAMPLE_RATE,
                    chunkDurationMs: this.AUDIO_CHUNK_DURATION_MS
                }
            });
            // 配置处理器
            this.workletNode.port.postMessage({
                type: 'config',
                sampleRate: this.SAMPLE_RATE,
                chunkDurationMs: this.AUDIO_CHUNK_DURATION_MS
            });
            this.workletNode.port.onmessage = (event) => {
                if (this.isRecording && this.websocket?.readyState === WebSocket.OPEN) {
                    if (event.data instanceof ArrayBuffer) {
                        if (event.data.byteLength > 0) {
                            this.sendAudioData(event.data);
                            // 用于VU表 - 从PCM数据重新计算
                            try {
                                const pcmArray = new Int16Array(event.data);
                                const float32Array = new Float32Array(pcmArray.length);
                                for (let i = 0; i < pcmArray.length; i++) {
                                    float32Array[i] = pcmArray[i] / 32768.0;
                                }
                                this.updateVoiceLevelFromAudio(float32Array);
                            } catch (e) {
                                console.error('❌ VU表计算失败:', e);
                            }
                        } else {
                            console.warn('💡 空音频数据，跳过处理');
                        }
                    }
                }
            };
            // 连接音频图
            source.connect(this.workletNode);
            console.log('✅ AudioWorklet 初始化成功，配置:', {
                sampleRate: this.SAMPLE_RATE,
                chunkDurationMs: this.AUDIO_CHUNK_DURATION_MS,
                expectedChunkSize: this.AUDIO_CHUNK_DURATION_MS * this.SAMPLE_RATE * this.BYTES_PER_SAMPLE / 1000,
                workletNode: !!this.workletNode
            });
            // 测试音频处理
            setTimeout(() => {
                console.log('🧪 AudioWorklet 测试: 检查节点状态');
                if (this.workletNode) {
                    console.log('✅ Worklet 节点存在');
                } else {
                    console.error('❌ Worklet 节点未创建');
                }
            }, 1000);
        } catch (error) {
            console.error('❌ AudioWorklet 初始化失败:', error);
            console.error('🔧 详细错误信息:', {
                name: error.name,
                message: error.message,
                stack: error.stack,
                fileName: error.fileName,
                lineNumber: error.lineNumber
            });
            // 提供详细的错误信息给用户
            const errorDetails = `
    AudioWorklet 初始化失败，请检查：
    1. 文件路径是否正确: ${workletPath}
    2. 服务器是否正确提供静态文件
    3. 浏览器控制台是否有 CORS 错误
    4. 网络请求是否成功 (状态码: ${error.status || '未知'})
    错误详情: ${error.message}
            `;
            alert(errorDetails);
            throw error;
        }
    }
    sendAudioData(audioBuffer) {
        try {
            // 验证缓冲区大小是否正确
            const expectedSize = this.AUDIO_CHUNK_DURATION_MS * this.SAMPLE_RATE * this.BYTES_PER_SAMPLE / 1000;
            
            if (audioBuffer.byteLength !== expectedSize) {
                console.warn(`⚠️ 音频数据大小不匹配，预期: ${expectedSize} 字节，实际: ${audioBuffer.byteLength} 字节`);
                
                // 尝试修复大小不匹配
                if (audioBuffer.byteLength < expectedSize) {
                    // 填充到正确大小
                    const newBuffer = new ArrayBuffer(expectedSize);
                    const newView = new Uint8Array(newBuffer);
                    const oldView = new Uint8Array(audioBuffer);
                    newView.set(oldView);
                    audioBuffer = newBuffer;
                    console.log(`🔧 已填充音频数据至 ${expectedSize} 字节`);
                } else {
                    // 截断到正确大小
                    const newBuffer = audioBuffer.slice(0, expectedSize);
                    audioBuffer = newBuffer;
                    console.log(`🔧 已截断音频数据至 ${expectedSize} 字节`);
                }
            }
            
            if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
                console.warn('⚠️ WebSocket 未准备好，无法发送音频数据');
                return;
            }
            
            this.websocket.send(audioBuffer);
            this.lastChunkId++;
            console.debug(`📤 发送音频片段 #${this.lastChunkId}, 大小: ${audioBuffer.byteLength} 字节`);
        } catch (error) {
            console.error('❌ 发送音频数据失败:', error);
        }
    }
    getReadyStateString(state) {
        const states = {
            0: 'CONNECTING',
            1: 'OPEN',
            2: 'CLOSING',
            3: 'CLOSED'
        };
        return states[state] || `UNKNOWN (${state})`;
    }
    reconnectWebSocket() {
        console.log('🔄 尝试重新连接 WebSocket');
        this.closeWebSocket();
        this.setupWebSocket();
    }
    updateVoiceLevelFromAudio(audioData) {
        // 计算RMS值
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        const rms = Math.sqrt(sum / audioData.length);
        const level = Math.min(1.0, rms * 5); // 放大以便显示
        this.updateVoiceLevel(level);
    }
    updateVoiceLevel(level) {
        const percent = Math.min(100, level * 100);
        this.voiceLevelFill.style.width = `${percent}%`;
        this.voiceLevelFill.style.backgroundColor = percent > 30 ? '#10b981' : '#9ca3af';
        // 更新连接状态指示器
        if (this.isRecording) {
            this.connectionStatus.style.borderColor = percent > 30 ? '#10b981' : '#9ca3af';
        }
    }
    stopRecording() {
        this.isRecording = false;
        this.cleanupAudio();
        // 更新UI
        this.startBtn.classList.remove('btn-danger');
        this.btnText.textContent = '开始对话';
        this.connectionStatus.classList.remove('recording');
        this.connectionStatus.style.borderColor = '';
    }
    cleanupAudio() {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(console.error);
            this.audioContext = null;
        }
    }
    // 控制消息发送方法
    sendPing() {
        this.sendClientMessage({
            type: 'ping',
            timestamp: Date.now()
        });
    }
    sendGetState() {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            console.warn('⚠️ WebSocket 未连接，无法发送状态查询');
            this.appendTranscript('WebSocket 未连接，无法获取状态', true);
            return;
        }
        
        const stateRequest = {
            type: 'get_state',
            timestamp: Date.now()
        };
        
        console.log('🔍 发送状态查询');
        this.sendClientMessage(stateRequest);
    }
    appendTranscript(text, isError = false) {
        const element = document.createElement('div');
        element.className = isError ? 'transcript-error' : 'transcript-info';
        element.textContent = text;
        element.style.color = isError ? 'var(--danger)' : 'var(--gray)';
        element.style.fontSize = '0.9em';
        element.style.margin = '4px 0';
        element.style.padding = '4px 8px';
        element.style.borderRadius = '4px';
        element.style.backgroundColor = isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(156, 163, 175, 0.1)';
        this.transcriptArea.appendChild(element);
        this.scrollToBottom();
    }
    cleanup() {
        this.stopRecording();
        this.closeWebSocket();
        // 清理DOM
        if (this.currentTemporaryElement) {
            this.currentTemporaryElement.remove();
            this.currentTemporaryElement = null;
        }
        this.segments.clear();
        this.speechSegments.clear();
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
}
// 添加CSS样式
const style = document.createElement('style');
style.textContent = `
.transcript-segment {
    transition: all 0.3s ease;
    margin: 2px 4px 2px 0;
    padding: 4px 8px;
    border-radius: 6px;
    display: inline-block;
    line-height: 1.6;
    font-size: 1.05em;
    position: relative;
}
.tentative-text {
    color: #6b7280;
    opacity: 0.9;
    font-style: italic;
    background-color: #f3f4f6;
    border: 1px dashed #d1d5db;
}
.committed-text {
    color: #1f2937;
    font-weight: 500;
    background-color: #f9fafb;
    border: 1px solid #e5e7eb;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.committed-text:hover {
    background-color: #f3f4f6;
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
.status-indicator {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid #9ca3af;
    margin-right: 8px;
    transition: all 0.3s ease;
}
.status-indicator.active {
    border-color: #10b981;
    background-color: #10b981;
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
}
.status-indicator.connecting {
    border-color: #3b82f6;
    background-color: #3b82f6;
    animation: pulse 1.5s infinite;
}
.status-indicator.error {
    border-color: #ef4444;
    background-color: #ef4444;
}
.status-indicator.recording {
    border-color: #ef4444;
    background-color: #ef4444;
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
    animation: pulseRecording 2s infinite;
}
@keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
    70% { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0); }
    100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
}
@keyframes pulseRecording {
    0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.6); }
    70% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
    100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
}
.status-indicator[data-vad-state="speech"] {
    border-color: #10b981;
    background-color: #10b981;
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
}
.status-indicator[data-vad-state="silence"] {
    border-color: #9ca3af;
    background-color: transparent;
}
#voiceLevel {
    height: 8px;
    background-color: #e5e7eb;
    border-radius: 4px;
    overflow: hidden;
    margin-top: 4px;
}
.voice-level-fill {
    height: 100%;
    background-color: #9ca3af;
    border-radius: 4px;
    transition: all 0.1s ease;
}
/* 按钮样式优化 */
.btn {
    background-color: #3b82f6;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    transition: all 0.2s ease;
    margin: 4px 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.btn:hover {
    background-color: #2563eb;
    transform: translateY(-1px);
}
.btn-danger {
    background-color: #ef4444;
}
.btn-danger:hover {
    background-color: #dc2626;
}
.btn:disabled {
    background-color: #9ca3af;
    cursor: not-allowed;
    transform: none;
}
.loading {
    display: none;
    width: 16px;
    height: 16px;
    border: 2px solid #9ca3af;
    border-top: 2px solid #3b82f6;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-left: 8px;
}
@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
.transcript-error, .transcript-info {
    animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: translateY(0); }
}
/* 响应式设计 */
@media (max-width: 768px) {
    .transcript-segment {
        font-size: 1em;
        padding: 3px 6px;
        margin: 1px 3px 1px 0;
    }
    .btn {
        width: 100%;
        margin: 4px 0;
    }
}
/* 暗色模式支持 */
@media (prefers-color-scheme: dark) {
    .tentative-text {
        background-color: #2d3748;
        color: #a0aec0;
    }
    .committed-text {
        background-color: #2d3748;
        color: #e2e8f0;
        border-color: #4a5568;
    }
    .committed-text:hover {
        background-color: #323b4b;
    }
}
`;
// 只添加一次样式
if (!document.getElementById('realtime-chat-styles')) {
    style.id = 'realtime-chat-styles';
    document.head.appendChild(style);
}