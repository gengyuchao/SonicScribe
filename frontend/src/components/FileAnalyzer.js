export class FileAnalyzer {
    constructor() {
        this.initializeState();
        this.initializeUI();
        this.bindEvents();
    }

    initializeState() {
        this.currentFile = null;
        this.originalFile = null;
        this.abortController = null;
        this.isTranscribing = false;
        this.isAborted = false;
        this.isCompressed = false;
        this.uploadStartTime = 0;
        this.receivedData = '';
        this.xhr = null;
        
        this.segmentsMap = new Map();
        this.processedMessageIds = new Set();
        
        this.elements = {};
        this.theme = {
            success: { bg: '#d4edda', color: '#155724', border: '#c3e6cb' },
            error: { bg: '#f8d7da', color: '#721c24', border: '#f5c6cb' },
            warning: { bg: '#fff3cd', color: '#856404', border: '#ffeeba' },
            info: { bg: '#d1ecf1', color: '#0c5460', border: '#bee5eb' }
        };
    }

    initializeUI() {
        this.cacheElements();
        this.createDynamicElements();
        this.injectBaseStyles();
    }

    injectBaseStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* 基础样式 */
            :root {
                --primary-color: #3b82f6;
                --primary-dark: #2563eb;
                --success-color: #10b981;
                --success-dark: #059669;
                --warning-color: #f59e0b;
                --warning-dark: #d97706;
                --error-color: #ef4444;
                --error-dark: #dc2626;
                --gray-100: #f3f4f6;
                --gray-200: #e5e7eb;
                --gray-300: #d1d5db;
                --gray-400: #9ca3af;
                --gray-500: #6b7280;
                --gray-600: #4b5563;
                --gray-700: #374151;
                --gray-800: #1f2937;
                --gray-900: #0f172a;
                --white: #ffffff;
                --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
                --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
                --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
                --rounded-sm: 0.125rem;
                --rounded: 0.25rem;
                --rounded-md: 0.375rem;
                --rounded-lg: 0.5rem;
                --rounded-xl: 0.75rem;
                --rounded-2xl: 1rem;
                --rounded-full: 9999px;
                --transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            }
            
            /* 按钮美化 */
            .action-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                padding: 8px 16px;
                border-radius: var(--rounded-md);
                font-weight: 600;
                font-size: 0.95rem;
                cursor: pointer;
                transition: var(--transition);
                border: none;
                box-shadow: var(--shadow-sm);
            }
            
            .start-btn {
                background: linear-gradient(135deg, var(--primary-color), var(--primary-dark));
                color: white;
                min-width: 120px;
            }
            
            .start-btn:hover:not(:disabled) {
                background: linear-gradient(135deg, var(--primary-dark), #1d4ed8);
                transform: translateY(-1px);
                box-shadow: var(--shadow);
            }
            
            .start-btn:disabled {
                opacity: 0.7;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            
            .stop-btn {
                background: linear-gradient(135deg, var(--error-color), var(--error-dark));
                color: white;
                min-width: 100px;
            }
            
            .stop-btn:hover {
                background: linear-gradient(135deg, var(--error-dark), #b91c1c);
                transform: translateY(-1px);
                box-shadow: var(--shadow);
            }
            
            /* 转录内容重新设计 - 避免重叠 */
            .transcript-container {
                min-height: 400px;
                max-height: 600px;
                overflow-y: auto;
                padding: 12px;
                background: var(--white);
                border-radius: var(--rounded-lg);
                border: 1px solid var(--gray-200);
                box-shadow: var(--shadow-sm);
            }
            
            .transcript-line {
                position: relative;
                padding: 12px 16px;
                margin: 8px 0;
                border-radius: var(--rounded-md);
                background: var(--gray-100);
                transition: var(--transition);
                border-left: 3px solid var(--primary-color);
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            
            .transcript-line:hover {
                background: #dbeafe;
                transform: translateX(2px);
                border-left-width: 4px;
            }
            
            .line-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 0.85rem;
                color: var(--gray-600);
            }
            
            .segment-index {
                background: var(--primary-color);
                color: white;
                font-size: 0.8rem;
                font-weight: 600;
                padding: 2px 8px;
                border-radius: var(--rounded-full);
                min-width: 40px;
                text-align: center;
            }
            
            .audio-position {
                font-family: monospace;
                color: var(--gray-700);
                font-weight: 500;
            }
            
            .segment-duration {
                background: var(--primary-color);
                color: white;
                font-size: 0.75rem;
                padding: 1px 6px;
                border-radius: var(--rounded-full);
                margin-left: 8px;
            }
            
            .segment-content {
                font-size: 1.05rem;
                line-height: 1.5;
                color: var(--gray-800);
                font-weight: 500;
                word-break: break-word;
            }
            
            /* 长段落设计 */
            .long-segment-line {
                position: relative;
                padding: 12px 16px;
                margin: 8px 0;
                border-radius: var(--rounded-md);
                background: #fffbeb;
                border-left: 3px solid var(--warning-color);
                transition: var(--transition);
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            
            .long-segment-line:hover {
                background: #fef3c7;
                transform: translateX(2px);
                border-left-width: 4px;
            }
            
            .long-segment-index {
                background: var(--warning-color);
                color: white;
                font-size: 0.8rem;
                font-weight: 600;
                padding: 2px 8px;
                border-radius: var(--rounded-full);
                min-width: 60px;
                text-align: center;
            }
            
            .long-audio-position {
                font-family: monospace;
                color: var(--warning-dark);
                font-weight: 500;
            }
            
            .long-segment-duration {
                background: var(--warning-color);
                color: white;
                font-size: 0.75rem;
                padding: 1px 6px;
                border-radius: var(--rounded-full);
                margin-left: 8px;
            }
            
            .long-segment-content {
                font-size: 1.05rem;
                line-height: 1.5;
                color: var(--gray-800);
                font-weight: 500;
                word-break: break-word;
            }
            
            /* 正在转录区域 */
            .processing-container {
                min-height: 250px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
                border-radius: var(--rounded-xl);
                padding: 30px;
                text-align: center;
                border: 2px solid var(--primary-color);
            }
            
            .processing-icon {
                font-size: 3.5rem;
                color: var(--primary-color);
                margin-bottom: 20px;
                animation: pulse 2s infinite;
            }
            
            .processing-title {
                font-size: 1.8rem;
                font-weight: 700;
                color: var(--primary-dark);
                margin-bottom: 12px;
            }
            
            .processing-subtitle {
                font-size: 1.2rem;
                color: var(--gray-700);
                margin-bottom: 25px;
                line-height: 1.6;
            }
            
            .upload-speed {
                font-size: 1.1rem;
                font-weight: 500;
                color: var(--gray-800);
                background: rgba(255, 255, 255, 0.8);
                padding: 8px 20px;
                border-radius: var(--rounded-full);
                margin-top: 15px;
                min-width: 300px;
            }
            
            /* 摘要信息 */
            .summary-container {
                margin: 15px 0;
            }
            
            .summary-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                gap: 10px;
                margin-top: 10px;
            }
            
            .summary-card {
                background: var(--white);
                border: 1px solid var(--gray-200);
                border-radius: var(--rounded-lg);
                padding: 12px;
                text-align: center;
                transition: var(--transition);
                box-shadow: var(--shadow-sm);
            }
            
            .summary-card:hover {
                transform: translateY(-2px);
                box-shadow: var(--shadow);
                border-color: var(--primary-color);
            }
            
            .summary-label {
                font-size: 0.85rem;
                color: var(--gray-500);
                margin-bottom: 4px;
                font-weight: 500;
            }
            
            .summary-value {
                font-size: 1.25rem;
                font-weight: 700;
                color: var(--primary-color);
            }
            
            /* 完成界面 */
            .completion-container {
                padding: 30px;
                text-align: center;
                background: linear-gradient(135deg, #dcfce7 0%, #bef264 100%);
                border-radius: var(--rounded-2xl);
                border: 2px solid var(--success-color);
            }
            
            .completion-icon {
                font-size: 4rem;
                color: var(--success-color);
                margin-bottom: 20px;
                animation: bounce 1s ease;
            }
            
            .completion-title {
                font-size: 2rem;
                font-weight: 800;
                color: var(--success-dark);
                margin-bottom: 15px;
                background: linear-gradient(to right, var(--success-dark), var(--success-color));
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }
            
            .completion-text {
                font-size: 1.25rem;
                color: var(--gray-800);
                margin-bottom: 25px;
                line-height: 1.6;
                font-weight: 500;
            }
            
            .view-btn {
                background: linear-gradient(135deg, var(--success-color), var(--success-dark));
                color: white;
                padding: 12px 32px;
                font-size: 1.1rem;
                font-weight: 600;
                border-radius: var(--rounded-full);
                border: none;
                cursor: pointer;
                transition: var(--transition);
                box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
            }
            
            .view-btn:hover {
                background: linear-gradient(135deg, var(--success-dark), #047857);
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(16, 185, 129, 0.6);
            }
            
            /* 动画效果 */
            @keyframes pulse {
                0% { opacity: 1; }
                50% { opacity: 0.7; }
                100% { opacity: 1; }
            }
            
            @keyframes bounce {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-10px); }
            }
            
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            
            /* 滚动条美化 */
            .transcript-container::-webkit-scrollbar {
                width: 8px;
            }
            
            .transcript-container::-webkit-scrollbar-track {
                background: var(--gray-100);
                border-radius: var(--rounded-full);
            }
            
            .transcript-container::-webkit-scrollbar-thumb {
                background: var(--primary-color);
                border-radius: var(--rounded-full);
                transition: var(--transition);
            }
            
            .transcript-container::-webkit-scrollbar-thumb:hover {
                background: var(--primary-dark);
            }
            
            /* 状态消息 */
            .status-bar {
                padding: 10px;
                border-radius: var(--rounded-lg);
                font-weight: 500;
                margin: 10px 0;
                animation: fadeIn 0.3s ease;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            /* 加载指示器 */
            .loading-spinner {
                display: inline-block;
                width: 20px;
                height: 20px;
                border: 2px solid white;
                border-top: 2px solid transparent;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
        `;
        document.head.appendChild(style);
    }

    cacheElements() {
        const elementIds = [
            'uploadArea', 'uploadLoading', 'fileInfo', 'fileName', 'fileSize',
            'transcribeFileBtn', 'progressContainer', 'progressFill', 'fileTranscript'
        ];
        
        elementIds.forEach(id => {
            this.elements[id] = document.getElementById(id);
        });
    }

    createDynamicElements() {
        const dynamicElements = [
            { id: 'statusMessage', creator: this.createStatusMessageElement.bind(this), ref: 'progressContainer' },
            { id: 'stopTranscribeBtn', creator: this.createStopButtonElement.bind(this), ref: 'transcribeFileBtn' },
            { id: 'summaryContainer', creator: this.createSummaryContainerElement.bind(this), ref: 'fileTranscript' },
            { id: 'combinedTranscript', creator: this.createCombinedTranscriptElement.bind(this), ref: 'summaryContainer' }
        ];

        dynamicElements.forEach(({ id, creator, ref }) => {
            let el = document.getElementById(id);
            if (!el) {
                el = creator();
                const refElement = this.elements[ref] || document.body;
                if (refElement.parentNode) {
                    refElement.parentNode.insertBefore(el, refElement.nextSibling);
                } else {
                    document.body.appendChild(el);
                }
            }
            this.elements[id] = el;
        });
    }

    createStatusMessageElement() {
        const el = document.createElement('div');
        el.id = 'statusMessage';
        el.className = 'status-bar';
        return el;
    }

    createStopButtonElement() {
        const btn = document.createElement('button');
        btn.id = 'stopTranscribeBtn';
        btn.className = 'action-btn stop-btn';
        Object.assign(btn.style, {
            marginLeft: '12px',
            display: 'none'
        });
        btn.innerHTML = '<span>⏹️</span> <span>停止</span>';
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
            <div class="summary-container">
                <h3 style="margin: 0 0 10px 0; color: var(--gray-800); border-bottom: 2px solid var(--primary-color); padding-bottom: 6px; font-size: 1.4rem; font-weight: 700;">处理摘要</h3>
                <div id="summaryContent" class="summary-grid"></div>
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
            <div class="combined-transcript">
                <h3 style="margin: 0 0 12px 0; color: var(--gray-800); border-bottom: 2px solid var(--primary-color); padding-bottom: 6px; font-size: 1.4rem; font-weight: 700;">完整转录结果</h3>
                <div id="combinedContent" class="transcript-container"></div>
            </div>
        `;
        return container;
    }

    bindEvents() {
        this.setupFileUploadEvents();
        this.setupTranscriptionEvents();
    }

    setupFileUploadEvents() {
        const { uploadArea } = this.elements;
        
        uploadArea.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'audio/*, .wav, .mp3, .m4a, .flac, .ogg';
            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (file) this.handleFileSelect(file);
                fileInput.remove();
            };
            fileInput.click();
        });

        ['dragover', 'dragenter'].forEach(event => {
            uploadArea.addEventListener(event, (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            });
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) this.handleFileSelect(file);
        });
    }

    setupTranscriptionEvents() {
        const { transcribeFileBtn, stopTranscribeBtn } = this.elements;
        
        if (transcribeFileBtn) {
            transcribeFileBtn.addEventListener('click', () => this.startTranscription());
        }
        
        if (stopTranscribeBtn) {
            stopTranscribeBtn.addEventListener('click', () => this.stopTranscription());
        }
    }

    getElement(id) {
        return this.elements[id];
    }

    setVisibility(element, visible) {
        if (!element) return;
        element.style.display = visible ? 'block' : 'none';
    }

    clearPreviousResults() {
        const { fileTranscript, progressFill, statusMessage } = this.elements;
        
        if (fileTranscript) {
            fileTranscript.innerHTML = '文件转录结果将显示在这里...';
            fileTranscript.className = 'transcript-area';
        }

        ['summaryContent', 'combinedContent'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });

        [this.elements.summaryContainer, this.elements.combinedTranscript].forEach(el => {
            this.setVisibility(el, false);
        });

        if (progressFill) progressFill.style.width = '0%';
        this.setVisibility(this.elements.progressContainer, false);

        if (statusMessage) {
            statusMessage.textContent = '';
            statusMessage.removeAttribute('style');
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
        this.elements.transcribeFileBtn.disabled = false;
        this.clearPreviousResults();
        this.showStatus(`✅ 已选择文件: ${file.name}`, 'success');
    }

    displayFileInfo(file) {
        const { fileName, fileSize } = this.elements;
        if (fileName) fileName.textContent = file.name;
        if (fileSize) fileSize.textContent = this.formatFileSize(file.size);
        this.setVisibility(this.elements.fileInfo, true);
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    showStatus(message, type = 'info') {
        const { statusMessage } = this.elements;
        if (!statusMessage || this.isAborted) return;

        statusMessage.textContent = message;
        const theme = this.theme[type] || this.theme.info;

        Object.assign(statusMessage.style, {
            backgroundColor: theme.bg,
            color: theme.color,
            border: `1px solid ${theme.border}`
        });

        if (type === 'success' || type === 'info') {
            setTimeout(() => {
                if (statusMessage && statusMessage.textContent === message && !this.isTranscribing) {
                    statusMessage.textContent = '';
                    statusMessage.removeAttribute('style');
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
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) {
                throw new Error('浏览器不支持音频处理');
            }

            const audioCtx = new AudioContext();
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
        // 确保清理之前的请求
        this.cleanupPreviousRequest();
        
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
        this.transcribeFileBtn.innerHTML = '<span class="loading-spinner"></span><span>上传中...</span>';
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
            
            this.xhr = new XMLHttpRequest();
            this.xhr.open('POST', '/transcribe/file', true);
            
            // 设置超时
            this.xhr.timeout = 300000; // 5分钟
            
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
            
            this.xhr.onprogress = () => {
                if (this.isAborted || !this.isTranscribing) return;
                
                const chunk = this.xhr.responseText.substring(this.receivedData.length);
                this.processStreamData(chunk);
                this.receivedData = this.xhr.responseText;
            };
            
            this.xhr.onload = () => {
                if (this.isAborted) return;
                
                if (this.xhr.status >= 200 && this.xhr.status < 300) {
                    const remainingData = this.xhr.responseText.substring(this.receivedData.length);
                    if (remainingData) {
                        this.processStreamData(remainingData);
                    }
                    this.finalizeTranscription(true);
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
                if (!this.isAborted) {
                    this.handleTranscriptionError(new Error('上传已中止'));
                }
            };
            
            this.xhr.ontimeout = () => {
                if (!this.isAborted) {
                    this.handleTranscriptionError(new Error('请求超时，请重试'));
                }
            };
            
            const abortSignal = this.abortController.signal;
            abortSignal.addEventListener('abort', () => {
                this.isAborted = true;
                if (this.xhr) {
                    this.xhr.abort();
                }
                this.handleAbortCleanup();
            });
            
            this.xhr.setRequestHeader('X-File-Size', this.currentFile.size.toString());
            if (this.isCompressed) {
                this.xhr.setRequestHeader('X-Original-File-Size', this.originalFile.size.toString());
            }
            
            this.xhr.send(formData);
            this.setVisibility(this.stopTranscribeBtn, true);

        } catch (error) {
            if (!this.isAborted) {
                console.error('上传失败:', error);
                this.handleTranscriptionError(error);
            }
        }
    }

    cleanupPreviousRequest() {
        if (this.xhr) {
            this.xhr.abort();
            this.xhr = null;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isAborted = false;
    }

    handleAbortCleanup() {
        // 清理所有相关资源
        this.segmentsMap.clear();
        this.processedMessageIds.clear();
        this.receivedData = '';
        
        // 更新UI状态
        this.setVisibility(this.stopTranscribeBtn, false);
        this.transcribeFileBtn.disabled = false;
        this.transcribeFileBtn.innerHTML = '<span>开始转文字</span>';
        
        // 显示停止状态
        this.showStatus('⏹️ 处理已停止', 'warning');
    }

    processStreamData(newData) {
        if (this.isAborted || !newData || !this.isTranscribing) return;
        
        const lines = newData.split('\n');
        let currentLine = '';
        
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            
            try {
                const result = JSON.parse(line);
                const messageId = this.generateMessageId(result);
                if (!this.processedMessageIds.has(messageId)) {
                    this.processedMessageIds.add(messageId);
                    this.handleStreamMessage(result);
                }
            } catch (e) {
                if (line.startsWith('{') && !line.endsWith('}')) {
                    currentLine = line;
                } else if (currentLine && !line.endsWith('}')) {
                    currentLine += line;
                } else if (currentLine && line.endsWith('}')) {
                    currentLine += line;
                    try {
                        const result = JSON.parse(currentLine);
                        const messageId = this.generateMessageId(result);
                        if (!this.processedMessageIds.has(messageId)) {
                            this.processedMessageIds.add(messageId);
                            this.handleStreamMessage(result);
                        }
                        currentLine = '';
                    } catch (err) {
                        console.warn('处理不完整JSON失败:', currentLine, err);
                        currentLine = '';
                    }
                }
            }
        }
    }

    generateMessageId(result) {
        return result.message_id || 
               (result.type === 'segment_result' ? `seg-${result.segment_index}-${result.sub_segment_index || 0}` : null) ||
               `${result.type}-${Date.now()}`;
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
        
        if (error.message.includes('中止') || error.message.includes('abort')) {
            this.showStatus('⏹️ 处理已停止', 'warning');
        } else {
            this.showStatus(`❌ 处理失败: ${error.message}`, 'error');
            this.fileTranscript.innerHTML = `
                <div class="error-container" style="padding: 25px; background: #fef2f2; border: 1px solid #fecaca; border-radius: var(--rounded-xl);">
                    <h3 style="color: var(--error-color); margin-top: 0; font-size: 1.8rem;">处理失败</h3>
                    <p style="color: var(--error-dark); margin: 15px 0; font-size: 1.1rem; line-height: 1.6;">${error.message}</p>
                    <p style="color: var(--gray-600); font-size: 0.95rem; margin-top: 20px;">
                        建议：尝试<a href="#" style="color: var(--primary-color); text-decoration: underline; font-weight: 600;" onclick="event.preventDefault(); document.getElementById('uploadArea').click()">重新上传</a> 或 <a href="#" style="color: var(--primary-color); text-decoration: underline; font-weight: 600;" onclick="event.preventDefault(); location.reload()">刷新页面</a>
                    </p>
                </div>
            `;
            this.fileTranscript.classList.remove('processing');
        }
        
        this.finalizeTranscription(false);
    }

    finalizeTranscription(isSuccess = true) {
        if (!this.isTranscribing) return;
        
        this.isTranscribing = false;
        this.isAborted = true;
        
        // 确保进度条到100%
        this.updateProgress(100, isSuccess ? '处理完成' : '处理已停止');
        
        // 重置按钮状态
        this.transcribeFileBtn.disabled = false;
        this.transcribeFileBtn.innerHTML = '<span>开始转文字</span>';
        this.setVisibility(this.uploadLoading, false);
        this.setVisibility(this.stopTranscribeBtn, false);
        
        // 显示优化提示
        if (this.isCompressed && isSuccess) {
            this.showStatus(`💡 提示: 音频已优化 (${this.formatFileSize(this.originalFile.size)} → ${this.formatFileSize(this.currentFile.size)})`, 'info');
        }
        
        // 滚动到结果
        if (this.fileTranscript) {
            this.fileTranscript.scrollIntoView({ behavior: 'smooth' });
        }
    }

    resetUIForNewTranscription() {
        this.clearPreviousResults();
        this.setVisibility(this.progressContainer, true);
        
        this.fileTranscript.innerHTML = `
            <div class="processing-container">
                <div class="processing-icon">🎙️</div>
                <div class="processing-title">正在处理音频文件</div>
                <div class="processing-subtitle">语音识别进行中，请稍候...</div>
                <div class="upload-speed" id="uploadSpeedInfo">准备开始上传...</div>
            </div>
        `;
        this.fileTranscript.classList.add('processing');
        this.setVisibility(this.stopTranscribeBtn, true);
        this.setVisibility(this.summaryContainer, true);
    }

    updateProgress(percent, message = '') {
        const displayPercent = Math.min(100, percent);
        
        if (this.progressFill) {
            this.progressFill.style.width = `${displayPercent}%`;
            
            if (displayPercent <= 50) {
                this.progressFill.style.background = 'linear-gradient(90deg, var(--primary-color) 0%, var(--primary-dark) 100%)';
            } else if (displayPercent < 100) {
                this.progressFill.style.background = 'linear-gradient(90deg, var(--success-color) 0%, var(--success-dark) 100%)';
            } else {
                this.progressFill.style.background = 'linear-gradient(90deg, var(--success-dark) 0%, #047857 100%)';
            }
        }
        
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
            itemDiv.className = 'summary-card';
            itemDiv.innerHTML = `
                <div class="summary-label">${item.label}</div>
                <div class="summary-value">${item.value}</div>
            `;
            summaryContent.appendChild(itemDiv);
        });

        this.setVisibility(this.summaryContainer, true);
    }

    appendToCombinedTranscript(text, segmentInfo = null) {
        if (!text?.trim() || this.isAborted) return;
        
        const combinedContent = this.$('combinedContent');
        if (!combinedContent) return;

        let duration = 0;
        let startTime = 0;
        let endTime = 0;
        
        if (segmentInfo) {
            if (segmentInfo.start_time !== undefined && segmentInfo.end_time !== undefined) {
                duration = (segmentInfo.end_time - segmentInfo.start_time).toFixed(2);
                startTime = segmentInfo.start_time.toFixed(2);
                endTime = segmentInfo.end_time.toFixed(2);
            }
        }

        let segmentHtml = '';
        
        if (segmentInfo && segmentInfo.is_long_segment) {
            segmentHtml = `
                <div class="long-segment-line">
                    <div class="line-header">
                        <span class="long-segment-index">长 #${segmentInfo.segment_index}</span>
                        <span class="long-audio-position">[${startTime}-${endTime}s]</span>
                    </div>
                    <div class="long-segment-content">${text}</div>
                </div>
            `;
        } 
        else if (segmentInfo) {
            segmentHtml = `
                <div class="transcript-line">
                    <div class="line-header">
                        <span class="segment-index">#${segmentInfo.segment_index}</span>
                        <span class="audio-position">[${startTime}-${endTime}s]</span>
                    </div>
                    <div class="segment-content">${text}</div>
                </div>
            `;
        } 
        else {
            segmentHtml = `<div style="padding: 8px 12px; margin: 4px 0; background: var(--gray-100); border-radius: var(--rounded-md);">${text}</div>`;
        }

        combinedContent.insertAdjacentHTML('beforeend', segmentHtml);
        combinedContent.scrollTop = combinedContent.scrollHeight;
        this.setVisibility(this.combinedTranscript, true);
    }

    stopTranscription() {
        if (!this.isTranscribing || this.isAborted) {
            console.log('停止按钮被点击，但当前没有活动的转录任务');
            return;
        }

        console.log('停止按钮被点击，开始中止转录...');
        
        this.isAborted = true;
        
        if (this.abortController) {
            console.log('调用abortController.abort()');
            this.abortController.abort();
            // 不重置abortController，让onabort事件处理
        }
        
        if (this.xhr) {
            console.log('调用xhr.abort()');
            this.xhr.abort();
            // this.xhr = null; // 不要立即重置，让onabort事件处理
        }
        
        this.showStatus('⏹️ 正在停止处理...', 'warning');
        this.setVisibility(this.stopTranscribeBtn, false);
        this.transcribeFileBtn.disabled = true;
    }

    handleInitialization(result) {
        if (this.isAborted) return;
        
        this.fileNameEl.textContent = result.filename;
        this.fileSizeEl.textContent = this.formatFileSize(result.file_size);
        this.updateProgress(5, `准备处理 ${result.total_segments} 个语音段...`);
        this.showStatus(`初始化完成: ${result.filename} (${this.formatFileSize(result.file_size)})`, 'info');
    }

    handleSegmentsSummary(result) {
        if (this.isAborted) return;
        
        this.showStatus(`🎯 检测到 ${result.total_segments} 个语音段，开始转录...`, 'info');
        this.updateProgress(10, `开始处理 ${result.total_segments} 个段`);
    }

    handleSegmentResult(result) {
        if (this.isAborted) return;
        
        const progressPercent = Math.min(99, 50 + (result.progress * 0.49));
        this.updateProgress(progressPercent, `处理中: 段 #${result.segment_index}/${result.total_segments}`);
        
        if (result.text && result.text.trim()) {
            this.showStatus(
                `✅ 段 #${result.segment_index}: ${result.text?.slice(0, 30)}${(result.text?.length > 30) ? '...' : ''}`,
                'success'
            );
        }

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
            
            const existingSegment = longSegmentData.segments.find(s => s.sub_segment_index === result.sub_segment_index);
            if (!existingSegment) {
                longSegmentData.segments.push({
                    sub_segment_index: result.sub_segment_index,
                    text: result.text || '',
                    start_time: result.start_time,
                    end_time: result.end_time
                });
                
                if (result.end_time > longSegmentData.end_time) {
                    longSegmentData.end_time = result.end_time;
                }
            }
            
            if (longSegmentData.segments.length >= longSegmentData.totalSubSegments) {
                longSegmentData.segments.sort((a, b) => a.sub_segment_index - b.sub_segment_index);
                const combinedText = longSegmentData.segments.map(s => s.text.trim()).filter(t => t).join(' ').trim();
                
                if (combinedText) {
                    this.appendToCombinedTranscript(combinedText, {
                        segment_index: result.original_index,
                        start_time: longSegmentData.start_time,
                        end_time: longSegmentData.end_time,
                        is_long_segment: true
                    });
                }
                
                this.segmentsMap.delete(key);
            }
        } else {
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
            <div class="completion-container">
                <div class="completion-icon">🎉</div>
                <h2 class="completion-title">转录完成</h2>
                <p class="completion-text">
                    全部 ${result.total_segments} 个语音段已成功转录！
                    <br>
                    请点击下方按钮查看完整转录内容
                </p>
                <button class="view-btn" onclick="document.getElementById('combinedTranscript').scrollIntoView({behavior: 'smooth'})">
                    📋 查看完整转录
                </button>
            </div>
        `;
        this.fileTranscript.classList.remove('processing');
        
        this.showStatus(`🎉 转录完成！${(result.successful_segments || result.total_segments)}/${result.total_segments} 段成功`, 'success');
        
        setTimeout(() => {
            if (!this.isAborted) {
                this.updateProgress(100, '处理完成');
                this.finalizeTranscription(true);
            }
        }, 500);
    }

    $(id) {
        return document.getElementById(id);
    }

    // 快捷属性访问器
    get uploadArea() { return this.elements.uploadArea; }
    get uploadLoading() { return this.elements.uploadLoading; }
    get fileInfo() { return this.elements.fileInfo; }
    get fileNameEl() { return this.elements.fileName; }
    get fileSizeEl() { return this.elements.fileSize; }
    get transcribeFileBtn() { return this.elements.transcribeFileBtn; }
    get progressContainer() { return this.elements.progressContainer; }
    get progressFill() { return this.elements.progressFill; }
    get fileTranscript() { return this.elements.fileTranscript; }
    get statusMessage() { return this.elements.statusMessage; }
    get stopTranscribeBtn() { return this.elements.stopTranscribeBtn; }
    get summaryContainer() { return this.elements.summaryContainer; }
    get combinedTranscript() { return this.elements.combinedTranscript; }
}