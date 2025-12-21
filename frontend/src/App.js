import { RealTimeChat } from './components/RealTimeChat.js';
import { FileAnalyzer } from './components/FileAnalyzer.js';

export class App {
    constructor() {
        this.realTimeChat = null;
        this.fileAnalyzer = null;
        
        this.initTabs();
        this.initComponents();
    }
    
    initTabs() {
        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                
                // 更新选项卡状态
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                // 显示对应内容
                tabContents.forEach(content => {
                    content.classList.remove('active');
                    if (content.id === `${tabName}-tab`) {
                        content.classList.add('active');
                    }
                });
            });
        });
    }
    
    initComponents() {
        // 只在对应标签页激活时初始化组件
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                
                if (tabName === 'realtime' && !this.realTimeChat) {
                    this.realTimeChat = new RealTimeChat();
                } else if (tabName === 'file' && !this.fileAnalyzer) {
                    this.fileAnalyzer = new FileAnalyzer();
                }
            });
        });
        
        // 默认初始化实时对话组件
        this.realTimeChat = new RealTimeChat();
    }
    
    cleanup() {
        if (this.realTimeChat) {
            this.realTimeChat.cleanup();
        }
    }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    
    // 页面关闭时清理资源
    window.addEventListener('beforeunload', () => {
        app.cleanup();
    });
});
