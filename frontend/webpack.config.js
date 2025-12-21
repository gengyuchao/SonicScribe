const fs = require('fs'); // 添加这一行
const path = require('path');
const webpack = require('webpack');
const dotenv = require('dotenv');


// 添加 HTTPS 证书配置
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const SSL_CERT = process.env.SSL_CERT || path.resolve(__dirname, './cert.pem');
const SSL_KEY = process.env.SSL_KEY || path.resolve(__dirname, './key.pem');

const httpsOptions = USE_HTTPS ? {
  key: fs.readFileSync(SSL_KEY),
  cert: fs.readFileSync(SSL_CERT),
  passphrase: process.env.SSL_PASSPHRASE || ''
} : undefined;

// 加载环境变量
const env = dotenv.config({ path: path.resolve(__dirname, '.env') }).parsed || {};

// 获取配置
const API_BASE_URL = env.VUE_APP_API_BASE_URL || 'http://localhost:8000';
const WS_BASE_URL = env.VUE_APP_WS_BASE_URL || 'ws://localhost:8000';
const WS_PATH = env.VUE_APP_WS_PATH || '/ws/audio';
const FRONTEND_PORT = parseInt(env.PORT || '3000');
const HOST = env.HOST || '0.0.0.0';

console.log('🔧 Webpack 配置:');
console.log(`   API Base URL: ${API_BASE_URL}`);
console.log(`   WS Base URL: ${WS_BASE_URL}`);
console.log(`   WS Path: ${WS_PATH}`);
console.log(`   Frontend Port: ${FRONTEND_PORT}`);
console.log(`   Host: ${HOST}`);

// 解析后端主机和端口
const backendUrl = new URL(API_BASE_URL);
const backendHost = backendUrl.hostname;
const backendPort = backendUrl.port || (backendUrl.protocol === 'https:' ? '443' : '80');

module.exports = {
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
    clean: true,
    publicPath: '/',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  devServer: {
    static: {
      directory: path.join(__dirname, 'public'),
    },
    historyApiFallback: true,
    proxy: [
      {
        context: ['/transcribe', '/health', '/vad/config', '/debug', '/ws'],
        target: API_BASE_URL,
        changeOrigin: true,
        secure: false,
        logLevel: 'debug',
        pathRewrite: {
          '^/ws': '/ws' // 保持WebSocket路径不变
        },
        onProxyReq: (proxyReq, req) => {
          console.log(`🔍 代理请求: ${req.method} ${req.url} -> ${API_BASE_URL}${req.url}`);
        },
        onProxyRes: (proxyRes, req) => {
          console.log(`✅ 代理响应: ${req.url} - 状态码: ${proxyRes.statusCode}`);
        }
      }
    ],
    compress: true,
    server: {
      type: 'https',
      options: {
      key: fs.readFileSync(path.resolve(__dirname, env.SSL_KEY)),
      cert: fs.readFileSync(path.resolve(__dirname, env.SSL_CERT)),
      }
    },
    port: FRONTEND_PORT,
    hot: true,
    open: true,
    client: {
      overlay: {
        errors: true,
        warnings: false,
      },
      webSocketURL: {
        hostname: HOST,
        port: FRONTEND_PORT,
        pathname: '/ws',
        protocol: USE_HTTPS ? 'wss' : 'ws' // 使用 WSS 协议
      },
    },
    allowedHosts: 'all',
    host: HOST,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
    },
    webSocketServer: 'ws',
    setupExitSignals: true,
    onListening: (server) => {
      const address = server.server.address();
      console.log(`🚀 前端开发服务器运行在: http://${HOST}:${FRONTEND_PORT}`);
      console.log(`🌐 后端API地址: ${API_BASE_URL}`);
      console.log(`🔌 WebSocket地址: ${WS_BASE_URL}${WS_PATH}`);
      
      // 显示代理配置
      console.log('\n🔄 代理配置:');
      console.log(`   本地请求 /transcribe -> ${API_BASE_URL}/transcribe`);
      console.log(`   本地请求 /ws/audio -> ${WS_BASE_URL}/ws/audio`);
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser',
    }),
    new webpack.DefinePlugin({
      'process.env': JSON.stringify({
        VUE_APP_API_BASE_URL: API_BASE_URL,
        VUE_APP_WS_BASE_URL: WS_BASE_URL,
        VUE_APP_WS_PATH: WS_PATH,
        NODE_ENV: process.env.NODE_ENV || 'development'
      })
    }),
    // 添加运行时检查插件
    {
      apply: (compiler) => {
        compiler.hooks.afterEmit.tap('RuntimeCheckPlugin', () => {
          console.log('\n✅ 构建完成！请检查:');
          console.log(`   1. 后端服务是否运行: ${API_BASE_URL}/health`);
          console.log(`   2. WebSocket 地址是否正确: ${WS_BASE_URL}${WS_PATH}`);
          console.log(`   3. 浏览器控制台是否有 CORS 错误`);
        });
      }
    }
  ],
  resolve: {
    fallback: {
      "path": require.resolve("path-browserify"),
      "fs": false,
      "os": require.resolve("os-browserify/browser"),
      "crypto": require.resolve("crypto-browserify"),
      "stream": require.resolve("stream-browserify"),
      "buffer": require.resolve("buffer/"),
      "util": require.resolve("util/"),
      "events": require.resolve("events/"),
      "vm": require.resolve("vm-browserify"),
    },
    extensions: ['.js', '.jsx', '.json'],
    alias: {
      process: "process/browser",
    },
  },
  optimization: {
    moduleIds: 'deterministic',
  },
};