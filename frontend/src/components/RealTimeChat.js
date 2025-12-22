export class RealTimeChat {
    constructor() {
        this.initConfig();
        this.initState();
        this.initElements();
        this.initEvents();
        this.setupWebSocket();
        this.setupPingInterval();
    }

    // ==================== 配置初始化 ====================
    initConfig() {
        // 默认配置
        const defaultConfig = {
            SAMPLE_RATE: 16000,
            AUDIO_CHUNK_DURATION_MS: 64,
            BYTES_PER_SAMPLE: 2,
            maxReconnectAttempts: 5,
            reconnectDelay: 1000,
            heartbeatInterval: 5000,
            pingInterval: 30000
        };

        // 从环境变量获取配置
        const envConfig = {
            apiBaseUrl: process.env.VUE_APP_API_BASE_URL || 'http://localhost:8000',
            wsBaseUrl: process.env.VUE_APP_WS_BASE_URL || 'ws://localhost:8000',
            wsPath: process.env.VUE_APP_WS_PATH || '/ws/audio'
        };

        // 根据协议调整URL
        if (window.location.protocol === 'https:') {
            envConfig.wsBaseUrl = envConfig.wsBaseUrl.replace('ws://', 'wss://');
            envConfig.apiBaseUrl = envConfig.apiBaseUrl.replace('http://', 'https://');
        } else if (window.location.protocol === 'http:') {
            envConfig.wsBaseUrl = envConfig.wsBaseUrl.replace('wss://', 'ws://');
            envConfig.apiBaseUrl = envConfig.apiBaseUrl.replace('https://', 'http://');
        }

        this.config = {
            ...defaultConfig,
            ...envConfig,
            wsUrl: `${envConfig.wsBaseUrl}${envConfig.wsPath}`
        };

        console.log('🔧 RealTimeChat 配置:');
        console.log(`   当前页面协议: ${window.location.protocol}`);
        console.log(`   API Base URL: ${this.config.apiBaseUrl}`);
        console.log(`   WS Base URL: ${this.config.wsBaseUrl}`);
        console.log(`   WS Path: ${this.config.wsPath}`);
        console.log(`   Final WS URL: ${this.config.wsUrl}`);
        console.log(`   音频配置: ${this.config.AUDIO_CHUNK_DURATION_MS}ms/片段, ${this.config.SAMPLE_RATE}Hz`);
    }

    // ==================== 状态初始化 ====================
    initState() {
        this.websocket = null;
        this.audioContext = null;
        this.mediaStream = null;
        this.workletNode = null;
        this.isRecording = false;
        this.vadEnabled = true;
        this.vadThreshold = 0.6;
        this.lastSpeechTime = 0;
        this.reconnectAttempts = 0;
        this.pingInterval = null;
        this.heartbeatInterval = null;
        
        // 分层输出相关
        this.segments = new Map();
        this.speechSegments = new Map();
        this.currentTemporaryElement = null;
        this.lastChunkId = -1;
        
        // 事件监听器引用
        this.eventListeners = new Map();
    }

    // ==================== DOM 初始化 ====================
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

        // VAD状态显示
        this.vadStatusDisplay = document.createElement('div');
        Object.assign(this.vadStatusDisplay.style, {
            marginTop: '10px',
            fontSize: '0.9em',
            color: '#6b7280'
        });
        this.transcriptArea.parentNode.insertBefore(this.vadStatusDisplay, this.transcriptArea);

        // 配置信息显示
        const configInfo = document.createElement('div');
        Object.assign(configInfo.style, {
            fontSize: '0.8rem',
            color: '#6b7280',
            marginTop: '8px'
        });
        configInfo.innerHTML = `
            <strong>当前配置:</strong><br>
            WebSocket: ${this.config.wsUrl}<br>
            API: ${this.config.apiBaseUrl}<br>
            音频: ${this.config.AUDIO_CHUNK_DURATION_MS}ms片段, ${this.config.SAMPLE_RATE}Hz
        `;
        this.startBtn.parentNode.insertBefore(configInfo, this.startBtn.nextSibling);
    }

    // ==================== 事件绑定 ====================
    initEvents() {
        this.addScopedEventListener(this.startBtn, 'click', () => this.toggleRecording());
        this.addScopedEventListener(this.vadEnabledCheckbox, 'change', (e) => this.handleVADEnabledChange(e));
        this.addScopedEventListener(this.vadThresholdSlider, 'input', (e) => this.handleVADThresholdChange(e));
        
        // 按钮创建
        this.createReconnectButton();
        this.createClearButton();
        this.createGetStateButton();
    }

    addScopedEventListener(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        const key = `${element.id || 'anonymous'}-${event}`;
        this.eventListeners.set(key, { element, event, handler });
    }

    // ==================== 按钮创建 ====================
    createReconnectButton() {
        const reconnectBtn = document.createElement('button');
        reconnectBtn.textContent = '重新连接 WebSocket';
        reconnectBtn.className = 'btn';
        Object.assign(reconnectBtn.style, {
            marginTop: '10px'
        });
        this.addScopedEventListener(reconnectBtn, 'click', () => this.setupWebSocket());
        this.connectionStatus.parentNode.appendChild(reconnectBtn);
    }

    createClearButton() {
        const clearBtn = document.createElement('button');
        clearBtn.textContent = '清除转录内容';
        clearBtn.className = 'btn';
        Object.assign(clearBtn.style, {
            marginTop: '5px',
            backgroundColor: '#6b7280'
        });
        this.addScopedEventListener(clearBtn, 'click', () => this.clearTranscript());
        this.transcriptArea.parentNode.insertBefore(clearBtn, this.transcriptArea.nextSibling);
    }

    createGetStateButton() {
        const getStateBtn = document.createElement('button');
        getStateBtn.textContent = '获取连接状态';
        getStateBtn.className = 'btn';
        Object.assign(getStateBtn.style, {
            marginTop: '5px',
            backgroundColor: '#3b82f6'
        });
        this.addScopedEventListener(getStateBtn, 'click', () => this.sendGetState());
        this.transcriptArea.parentNode.insertBefore(getStateBtn, this.transcriptArea.nextSibling);
    }

    // ==================== VAD 事件处理 ====================
    handleVADEnabledChange(e) {
        this.vadEnabled = e.target.checked;
        console.log('VAD enabled:', this.vadEnabled);
        this.updateVADConfig({
            enabled: this.vadEnabled,
            speech_threshold: this.vadThreshold,
            smoothing_window: 2,
        });
    }

    handleVADThresholdChange(e) {
        this.vadThreshold = parseFloat(e.target.value);
        this.thresholdValue.textContent = this.vadThreshold.toFixed(1);
        console.log('VAD threshold:', this.vadThreshold);
        
        this.debounce(() => {
            this.updateVADConfig({
                enabled: this.vadEnabled,
                speech_threshold: this.vadThreshold,
                smoothing_window: 2,
            });
        }, 300, 'vadThresholdUpdate');
    }

    // ==================== WebSocket 管理 ====================
    setupPingInterval() {
        this.clearIntervalSafe('pingInterval');
        this.pingInterval = setInterval(() => {
            if (this.websocket?.readyState === WebSocket.OPEN) {
                this.sendPing();
            }
        }, this.config.pingInterval);
    }

    setupWebSocket() {
        this.closeWebSocket();
        this.updateConnectionStatus('connecting', '连接中...');
        this.startBtn.disabled = true;

        try {
            console.log('🔧 WebSocket 连接调试开始');
            console.log(`🔌 尝试连接 WebSocket: ${this.config.wsUrl}`);
            console.log(`📡 协议支持: ${window.WebSocket ? 'WebSocket API 可用' : 'WebSocket API 不可用'}`);
            console.log(`🌐 网络状态: ${navigator.onLine ? '在线' : '离线'}`);

            // 验证URL格式
            try {
                new URL(this.config.wsUrl);
                console.log('✅ WebSocket URL 格式正确');
            } catch (e) {
                throw new Error(`无效的 WebSocket URL: ${this.config.wsUrl}`);
            }

            this.websocket = new WebSocket(this.config.wsUrl);
            this.websocket.binaryType = 'arraybuffer';

            this.websocket.onopen = (event) => this.handleWebSocketOpen(event);
            this.websocket.onmessage = (event) => this.handleWebSocketMessage(event);
            this.websocket.onclose = (event) => this.handleWebSocketClose(event);
            this.websocket.onerror = (error) => this.handleWebSocketError(error);

            // 连接超时
            setTimeout(() => {
                if (this.websocket?.readyState === WebSocket.CONNECTING) {
                    console.warn('⏰ WebSocket 连接超时 (30秒)');
                    this.websocket?.close(4000, 'Connection timeout');
                }
            }, 30000);

        } catch (error) {
            this.handleWebSocketSetupError(error);
        }
    }

    handleWebSocketOpen(event) {
        console.log('✅ WebSocket 连接成功', {
            url: this.config.wsUrl,
            protocol: this.websocket.protocol,
            readyState: this.websocket.readyState,
            timestamp: Date.now()
        });
        this.updateConnectionStatus('active', '已连接');
        this.startBtn.disabled = false;
        this.reconnectAttempts = 0;
        this.sendGetState();
        this.startHeartbeat();
    }

    handleWebSocketMessage(event) {
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
    }

    handleWebSocketClose(event) {
        console.log('🔌 WebSocket 连接关闭', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            timestamp: Date.now()
        });
        
        this.updateConnectionStatus('disconnected', `已断开 (code: ${event.code})`);
        this.startBtn.disabled = true;
        
        if (this.isRecording) {
            this.stopRecording();
        }
        
        this.clearTranscriptState();
        
        // 重连逻辑
        if (event.code !== 1000 && this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.attemptReconnect();
        } else {
            console.log('❌ 达到最大重连次数，停止尝试');
            this.appendTranscript(`WebSocket 连接失败，代码: ${event.code}, 原因: ${event.reason}`, true);
        }
    }

    handleWebSocketError(error) {
        console.error('❌ WebSocket 错误', {
            error: error.message,
            type: error.type,
            timestamp: Date.now()
        });
        this.updateConnectionStatus('error', '连接错误');
        this.startBtn.disabled = true;
        this.appendTranscript(`WebSocket 错误: ${error.message}`, true);
    }

    handleWebSocketSetupError(error) {
        console.error('❌ WebSocket 设置失败:', error);
        this.updateConnectionStatus('error', '设置失败');
        this.startBtn.disabled = true;
        
        const errorInfo = document.createElement('div');
        Object.assign(errorInfo.style, {
            color: 'var(--danger)',
            marginTop: '8px'
        });
        errorInfo.innerHTML = `
            <strong>WebSocket 连接失败:</strong><br>
            URL: ${this.config.wsUrl}<br>
            错误: ${error.message}<br>
            <br>
            <strong>排查步骤:</strong><br>
            1. 检查后端服务是否运行在 ${this.config.wsBaseUrl}<br>
            2. 检查防火墙是否开放端口 ${this.config.wsBaseUrl.split(':')[2] || '8000'}<br>
            3. 检查浏览器控制台是否有 CORS 错误<br>
            4. 尝试直接访问: ${this.config.apiBaseUrl}/health<br>
            5. 检查网络连接是否正常
        `;
        
        this.transcriptArea.innerHTML = '';
        this.transcriptArea.appendChild(errorInfo);
        this.appendTranscript(`WebSocket 设置失败: ${error.message}`, true);
    }

    startHeartbeat() {
        this.clearIntervalSafe('heartbeatInterval');
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
        }, this.config.heartbeatInterval);
    }

    closeWebSocket() {
        if (this.websocket) {
            if (this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.close(1000, 'Client disconnect');
            }
            this.websocket = null;
        }
        this.stopHeartbeat();
        this.clearIntervalSafe('pingInterval');
    }

    stopHeartbeat() {
        this.clearIntervalSafe('heartbeatInterval');
    }

    // ==================== 连接状态管理 ====================
    updateConnectionStatus(status, text) {
        this.connectionStatus.className = 'status-indicator';
        this.connectionStatus.classList.add(status);
        this.connectionText.textContent = text;
    }

    // ==================== 音频处理 ====================
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
            this.showLoading(true);

            // 请求麦克风权限
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.config.SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // 初始化音频上下文
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.config.SAMPLE_RATE,
                latencyHint: 'interactive'
            });

            // 设置AudioWorklet
            await this.setupAudioWorklet();

            this.isRecording = true;
            this.updateRecordingUI(true);
            this.showLoading(false);

            console.log(`🎤 录音已开始 (${this.config.SAMPLE_RATE}Hz, ${this.config.AUDIO_CHUNK_DURATION_MS}ms片段)`);
        } catch (error) {
            this.handleRecordingError(error);
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
                headers: { 'Accept': 'application/javascript' }
            });

            if (!response.ok) {
                throw new Error(`AudioWorklet 文件不可访问: ${workletPath}, status: ${response.status}`);
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
                    sampleRate: this.config.SAMPLE_RATE,
                    chunkDurationMs: this.config.AUDIO_CHUNK_DURATION_MS
                }
            });

            // 配置处理器
            this.workletNode.port.postMessage({
                type: 'config',
                sampleRate: this.config.SAMPLE_RATE,
                chunkDurationMs: this.config.AUDIO_CHUNK_DURATION_MS
            });

            this.workletNode.port.onmessage = (event) => {
                if (this.isRecording && this.websocket?.readyState === WebSocket.OPEN) {
                    if (event.data instanceof ArrayBuffer) {
                        if (event.data.byteLength > 0) {
                            this.sendAudioData(event.data);
                            this.updateVoiceLevelFromAudioBuffer(event.data);
                        } else {
                            console.warn('💡 空音频数据，跳过处理');
                        }
                    }
                }
            };

            // 连接音频图
            source.connect(this.workletNode);
            console.log('✅ AudioWorklet 初始化成功');

        } catch (error) {
            console.error('❌ AudioWorklet 初始化失败:', error);
            const errorDetails = `
AudioWorklet 初始化失败，请检查：
1. 文件路径是否正确: ${workletPath}
2. 服务器是否正确提供静态文件
3. 浏览器控制台是否有 CORS 错误
4. 网络请求是否成功
错误详情: ${error.message}
            `;
            alert(errorDetails);
            throw error;
        }
    }

    updateVoiceLevelFromAudioBuffer(audioBuffer) {
        try {
            const pcmArray = new Int16Array(audioBuffer);
            const float32Array = new Float32Array(pcmArray.length);
            for (let i = 0; i < pcmArray.length; i++) {
                float32Array[i] = pcmArray[i] / 32768.0;
            }
            this.updateVoiceLevelFromAudio(float32Array);
        } catch (e) {
            console.error('❌ VU表计算失败:', e);
        }
    }

    sendAudioData(audioBuffer) {
        try {
            const expectedSize = this.config.AUDIO_CHUNK_DURATION_MS * 
                               this.config.SAMPLE_RATE * 
                               this.config.BYTES_PER_SAMPLE / 1000;
            
            if (audioBuffer.byteLength !== expectedSize) {
                audioBuffer = this.fixAudioBufferSize(audioBuffer, expectedSize);
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

    fixAudioBufferSize(audioBuffer, expectedSize) {
        if (audioBuffer.byteLength < expectedSize) {
            const newBuffer = new ArrayBuffer(expectedSize);
            const newView = new Uint8Array(newBuffer);
            const oldView = new Uint8Array(audioBuffer);
            newView.set(oldView);
            console.log(`🔧 已填充音频数据至 ${expectedSize} 字节`);
            return newBuffer;
        } else {
            const newBuffer = audioBuffer.slice(0, expectedSize);
            console.log(`🔧 已截断音频数据至 ${expectedSize} 字节`);
            return newBuffer;
        }
    }

    stopRecording() {
        this.isRecording = false;
        this.cleanupAudio();
        this.updateRecordingUI(false);
    }

    updateRecordingUI(isRecording) {
        if (isRecording) {
            this.startBtn.classList.add('btn-danger');
            this.btnText.textContent = '停止对话';
            this.connectionStatus.classList.add('recording');
        } else {
            this.startBtn.classList.remove('btn-danger');
            this.btnText.textContent = '开始对话';
            this.connectionStatus.classList.remove('recording');
            this.connectionStatus.style.borderColor = '';
        }
        this.startBtn.disabled = false;
    }

    showLoading(show) {
        const loadingElement = document.querySelector('.loading');
        if (loadingElement) {
            loadingElement.style.display = show ? 'inline-block' : 'none';
        }
    }

    handleRecordingError(error) {
        console.error('❌ 录音启动失败:', error);
        this.startBtn.disabled = false;
        this.showLoading(false);
        this.cleanupAudio();
        
        alert(`录音启动失败: ${error.message}\n请检查:\n1. 浏览器是否有麦克风权限\n2. 是否使用 HTTPS (某些浏览器要求)\n3. 音频设备是否可用`);
    }

    // ==================== 转录处理 ====================
    handleServerMessage(data) {
        const handlers = {
            'connection_established': () => this.handleConnectionEstablished(data),
            'tentative_output': () => this.handleTentativeOutput(data),
            'committed_output': () => this.handleCommittedOutput(data),
            'pong': () => console.log('🏓 收到服务器 pong 响应'),
            'debug_audio_info': () => console.log('📁 调试音频信息:', data),
            'connection_state': () => console.log('📁 链接状态信息:', data),
            'error': () => this.handleServerError(data),
            'vad_debug': () => this.updateVADStatusDisplay(data)
        };

        const handler = handlers[data.type] || (() => console.warn('❓ 未知服务器消息类型:', data.type, data));
        handler();
    }

    handleConnectionEstablished(data) {
        console.log('🎉 服务器确认连接:', data);
        if (data.configuration) {
            this.updateConfigFromServer(data.configuration);
        }
        console.log('✨ 服务器支持分层输出策略');
    }

    handleServerError(data) {
        console.error('❌ 服务器错误:', data);
        this.appendTranscript(`[服务器错误 ${data.code}] ${data.message || '未知错误'}`, true);
    }

    handleTentativeOutput(data) {
        const { text, start_chunk_id: startChunkId, end_chunk_id: endChunkId, timestamp } = data;
        
        if (!text?.trim() || startChunkId === undefined || endChunkId === undefined) {
            console.warn('⚠️ 无效的临时输出数据:', data);
            return;
        }
        
        this.clearTemporaryElement();
        
        // 创建新的临时元素
        const tentativeElement = document.createElement('span');
        tentativeElement.className = 'transcript-segment tentative-text';
        tentativeElement.textContent = text.trim() + '...';
        tentativeElement.dataset.startChunkId = startChunkId;
        tentativeElement.dataset.endChunkId = endChunkId;
        tentativeElement.dataset.timestamp = timestamp || Date.now();
        
        this.transcriptArea.appendChild(tentativeElement);
        this.currentTemporaryElement = tentativeElement;
        
        // 记录这些chunk已被处理
        for (let chunkId = startChunkId; chunkId <= endChunkId; chunkId++) {
            this.segments.set(chunkId, tentativeElement);
        }
        
        console.log(`⚡ 临时输出 [${startChunkId}-${endChunkId}]: "${text.trim()}"`);
        this.scrollToBottom();
    }

    handleCommittedOutput(data) {
        const { segment_id: segmentId, text, start_chunk_id: startChunkId, end_chunk_id: endChunkId } = data;
        
        if (!text?.trim() || startChunkId === undefined || endChunkId === undefined) {
            console.warn('⚠️ 无效的确认输出数据:', data);
            return;
        }
        
        // 1. 移除相关的临时元素
        this.removeTemporaryElementsForRange(startChunkId, endChunkId);
        
        // 2. 处理当前临时元素
        this.handleCurrentTemporaryElement(startChunkId, endChunkId);
        
        // 3. 创建/更新确认段
        this.createOrUpdateCommittedSegment(segmentId, text.trim(), startChunkId, endChunkId, data.timestamp);
        
        console.log(`✅ 确认输出 [${startChunkId}-${endChunkId}] (段 ${segmentId}): "${text.trim()}"`);
        this.scrollToBottom();
    }

    clearTemporaryElement() {
        if (this.currentTemporaryElement) {
            this.currentTemporaryElement.remove();
            this.currentTemporaryElement = null;
        }
    }

    removeTemporaryElementsForRange(startChunkId, endChunkId) {
        for (let chunkId = startChunkId; chunkId <= endChunkId; chunkId++) {
            if (this.segments.has(chunkId)) {
                const element = this.segments.get(chunkId);
                if (element?.classList.contains('tentative-text')) {
                    element.remove();
                    this.segments.delete(chunkId);
                }
            }
        }
    }

    handleCurrentTemporaryElement(startChunkId, endChunkId) {
        if (!this.currentTemporaryElement) return;
        
        const tempStart = parseInt(this.currentTemporaryElement.dataset.startChunkId);
        const tempEnd = parseInt(this.currentTemporaryElement.dataset.endChunkId);
        
        if (tempStart <= endChunkId && tempEnd >= startChunkId) {
            this.currentTemporaryElement.remove();
            this.currentTemporaryElement = null;
        }
    }

    createOrUpdateCommittedSegment(segmentId, text, startChunkId, endChunkId, timestamp) {
        let segmentElement = this.speechSegments.get(segmentId);
        
        if (!segmentElement) {
            segmentElement = document.createElement('span');
            segmentElement.id = `segment-${segmentId}`;
            segmentElement.className = 'transcript-segment committed-text';
            segmentElement.dataset.segmentId = segmentId;
            segmentElement.dataset.startChunkId = startChunkId;
            segmentElement.dataset.endChunkId = endChunkId;
            segmentElement.dataset.timestamp = timestamp || Date.now();
            
            this.transcriptArea.appendChild(segmentElement);
            this.speechSegments.set(segmentId, segmentElement);
            
            // 淡入动画
            this.animateElementFadeIn(segmentElement);
        }
        
        segmentElement.textContent = text;
        
        // 4. 记录这些chunk属于这个段
        for (let chunkId = startChunkId; chunkId <= endChunkId; chunkId++) {
            this.segments.set(chunkId, segmentElement);
        }
    }

    animateElementFadeIn(element) {
        element.style.opacity = '0';
        element.style.transform = 'translateY(5px)';
        setTimeout(() => {
            element.style.transition = 'all 0.3s ease';
            element.style.opacity = '1';
            element.style.transform = 'translateY(0)';
        }, 10);
    }

    // ==================== 工具方法 ====================
    scrollToBottom() {
        try {
            this.transcriptArea.scrollTo({
                top: this.transcriptArea.scrollHeight,
                behavior: 'smooth'
            });
        } catch (e) {
            console.warn('滚动到底部失败:', e);
            this.transcriptArea.scrollTop = this.transcriptArea.scrollHeight;
        }
    }

    updateVoiceLevelFromAudio(audioData) {
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
            sum += audioData[i] * audioData[i];
        }
        const rms = Math.sqrt(sum / audioData.length);
        const level = Math.min(1.0, rms * 5);
        this.updateVoiceLevel(level);
    }

    updateVoiceLevel(level) {
        const percent = Math.min(100, level * 100);
        this.voiceLevelFill.style.width = `${percent}%`;
        this.voiceLevelFill.style.backgroundColor = percent > 30 ? '#10b981' : '#9ca3af';
        
        if (this.isRecording) {
            this.connectionStatus.style.borderColor = percent > 30 ? '#10b981' : '#9ca3af';
        }
    }

    updateVADStatusDisplay(data) {
        if (!this.vadStatusDisplay) return;
        
        const statusText = `
            <strong>VAD状态:</strong><br>
            置信度: ${(data.confidence || 0).toFixed(3)}<br>
            语音状态: ${data.is_speech ? '🗣️ 语音活动' : '🔇 静音'}<br>
            平滑状态: ${data.smoothed_state ? '🗣️ 语音' : '🔇 静音'}<br>
            语音计数: ${data.speech_count || 0}<br>
            静音计数: ${data.silence_count || 0}<br>
            处理延迟: ${data.processing_time ? data.processing_time.toFixed(2) : 0}ms
        `;
        
        this.vadStatusDisplay.innerHTML = statusText;
    }

    updateConfigFromServer(config) {
        if (config.audio_chunk_duration_ms) {
            this.config.AUDIO_CHUNK_DURATION_MS = config.audio_chunk_duration_ms;
            console.log(`⚙️ 从服务器更新音频配置: ${this.config.AUDIO_CHUNK_DURATION_MS}ms/片段`);
        }
    }

    clearTranscript() {
        this.transcriptArea.innerHTML = '';
        this.clearTranscriptState();
        console.log('🧹 转录内容已清除');
    }

    clearTranscriptState() {
        this.segments.clear();
        this.speechSegments.clear();
        this.clearTemporaryElement();
    }

    // ==================== 消息发送 ====================
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

    sendPing() {
        this.sendClientMessage({ type: 'ping', timestamp: Date.now() });
    }

    sendGetState() {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
            console.warn('⚠️ WebSocket 未连接，无法发送状态查询');
            this.appendTranscript('WebSocket 未连接，无法获取状态', true);
            return;
        }
        
        const stateRequest = { type: 'get_state', timestamp: Date.now() };
        console.log('🔍 发送状态查询');
        this.sendClientMessage(stateRequest);
    }

    // ==================== VAD 配置 ====================
    async updateVADConfig(config) {
        try {
            const response = await fetch(`${this.config.apiBaseUrl}/vad/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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

    // ==================== 音频清理 ====================
    cleanupAudio() {
        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => {
                if (track.readyState === 'live') {
                    track.stop();
                }
            });
            this.mediaStream = null;
        }
        
        if (this.audioContext) {
            this.audioContext.close().catch(console.error);
            this.audioContext = null;
        }
    }

    // ==================== 重连逻辑 ====================
    attemptReconnect() {
        this.reconnectAttempts++;
        console.log(`🔄 尝试重新连接 (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
        this.updateConnectionStatus('connecting', `重新连接中 (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
        
        setTimeout(() => {
            this.setupWebSocket();
        }, this.config.reconnectDelay * this.reconnectAttempts);
    }

    // ==================== 资源清理 ====================
    cleanup() {
        this.stopRecording();
        this.closeWebSocket();
        this.cleanupAudio();
        this.clearTranscriptState();
        
        // 清理定时器
        this.clearAllIntervals();
        
        // 移除事件监听器
        this.removeAllEventListeners();
        
        console.log('🧹 RealTimeChat 资源清理完成');
    }

    clearAllIntervals() {
        this.clearIntervalSafe('pingInterval');
        this.clearIntervalSafe('heartbeatInterval');
        this.clearDebounceTimers();
    }

    clearIntervalSafe(timerName) {
        if (this[timerName]) {
            clearInterval(this[timerName]);
            this[timerName] = null;
        }
    }

    clearDebounceTimers() {
        if (this.debounceTimers) {
            Object.values(this.debounceTimers).forEach(timer => clearTimeout(timer));
            this.debounceTimers = {};
        }
    }

    removeAllEventListeners() {
        this.eventListeners.forEach(({ element, event, handler }) => {
            if (element && element.removeEventListener) {
                element.removeEventListener(event, handler);
            }
        });
        this.eventListeners.clear();
    }

    // ==================== 工具函数 ====================
    debounce(func, delay, key = 'default') {
        if (!this.debounceTimers) {
            this.debounceTimers = {};
        }
        
        if (this.debounceTimers[key]) {
            clearTimeout(this.debounceTimers[key]);
        }
        
        this.debounceTimers[key] = setTimeout(() => {
            func();
            delete this.debounceTimers[key];
        }, delay);
    }

    appendTranscript(text, isError = false) {
        const element = document.createElement('div');
        element.className = isError ? 'transcript-error' : 'transcript-info';
        element.textContent = text;
        Object.assign(element.style, {
            color: isError ? 'var(--danger)' : 'var(--gray)',
            fontSize: '0.9em',
            margin: '4px 0',
            padding: '4px 8px',
            borderRadius: '4px',
            backgroundColor: isError ? 'rgba(239, 68, 68, 0.1)' : 'rgba(156, 163, 175, 0.1)'
        });
        
        this.transcriptArea.appendChild(element);
        this.scrollToBottom();
    }
}

// ==================== 样式注入 ====================
RealTimeChat.injectStyles = () => {
    if (document.getElementById('realtime-chat-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'realtime-chat-styles';
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
    document.head.appendChild(style);
};

// 初始化样式
RealTimeChat.injectStyles();