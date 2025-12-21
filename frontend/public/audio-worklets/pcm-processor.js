class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate = 16000;
    this.targetChunkDurationMs = 64; // 64ms
    this.targetChunkSize = Math.round(this.sampleRate * this.targetChunkDurationMs / 1000); // 1024 samples
    this.buffer = new Float32Array(this.targetChunkSize);
    this.bufferIndex = 0;
    
    console.log(`PCMProcessor 初始化: targetChunkSize=${this.targetChunkSize} samples`);
    
    this.port.onmessage = (event) => {
      if (event.data.type === 'config') {
        this.sampleRate = event.data.sampleRate || 16000;
        this.targetChunkDurationMs = event.data.chunkDurationMs || 64;
        this.targetChunkSize = Math.round(this.sampleRate * this.targetChunkDurationMs / 1000);
        this.buffer = new Float32Array(this.targetChunkSize);
        this.bufferIndex = 0;
        console.log(`PCMProcessor 配置更新: sampleRate=${this.sampleRate}, targetChunkSize=${this.targetChunkSize} samples`);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }
    
    const channelData = input[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }
    
    // 处理所有输入样本
    for (let i = 0; i < channelData.length; i++) {
      if (this.bufferIndex < this.targetChunkSize) {
        this.buffer[this.bufferIndex] = channelData[i];
        this.bufferIndex++;
      }
      
      // 如果 buffer 满了，发送数据
      if (this.bufferIndex >= this.targetChunkSize) {
        this.sendPCMData();
        this.bufferIndex = 0;
      }
    }
    
    return true;
  }
  
  sendPCMData() {
    if (this.bufferIndex === 0 || this.bufferIndex < this.targetChunkSize * 0.8) {
      // 如果 buffer 不够满，不发送
      return;
    }
    
    const samplesToSend = this.bufferIndex; // 使用实际填满的样本数
    const pcmData = new Int16Array(samplesToSend);
    
    // 转换为 16-bit PCM
    for (let i = 0; i < samplesToSend; i++) {
      const sample = this.buffer[i];
      const clamped = Math.max(-1, Math.min(1, sample));
      pcmData[i] = Math.max(-32768, Math.min(32767, clamped * 32768));
    }
    
    // 关键修复：创建 ArrayBuffer 的拷贝，而不是转移所有权
    const audioBuffer = pcmData.buffer.slice(0);
    
    // 调试信息
    // console.log(`🔊 准备发送: ${audioBuffer.byteLength} bytes, ${samplesToSend} samples`);
    
    // 发送数据
    this.port.postMessage(audioBuffer);
    
    console.log(`✅ 成功发送 PCM 数据: ${audioBuffer.byteLength} bytes, ${samplesToSend} samples`);
  }
}

registerProcessor('pcm-processor', PCMProcessor);