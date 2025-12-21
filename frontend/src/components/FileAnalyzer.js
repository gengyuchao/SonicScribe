export class FileAnalyzer {
    constructor() {
        this.currentFile = null;
        this.abortController = null;
        this.isTranscribing = false;
        this.segmentsMap = new Map();
        this.receivedData = '';
        this.isCompressed = false;
        this.processedMessageIds = new Set(); // 用于跟踪已处理的消息ID
        this.isAborted = false;
        this.xhr = null;
        this.uploadStartTime = 0;

        this.initElements();
        this.initEvents();
    }

    $(id) {
        return document.getElementById(id);
    }

    initElements() {
        this.uploadArea = this.$('uploadArea');
        this.uploadLoading = this.$('uploadLoading');
        this.fileInfo = this.$('fileInfo');
        this.fileNameEl = this.$('fileName');
        this.fileSizeEl = this.$('fileSize');
        this.transcribeFileBtn = this.$('transcribeFileBtn');
        this.progressContainer = this.$('progressContainer');
        this.progressFill = this.$('progressFill');
        this.fileTranscript = this.$('fileTranscript');

        this.statusMessage = this.ensureElement('statusMessage', this.createStatusMessageElement.bind(this));
        this.stopTranscribeBtn = this.ensureElement('stopTranscribeBtn', this.createStopButtonElement.bind(this));
        this.summaryContainer = this.ensureElement('summaryContainer', this.createSummaryContainerElement.bind(this));
        this.combinedTranscript = this.ensureElement('combinedTranscript', this.createCombinedTranscriptElement.bind(this));
    }

    ensureElement(id, creator) {
        let el = this.$(id);
        if (!el) {
            el = creator();
            const ref = this.getInsertionRef(id);
            if (ref && ref.parentNode) {
                ref.parentNode.insertBefore(el, ref.nextSibling);
            } else {
                document.body.appendChild(el);
            }
        }
        return el;
    }

    getInsertionRef(id) {
        if (id === 'statusMessage') return this.progressContainer;
        if (id === 'stopTranscribeBtn') return this.transcribeFileBtn;
        if (id === 'summaryContainer') return this.fileTranscript;
        if (id === 'combinedTranscript') return this.summaryContainer;
        return this.fileTranscript;
    }

    createStatusMessageElement() {
        const el = document.createElement('div');
        el.id = 'statusMessage';
        el.className = 'status-message';
        Object.assign(el.style, {
            margin: '10px 0',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '14px'
        });
        return el;
    }

    createStopButtonElement() {
        const btn = document.createElement('button');
        btn.id = 'stopTranscribeBtn';
        btn.className = 'btn btn-danger';
        Object.assign(btn.style, {
            marginLeft: '10px',
            display: 'none'
        });
        btn.innerHTML = '⏹️ 停止处理';
        return btn;
    }

    createSummaryContainerElement() {
        const container = document.createElement('div');
        container.id = 'summaryContainer';
        Object.assign(container.style, {
            marginTop: '15px',
            display: 'none'
        });
        container.innerHTML = `
            <div class="summary-box" style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; margin-top: 15px;">
                <h3 style="margin-top: 0; color: #333; border-bottom: 2px solid #4361ee; padding-bottom: 8px;">处理摘要</h3>
                <div id="summaryContent" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 10px;"></div>
            </div>
        `;
        return container;
    }

    createCombinedTranscriptElement() {
        const container = document.createElement('div');
        container.id = 'combinedTranscript';
        Object.assign(container.style, {
            marginTop: '20px',
            display: 'none'
        });
        container.innerHTML = `
            <div class="combined-transcript" style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; margin-top: 15px;">
                <h3 style="margin-top: 0; color: #333; border-bottom: 2px solid #4361ee; padding-bottom: 8px;">完整转录结果</h3>
                <div id="combinedContent" class="transcript-content" style="line-height: 1.6; font-size: 1.1rem; min-height: 100px;"></div>
            </div>
        `;
        return container;
    }

    initEvents() {
        this.uploadArea.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'audio/*, .wav, .mp3, .m4a, .flac, .ogg';
            fileInput.onchange = (e) => {
                if (e.target.files.length > 0) {
                    this.handleFileSelect(e.target.files[0]);
                }
                fileInput.remove();
            };
            fileInput.click();
        });

        ['dragover', 'dragenter'].forEach(event => {
            this.uploadArea.addEventListener(event, (e) => {
                e.preventDefault();
                this.uploadArea.classList.add('dragover');
            });
        });

        this.uploadArea.addEventListener('dragleave', () => {
            this.uploadArea.classList.remove('dragover');
        });

        this.uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            this.uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) this.handleFileSelect(file);
        });

        this.transcribeFileBtn.addEventListener('click', () => this.startTranscription());
        if (this.stopTranscribeBtn) {
            this.stopTranscribeBtn.addEventListener('click', () => this.stopTranscription());
        }
    }

    setVisibility(el, visible) {
        if (el) el.style.display = visible ? 'block' : 'none';
    }

    clearPreviousResults() {
        this.fileTranscript.innerHTML = '文件转录结果将显示在这里...';
        this.fileTranscript.className = 'transcript-area';

        ['summaryContent', 'combinedContent'].forEach(id => {
            const el = this.$(id);
            if (el) el.innerHTML = '';
        });

        [this.summaryContainer, this.combinedTranscript].forEach(el => {
            this.setVisibility(el, false);
        });

        if (this.progressFill) this.progressFill.style.width = '0%';
        this.setVisibility(this.progressContainer, false);

        if (this.statusMessage) {
            this.statusMessage.textContent = '';
            this.statusMessage.removeAttribute('style');
        }

        this.segmentsMap.clear();
        this.receivedData = '';
        this.processedMessageIds.clear();
        this.isAborted = false;
    }

    handleFileSelect(file) {
        if (!file) return;

        const MAX_FILE_SIZE = 100 * 1024 * 1024;
        if (file.size > MAX_FILE_SIZE) {
            this.showStatus(`❌ 文件大小超过限制 (最大 100MB)，当前大小: ${this.formatFileSize(file.size)}`, 'error');
            return;
        }

        this.currentFile = file;
        this.displayFileInfo(file);
        this.transcribeFileBtn.disabled = false;
        this.clearPreviousResults();
        this.showStatus(`✅ 已选择文件: ${file.name}`, 'success');
    }

    displayFileInfo(file) {
        this.fileNameEl.textContent = file.name;
        this.fileSizeEl.textContent = this.formatFileSize(file.size);
        this.setVisibility(this.fileInfo, true);
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    showStatus(message, type = 'info') {
        if (!this.statusMessage || this.isAborted) return;

        this.statusMessage.textContent = message;

        const theme = {
            success: { bg: '#d4edda', color: '#155724', border: '#c3e6cb' },
            error: { bg: '#f8d7da', color: '#721c24', border: '#f5c6cb' },
            warning: { bg: '#fff3cd', color: '#856404', border: '#ffeeba' },
            info: { bg: '#d1ecf1', color: '#0c5460', border: '#bee5eb' }
        }[type] || theme.info;

        Object.assign(this.statusMessage.style, {
            backgroundColor: theme.bg,
            color: theme.color,
            border: `1px solid ${theme.border}`
        });

        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                if (this.statusMessage && this.statusMessage.textContent === message && !this.isTranscribing) {
                    this.statusMessage.textContent = '';
                    this.statusMessage.removeAttribute('style');
                }
            }, 3000);
        }
    }

    async compressAudioFile(file) {
        const shouldCompress = 
            (file.size > 10 * 1024 * 1024) &&
            (file.type.includes('wav') || file.name.toLowerCase().endsWith('.wav'));
        
        if (!shouldCompress) return file;

        try {
            this.showStatus('🔊 优化音频质量 (重采样到16kHz)...', 'info');
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            
            const offlineCtx = new OfflineAudioContext(
                1,
                Math.floor(audioBuffer.duration * 16000),
                16000
            );
            
            const source = offlineCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(offlineCtx.destination);
            source.start();
            
            const renderedBuffer = await offlineCtx.startRendering();
            const wavBlob = await this.bufferToWave(renderedBuffer, 16000);
            
            this.isCompressed = true;
            const compressedFile = new File(
                [wavBlob], 
                file.name.replace(/\.[^/.]+$/, "_16k.wav"),
                { type: 'audio/wav' }
            );
            
            this.showStatus(`✅ 音频已优化，体积减少 ${Math.round((1 - compressedFile.size/file.size) * 100)}%`, 'success');
            return compressedFile;
        } catch (error) {
            console.warn('音频压缩失败，使用原始文件:', error);
            this.showStatus('⚠️ 音频优化失败，使用原始文件', 'warning');
            return file;
        }
    }

    bufferToWave(buffer, sampleRate) {
        const numChannels = buffer.numberOfChannels;
        const length = buffer.length * numChannels * 2 + 44;
        const wav = new ArrayBuffer(length);
        const view = new DataView(wav);
        
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, length - 8, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 4, true);
        view.setUint16(32, numChannels * 2, true);
        view.setUint16(34, 16, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, length - 44, true);
        
        const channels = [];
        for (let i = 0; i < numChannels; i++) {
            channels.push(buffer.getChannelData(i));
        }
        
        let offset = 44;
        for (let i = 0; i < buffer.length; i++) {
            for (let c = 0; c < numChannels; c++) {
                const sample = Math.max(-1, Math.min(1, channels[c][i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                offset += 2;
            }
        }
        
        return new Blob([wav], { type: 'audio/wav' });
    }

    writeString(view, offset, str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    async startTranscription() {
        if (!this.currentFile) {
            this.showStatus('❌ 请先选择一个音频文件', 'error');
            return;
        }

        if (this.isTranscribing) {
            this.showStatus('⚠️ 处理中，请先停止当前任务', 'warning');
            return;
        }

        this.isTranscribing = true;
        this.isAborted = false;
        this.transcribeFileBtn.disabled = true;
        this.transcribeFileBtn.innerHTML = '<span class="loading" style="display: inline-block; margin-right: 8px;"></span><span>上传中...</span>';
        this.setVisibility(this.uploadLoading, true);
        this.resetUIForNewTranscription();
        this.uploadStartTime = Date.now();

        try {
            this.abortController = new AbortController();
            
            this.originalFile = this.currentFile;
            this.currentFile = await this.compressAudioFile(this.currentFile);
            
            const formData = new FormData();
            formData.append('file', this.currentFile);
            formData.append('stream', 'true');
            formData.append('vad_enabled', 'true');
            formData.append('original_filename', this.originalFile.name);

            this.receivedData = '';
            
            // 创建并保存XHR引用
            this.xhr = new XMLHttpRequest();
            this.xhr.open('POST', '/transcribe/file', true);
            
            // 绑定进度事件
            this.xhr.upload.onprogress = (e) => {
                if (this.isAborted || !this.isTranscribing) return;
                
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 50);
                    const speed = this.calculateUploadSpeed(e.loaded, Date.now() - this.uploadStartTime);
                    this.updateProgress(
                        percent, 
                        `📤 上传中: ${percent * 2}% | ${this.formatFileSize(e.loaded)}/${this.formatFileSize(e.total)} | ${speed}`
                    );
                }
            };
            
            // 流式处理响应
            this.xhr.onprogress = () => {
                if (this.isAborted || !this.isTranscribing) return;
                
                const chunk = this.xhr.responseText.substring(this.receivedData.length);
                this.processStreamData(chunk);
                this.receivedData = this.xhr.responseText; // 更新已处理的数据
            };
            
            // 上传完成回调
            this.xhr.onload = () => {
                if (this.isAborted) return;
                
                if (this.xhr.status >= 200 && this.xhr.status < 300) {
                    // 处理剩余数据
                    const remainingData = this.xhr.responseText.substring(this.receivedData.length);
                    if (remainingData) {
                        this.processStreamData(remainingData);
                    }
                    this.finalizeTranscription(true); // 标记为正常完成
                } else {
                    try {
                        const errorData = JSON.parse(this.xhr.responseText);
                        this.handleTranscriptionError(new Error(errorData?.detail || `HTTP错误: ${this.xhr.status}`));
                    } catch {
                        this.handleTranscriptionError(new Error(`请求失败: ${this.xhr.status}`));
                    }
                }
            };
            
            this.xhr.onerror = () => {
                if (!this.isAborted) {
                    this.handleTranscriptionError(new Error('网络错误，请检查连接'));
                }
            };
            
            this.xhr.onabort = () => {
                if (!this.isAborted) { // 只有在非主动中止的情况下才处理
                    this.handleTranscriptionError(new DOMException('上传已中止', 'AbortError'));
                }
            };
            
            // 绑定AbortController
            const abortSignal = this.abortController.signal;
            abortSignal.addEventListener('abort', () => {
                this.isAborted = true;
                if (this.xhr) {
                    this.xhr.abort();
                }
            });
            
            this.xhr.setRequestHeader('X-File-Size', this.currentFile.size.toString());
            if (this.isCompressed) {
                this.xhr.setRequestHeader('X-Original-File-Size', this.originalFile.size.toString());
            }
            
            // 开始上传
            this.xhr.send(formData);
            this.setVisibility(this.stopTranscribeBtn, true);

        } catch (error) {
            if (!this.isAborted) {
                console.error('上传失败:', error);
                this.handleTranscriptionError(error);
            }
        }
    }

    processStreamData(newData) {
        if (this.isAborted || !newData || !this.isTranscribing) return;
        
        // 将新数据分割成行
        const lines = newData.split('\n');
        let currentLine = '';
        
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            
            try {
                // 尝试解析JSON
                const result = JSON.parse(line);
                
                // 生成唯一消息ID避免重复处理
                const messageId = result.message_id || 
                                (result.type === 'segment_result' ? `seg-${result.segment_index}-${result.sub_segment_index || 0}` : null) ||
                                `${result.type}-${Date.now()}`;
                
                // 检查是否已处理过此消息
                if (!this.processedMessageIds.has(messageId)) {
                    this.processedMessageIds.add(messageId);
                    this.handleStreamMessage(result);
                }
            } catch (e) {
                // 可能是不完整的JSON，累积到下一次处理
                if (line.startsWith('{') && !line.endsWith('}')) {
                    currentLine = line;
                } else if (currentLine && !line.endsWith('}')) {
                    currentLine += line;
                } else if (currentLine && line.endsWith('}')) {
                    currentLine += line;
                    try {
                        const result = JSON.parse(currentLine);
                        const messageId = result.message_id || `${result.type}-${Date.now()}`;
                        if (!this.processedMessageIds.has(messageId)) {
                            this.processedMessageIds.add(messageId);
                            this.handleStreamMessage(result);
                        }
                        currentLine = '';
                    } catch (err) {
                        console.warn('处理不完整JSON失败:', currentLine, err);
                        currentLine = '';
                    }
                } else {
                    console.debug('跳过非JSON行:', line);
                }
            }
        }
    }

    calculateUploadSpeed(bytes, durationMs) {
        if (durationMs < 100) return '';
        const speed = bytes / (durationMs / 1000);
        if (speed > 1024 * 1024) return `速度: ${(speed / (1024 * 1024)).toFixed(1)} MB/s`;
        if (speed > 1024) return `速度: ${(speed / 1024).toFixed(1)} KB/s`;
        return `速度: ${speed.toFixed(0)} B/s`;
    }

    handleStreamMessage(result) {
        if (this.isAborted || !this.isTranscribing) return;
        
        switch (result.type) {
            case 'initialization':
                this.handleInitialization(result);
                break;
            case 'segments_summary':
                this.handleSegmentsSummary(result);
                break;
            case 'segment_result':
                this.handleSegmentResult(result);
                break;
            case 'segment_error':
                this.handleSegmentError(result);
                break;
            case 'final_summary':
                this.handleFinalSummary(result);
                break;
            default:
                console.warn('未知消息类型:', result.type);
        }
    }

    handleTranscriptionError(error) {
        this.isAborted = true;
        
        if (error.name === 'AbortError' || error.message.includes('中止')) {
            this.showStatus('⏹️ 处理已停止', 'warning');
        } else {
            this.showStatus(`❌ 处理失败: ${error.message}`, 'error');
            this.fileTranscript.innerHTML = `
                <div style="padding: 20px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;">
                    <h3 style="color: #ef4444; margin-top: 0;">处理失败</h3>
                    <p style="color: #b91c1c; margin: 10px 0;">${error.message}</p>
                    <p style="color: #6b7280; font-size: 0.9em;">
                        建议：尝试<a href="#" onclick="event.preventDefault(); document.getElementById('uploadArea').click()" style="color:#3b82f6; text-decoration:underline">重新上传</a> 或 <a href="#" onclick="event.preventDefault(); location.reload()" style="color:#3b82f6; text-decoration:underline">刷新页面</a>
                    </p>
                </div>
            `;
            this.fileTranscript.classList.remove('processing');
        }
        
        this.finalizeTranscription(false); // 标记为异常完成
    }

    finalizeTranscription(isSuccess = true) {
        // 确保只调用一次
        if (!this.isTranscribing) return;
        
        this.isTranscribing = false;
        this.isAborted = true; // 确保不再处理新数据
        
        // 确保进度条更新到100%
        this.updateProgress(100, isSuccess ? '处理完成' : '处理已停止');
        
        // 更新UI状态
        this.transcribeFileBtn.disabled = false;
        this.transcribeFileBtn.innerHTML = '<span>开始转文字</span>';
        this.setVisibility(this.uploadLoading, false);
        this.setVisibility(this.stopTranscribeBtn, false);
        
        // 显示优化提示
        if (this.isCompressed && isSuccess) {
            this.showStatus(`💡 提示: 音频已优化 (${this.formatFileSize(this.originalFile.size)} → ${this.formatFileSize(this.currentFile.size)})`, 'info');
        }
        
        this.fileTranscript.scrollIntoView({ behavior: 'smooth' });
    }

    resetUIForNewTranscription() {
        this.clearPreviousResults();
        this.setVisibility(this.progressContainer, true);
        
        this.fileTranscript.innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <div class="loading" style="display: inline-block; margin-bottom: 15px;"></div>
                <div style="font-size: 1.2rem; font-weight: 500; color: #374151;">
                    准备开始处理...
                </div>
                <div id="uploadSpeedInfo" style="font-size: 0.9rem; color: #6b7280; margin-top: 8px;"></div>
            </div>
        `;
        this.fileTranscript.classList.add('processing');
        this.setVisibility(this.stopTranscribeBtn, true);
        this.setVisibility(this.summaryContainer, true);
    }

    updateProgress(percent, message = '') {
        // 确保进度不超过100%
        const displayPercent = Math.min(100, percent);
        
        if (this.progressFill) {
            this.progressFill.style.width = `${displayPercent}%`;
            // 根据进度阶段选择不同颜色
            if (displayPercent <= 50) {
                // 上传阶段 - 蓝色
                this.progressFill.style.background = 'linear-gradient(90deg, #3b82f6 0%, #60a5fa 100%)';
            } else if (displayPercent < 100) {
                // 处理阶段 - 绿色
                this.progressFill.style.background = 'linear-gradient(90deg, #10b981 0%, #34d399 100%)';
            } else {
                // 完成阶段 - 深绿色
                this.progressFill.style.background = 'linear-gradient(90deg, #059669 0%, #047857 100%)';
            }
        }
        
        // 更新状态消息
        if (message.includes('速度:')) {
            const speedEl = this.fileTranscript.querySelector('#uploadSpeedInfo');
            if (speedEl) speedEl.textContent = message;
        } else if (message && !this.isAborted) {
            this.showStatus(message, 'info');
        }
    }

    addSummaryInfo(summary) {
        const summaryContent = this.$('summaryContent');
        if (!summaryContent) return;

        summaryContent.innerHTML = '';

        const summaryItems = [
            { label: '总时长', value: `${summary.total_duration}s` },
            { label: '总段数', value: summary.total_segments },
            { label: '成功段数', value: summary.successful_segments },
            { label: '失败段数', value: summary.failed_segments }
        ];

        if (summary.long_segments_count > 0) {
            summaryItems.push({ label: '长段数量', value: summary.long_segments_count });
        }

        if (summary.total_processing_time) {
            summaryItems.push({ label: '总处理时间', value: `${summary.total_processing_time.toFixed(2)}s` });
        }

        summaryItems.forEach(item => {
            const itemDiv = document.createElement('div');
            Object.assign(itemDiv.style, {
                backgroundColor: '#f8fafc',
                padding: '10px',
                borderRadius: '8px',
                border: '1px solid #e2e8f0'
            });
            itemDiv.innerHTML = `
                <div style="font-size: 0.85em; color: #6b7280; margin-bottom: 4px;">${item.label}</div>
                <div style="font-weight: bold; font-size: 1.1em; color: #1f2937;">${item.value}</div>
            `;
            summaryContent.appendChild(itemDiv);
        });

        this.setVisibility(this.summaryContainer, true);
    }

    appendToCombinedTranscript(text, segmentInfo = null) {
        if (!text?.trim() || this.isAborted) return;
        
        const combinedContent = this.$('combinedContent');
        if (!combinedContent) return;

        // 计算语音长度
        let duration = 0;
        if (segmentInfo && segmentInfo.start_time !== undefined && segmentInfo.end_time !== undefined) {
            duration = (segmentInfo.end_time - segmentInfo.start_time).toFixed(2);
        }

        let segmentHtml = '';
        
        // 长段特殊样式
        if (segmentInfo && segmentInfo.is_long_segment) {
            segmentHtml = `
                <div class="long-segment-container" style="margin: 20px 0; border: 2px solid #f59e0b; border-radius: 12px; overflow: hidden; box-shadow: 0 3px 10px rgba(245, 158, 11, 0.2);">
                    <div style="background: linear-gradient(to right, #fffbeb 0%, #fef3c7 100%); padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #fed7aa;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="background: #f59e0b; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0; font-size: 1.1rem;">🔊</span>
                            <strong style="color: #854d0e; font-size: 1.15rem; font-weight: 600;">长语音段 #${segmentInfo.segment_index}</strong>
                        </div>
                        <span style="background: #fef3c7; color: #854d0e; padding: 4px 12px; border-radius: 20px; font-weight: 600; font-size: 1rem; min-width: 70px; text-align: center;">
                            ${duration}s
                        </span>
                    </div>
                    <div style="padding: 18px; background: white;">
                        <div style="line-height: 1.7; font-size: 1.15rem; color: #1f2937; margin-bottom: 10px; font-weight: 500;">${text}</div>
                        <div style="font-size: 0.88em; color: #854d0e; display: flex; justify-content: space-between; padding-top: 8px; border-top: 1px solid #fef3c7;">
                            <span style="font-weight: 500;">⏱️ 时间范围: [${segmentInfo.start_time.toFixed(2)}s - ${segmentInfo.end_time.toFixed(2)}s]</span>
                        </div>
                    </div>
                </div>
            `;
        } 
        // 普通段落样式
        else if (segmentInfo) {
            segmentHtml = `
                <div class="transcript-paragraph" style="margin: 16px 0; padding: 14px 18px; border-radius: 10px; background: #f8fafc; border-left: 4px solid #3b82f6; box-shadow: 0 2px 5px rgba(0,0,0,0.03);">
                    <div style="display: flex; justify-content: space-between; font-size: 0.88em; color: #374151; margin-bottom: 10px; font-weight: 500;">
                        <span>段 #${segmentInfo.segment_index}</span>
                        <span style="background: #dbeafe; color: #1e40af; padding: 3px 10px; border-radius: 15px; font-weight: 600;">
                            ${duration}s
                        </span>
                    </div>
                    <div style="line-height: 1.65; font-size: 1.08rem; color: #1e293b; font-weight: 500;">${text}</div>
                    <div style="font-size: 0.83em; color: #4b5563; margin-top: 8px; display: flex; justify-content: space-between; padding-top: 6px; border-top: 1px dashed #bfdbfe;">
                        <span>🕒 [${segmentInfo.start_time.toFixed(2)}s - ${segmentInfo.end_time.toFixed(2)}s]</span>
                    </div>
                </div>
            `;
        } 
        // 无信息的普通文本
        else {
            segmentHtml = `<div style="margin: 16px 0; line-height: 1.65; font-size: 1.08rem;">${text}</div>`;
        }

        combinedContent.insertAdjacentHTML('beforeend', segmentHtml);
        combinedContent.scrollTop = combinedContent.scrollHeight;
        this.setVisibility(this.combinedTranscript, true);
    }

    stopTranscription() {
        if (this.isTranscribing && !this.isAborted) {
            this.isAborted = true;
            if (this.abortController) {
                this.abortController.abort();
            }
            this.showStatus('⏹️ 正在停止处理...', 'warning');
            this.setVisibility(this.stopTranscribeBtn, false);
        }
    }

    handleInitialization(result) {
        if (this.isAborted) return;
        
        this.fileNameEl.textContent = result.filename;
        this.fileSizeEl.textContent = this.formatFileSize(result.file_size);
        this.updateProgress(5, `准备处理 ${result.total_segments} 个语音段...`);
        this.showStatus(`初始化完成: ${result.filename} (${this.formatFileSize(result.file_size)})`, 'info');
    }

    handleSegmentsSummary(result) {
        if (self.isAborted) return;
        
        this.showStatus(`🎯 检测到 ${result.total_segments} 个语音段，开始转录...`, 'info');
        this.updateProgress(10, `开始处理 ${result.total_segments} 个段`);
    }

    handleSegmentResult(result) {
        if (this.isAborted) return;
        
        // 更新进度，限制在50-99%之间
        const progressPercent = Math.min(99, 50 + (result.progress * 0.49));
        this.updateProgress(progressPercent, `处理中: 段 #${result.segment_index}/${result.total_segments}`);
        
        if (result.text && result.text.trim()) {
            this.showStatus(
                `✅ 段 #${result.segment_index}: ${result.text?.slice(0, 30)}${(result.text?.length > 30) ? '...' : ''}`,
                'success'
            );
        }

        // 长段落处理
        if (result.is_long_segment) {
            const key = `long-${result.original_index}`;
            
            if (!this.segmentsMap.has(key)) {
                this.segmentsMap.set(key, {
                    segments: [],
                    totalSubSegments: result.sub_segment_count || 0,
                    originalIndex: result.original_index,
                    start_time: result.start_time,
                    end_time: result.end_time
                });
            }
            
            const longSegmentData = this.segmentsMap.get(key);
            
            // 添加子段，避免重复
            const existingSegment = longSegmentData.segments.find(s => s.sub_segment_index === result.sub_segment_index);
            if (!existingSegment) {
                longSegmentData.segments.push({
                    sub_segment_index: result.sub_segment_index,
                    text: result.text || '',
                    start_time: result.start_time,
                    end_time: result.end_time
                });
                
                // 更新结束时间
                if (result.end_time > longSegmentData.end_time) {
                    longSegmentData.end_time = result.end_time;
                }
            }
            
            // 检查是否所有子段都已收到
            if (longSegmentData.segments.length >= longSegmentData.totalSubSegments) {
                // 按子段索引排序
                longSegmentData.segments.sort((a, b) => a.sub_segment_index - b.sub_segment_index);
                
                // 合并文本
                const combinedText = longSegmentData.segments.map(s => s.text.trim()).filter(t => t).join(' ').trim();
                
                if (combinedText) {
                    this.appendToCombinedTranscript(combinedText, {
                        segment_index: result.original_index,
                        start_time: longSegmentData.start_time,
                        end_time: longSegmentData.end_time,
                        is_long_segment: true
                    });
                }
                
                // 清理
                this.segmentsMap.delete(key);
            }
        } else {
            // 普通段落
            this.appendToCombinedTranscript(result.text || '（无文本）', {
                segment_index: result.segment_index,
                start_time: result.start_time,
                end_time: result.end_time
            });
        }
    }

    handleSegmentError(result) {
        if (this.isAborted) return;
        
        this.showStatus(`❌ 段 #${result.segment_index} 失败: ${result.error}`, 'error');
    }

    handleFinalSummary(result) {
        if (this.isAborted) return;
        
        this.showStatus('✅ 所有段处理完成！', 'success');
        this.updateProgress(99, '整理结果中...');

        this.addSummaryInfo({
            total_duration: result.total_duration,
            total_segments: result.total_segments,
            successful_segments: result.successful_segments || result.total_segments,
            failed_segments: result.failed_segments || 0,
            long_segments_count: result.long_segments_count || 0,
            total_processing_time: result.total_processing_time || 0
        });

        this.fileTranscript.innerHTML = `
            <div style="padding: 25px; text-align: center; background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border-radius: 16px; border: 1px solid #bbf7d0;">
                <div style="font-size: 4rem; margin-bottom: 15px; color: #10b981;">✓</div>
                <h2 style="color: #065f46; margin-bottom: 12px; font-size: 1.8rem;">转录已完成</h2>
                <p style="font-size: 1.1rem; color: #166534; margin-bottom: 20px;">
                    完整转录结果和处理摘要已在下方显示
                </p>
                <button onclick="document.getElementById('combinedTranscript').scrollIntoView({behavior: 'smooth'})" 
                        style="margin-top: 12px; background: #10b981; color: white; border: none; padding: 10px 28px; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 1.05rem; transition: all 0.2s; box-shadow: 0 3px 8px rgba(16, 185, 129, 0.4);">
                        查看完整转录
                </button>
            </div>
        `;
        this.fileTranscript.classList.remove('processing');
        
        this.showStatus(`🎉 转录完成！${(result.successful_segments || result.total_segments)}/${result.total_segments} 段成功`, 'success');
        
        // 异步更新进度条到100%
        setTimeout(() => {
            if (!this.isAborted) {
                this.updateProgress(100, '处理完成');
                this.finalizeTranscription(true);
            }
        }, 500);
    }
}